/**
 * 技能反哺（Skill Reflux）· 平台渲染提示模板库（renderHintTemplates.ts）
 * ------------------------------------------------------------------
 * 定位：Req 15.13——维护一个与平台绑定的「渲染提示模板库」（`render_hint_template` 表，
 * 由任务 2 的 006 增量迁移建表）。当 Dispatcher 分发一个「仅有 Platform_Neutral_Intent、
 * 该平台尚无已验证 Platform_Variant」的可执行技能时（Req 15.7/15.10/15.13），会经
 * `createPgRenderHintProvider()`（任务 12，dispatcher.ts）读本表取目标平台模板附上，引导
 * agent 按该平台命令语法重渲染，而非无引导地自行猜测。
 *
 * 模板内容提炼自 `riverMain.ts` 的 `buildHostEnvHint()`（约 1422 行）各平台命令语法规则：
 *  - win：execute_command 走 Windows PowerShell，禁用 macOS 专属命令；
 *  - mac：可用 osascript/pbpaste/open 等 macOS 命令、sh 语法；
 *  - linux：POSIX sh / 常见 GNU 工具语法。
 * 保持与 `buildHostEnvHint()` 一致，确保跨平台渲染提示的一致性。
 *
 * 提供：
 *  - `seedRenderHintTemplates()`：把三平台模板幂等写入（`ON CONFLICT (os) DO UPDATE`），
 *    可在启动引导或迁移后安全重复调用。
 *  - `upsertRenderHintTemplate(os, template)`：随连接器支持的平台扩展而同步更新的单条入口
 *    （Req 15.13「THE 模板库 SHALL 随连接器支持的平台扩展而同步更新」）。
 *  - `RENDER_HINT_TEMPLATES`：内置三平台模板常量（也供测试/Dispatcher 兜底引用）。
 *
 * DB 写入统一经 `src/db/pool.ts` 的 `query`（`render_hint_template` 无 RLS，用系统级 query 即可）；
 * query 以依赖注入方式可替换，便于单测注入桩（不连真实 PG）。
 *
 * _Requirements: 15.13_
 */

import { query as defaultQuery } from "../db/pool.js";
import type { VariantOS } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// query 注入抽象（与 src/db/pool.ts 的 query 结构兼容，便于单测注入桩）
// ─────────────────────────────────────────────────────────────────

/** 最小化 query 抽象（结构兼容 `src/db/pool.ts` 的 `query`）。 */
export type RenderHintQueryFn = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

// ─────────────────────────────────────────────────────────────────
// 内置三平台模板（提炼自 riverMain.buildHostEnvHint 的命令语法规则）
// ─────────────────────────────────────────────────────────────────

/** Windows：PowerShell 语法，禁用 macOS 专属命令（对齐 buildHostEnvHint win32 分支）。 */
const WIN_TEMPLATE = [
  "== 目标平台：Windows（经本地连接器执行） ==",
  "重渲染该命令时必须用 Windows PowerShell 语法，禁止使用 macOS 专属命令：",
  "- 看进程/在用应用：Get-Process（如 `Get-Process | Where-Object { $_.MainWindowTitle -ne '' }`）",
  "- 剪贴板：Get-Clipboard；通知：用 PowerShell 的 BurntToast 或弹窗，别用 osascript",
  "- 列目录/找文件：Get-ChildItem（dir）；看内容：Get-Content（type）；打开：Start-Process",
  "- 写文件优先用 write_file 工具并传真实绝对路径；裸命令写文件用 Set-Content。",
  "绝对不要用 osascript / pbpaste / open / ls -lt / find -mmin 这些 macOS 命令——它们在 Windows 上必然失败。",
  "路径用 Windows 绝对路径（含盘符），别用 ~ 或猜的路径；桌面可能被重定向到非 C 盘，务必用真实绝对路径。",
].join("\n");

/** macOS：osascript/sh 等 macOS 命令（对齐 buildHostEnvHint darwin 分支）。 */
const MAC_TEMPLATE = [
  "== 目标平台：macOS（经本地连接器执行） ==",
  "重渲染该命令时用 macOS 命令与 sh 语法：",
  "- 自动化/通知/控制应用：osascript（AppleScript）",
  "- 剪贴板：pbpaste / pbcopy；打开文件或应用：open",
  "- 列目录/找文件：ls -lt、find -mmin；看内容：cat；进程：ps / pgrep",
  "- 写文件优先用 write_file 工具并传真实绝对路径；裸命令可用 sh 重定向。",
  "不要用 Windows PowerShell 专属命令（Get-Process / Get-Clipboard / Set-Content 等）——它们在 macOS 上不可用。",
  "路径用 POSIX 绝对路径，别用 ~ 或猜的路径；要在桌面生成文件就写到真实的桌面绝对路径。",
].join("\n");

/** Linux：POSIX sh / 常见 GNU 工具语法（buildHostEnvHint 暂未单列，按 POSIX 通则给出）。 */
const LINUX_TEMPLATE = [
  "== 目标平台：Linux（经本地连接器执行） ==",
  "重渲染该命令时用 POSIX sh 与常见 GNU 工具语法：",
  "- 列目录/找文件：ls -lt、find -mmin；看内容：cat；进程：ps / pgrep",
  "- 剪贴板：xclip / xsel（若有图形环境）；打开文件：xdg-open",
  "- 写文件优先用 write_file 工具并传真实绝对路径；裸命令可用 sh 重定向。",
  "不要用 macOS 专属命令（osascript / pbpaste / open）或 Windows PowerShell 命令——它们在 Linux 上不可用。",
  "路径用 POSIX 绝对路径，别用 ~ 或猜的路径。",
].join("\n");

/** 内置三平台渲染提示模板（os → template）。 */
export const RENDER_HINT_TEMPLATES: Readonly<Record<VariantOS, string>> = Object.freeze({
  win: WIN_TEMPLATE,
  mac: MAC_TEMPLATE,
  linux: LINUX_TEMPLATE,
});

// ─────────────────────────────────────────────────────────────────
// 写入入口（幂等 seed + 随平台扩展更新）
// ─────────────────────────────────────────────────────────────────

/**
 * 幂等写入单条平台模板（`ON CONFLICT (os) DO UPDATE`，刷新 template 与 updated_at）。
 * 既是随连接器支持的平台扩展而同步更新的入口（Req 15.13），也是 `seed` 的底层单元。
 *
 * @param os       目标平台（mac/win/linux）。
 * @param template 该平台的渲染提示模板文本。
 * @param queryFn  可注入的 query（默认走 `src/db/pool.ts` 的 `query`，单测可注入桩）。
 */
export async function upsertRenderHintTemplate(
  os: VariantOS,
  template: string,
  queryFn: RenderHintQueryFn = defaultQuery as unknown as RenderHintQueryFn,
): Promise<void> {
  await queryFn(
    `INSERT INTO render_hint_template (os, template, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (os)
     DO UPDATE SET template = EXCLUDED.template, updated_at = now()`,
    [os, template],
  );
}

/**
 * 幂等初始化三平台（mac/win/linux）渲染提示模板。
 * 全程 `ON CONFLICT DO UPDATE`，可在启动引导或迁移后安全重复调用而不产生重复行。
 *
 * @param queryFn 可注入的 query（默认走真实 PG；单测注入桩验证三平台 upsert）。
 */
export async function seedRenderHintTemplates(
  queryFn: RenderHintQueryFn = defaultQuery as unknown as RenderHintQueryFn,
): Promise<void> {
  // 固定 mac/win/linux 顺序逐条 upsert（数量小，顺序写以便桩按调用顺序断言）。
  const platforms: VariantOS[] = ["mac", "win", "linux"];
  for (const os of platforms) {
    await upsertRenderHintTemplate(os, RENDER_HINT_TEMPLATES[os], queryFn);
  }
}
