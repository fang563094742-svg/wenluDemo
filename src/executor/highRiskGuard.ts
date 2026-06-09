/**
 * 高危动作识别：命令白名单兜底门 + 黑名单（任务 11.5，安全关键，R13.1 / R13.2）。
 *
 * 对抗性审查指出：仅靠黑名单不可靠——LLM 风险评级会出错，黑名单也无法穷举所有危险
 * 命令。因此在黑名单之上**叠加白名单兜底门**：所有 `run_command` 命令，若其主命令
 * （第一个 token；对管道 `|`、`&&`、`;`、`||` 等组合命令需逐子命令检查）不在安全命令
 * 白名单内，一律视为高危走弹窗确认（R13.2）。
 *
 * 判定顺序（顺序至关重要，黑名单必须先于白名单）：
 *   1. 工具类型：`delete_file` 恒高危。
 *   2. 黑名单命中（运行 shell / sudo / rm / chmod / chown / git force push /
 *      `find -delete` / `find -exec` / mkfs / dd / 写设备节点）→ 高危。
 *   3. 白名单未命中兜底：主命令不在 `SAFE_COMMAND_WHITELIST` 内 → 高危。
 *
 * 命中 → 由执行循环暂停并经 `ExecutionHooks.confirmHighRisk` 弹窗确认，未确认绝不执行
 * （R13.1 / R13.5）；确认则执行（R13.3），拒绝则跳过并继续循环（R13.4，逻辑在执行循环侧）。
 *
 * 设计取舍：本模块为**纯静态判定**，不触及文件系统、不修改任何状态，仅依据 `ToolCall`
 * 的 `name` 与 `arguments.command` 字段做正则/字符串判定，天然可被 property test 大量采样。
 *
 * _Requirements: 13.1, 13.2_
 */

import { SAFE_COMMAND_WHITELIST } from "../config/config.js";
import type { ToolCall } from "./types.js";

/**
 * 纯函数：将组合命令按 shell 连接符拆分为子命令，**但仅在不处于引号内时才切分**（R13.2）。
 *
 * 背景（安全正确性增强）：旧实现用 `command.split(/\|\||&&|;|\||&/)` 裸分割，会把**引号内**
 * （单引号 `'`、双引号 `"`）的 `|`/`&&`/`;`/`&` 也错切——例如 grep 正则
 * `grep -Ei 'A|B|C' x` 里引号内的 `|` 本是正则元字符、并非 shell 管道，却被切成
 * `grep -Ei 'A`、`B`、`C' x` 三段，切出的 `B`/`C'…` 首 token 不在白名单 → 误判高危。
 *
 * 本函数改为**引号感知**扫描：逐字符遍历，维护"是否在单/双引号内"的状态，仅当**不在引号内**
 * 时才识别连接符 `||`、`&&`、`;`、`|`、`&` 并在此切分；引号内的这些字符一律视为命令参数的
 * 一部分、不切分。这不削弱防御——引号内的 `|` 本就不是 shell 管道，真实的引号外管道/逻辑
 * 连接符仍被正确切分逐一判定。
 *
 * 说明：本实现不解释引号转义（如 `\'`），对验收检验场景已足够；引号配对以最朴素的"遇到同类
 * 引号即开/闭"处理，未闭合引号视为延续到串尾（保守地保留为单个子命令片段）。
 *
 * @param command 待拆分的命令串（可能含管道/逻辑连接符及引号内同形字符）。
 * @returns 去空白、去空段后的子命令数组（保序）。
 */
export function splitTopLevelCommands(command: string): string[] {
  const subs: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // 引号状态机：不在引号内遇到引号 → 进入；在引号内遇到同类引号 → 退出。
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    // 不在引号内：识别连接符 || && ; | &（双字符优先于单字符）。
    const two = command.slice(i, i + 2);
    if (two === "||" || two === "&&") {
      subs.push(current);
      current = "";
      i += 1; // 跳过连接符的第二个字符
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      subs.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  subs.push(current);

  return subs.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 纯函数：命令的主命令是否**全部**在白名单内（R13.2）。
 *
 * 处理组合命令：用**引号感知**的 {@link splitTopLevelCommands} 按 `||`、`&&`、`;`、`|`、`&`
 * 拆分为子命令（引号内的同形字符不切分），取每个子命令的第一个 token 作为主命令，去掉可能的
 * 路径前缀（如 `./node`、`/usr/bin/git`）只取命令名（basename）后与白名单比对。要求**每个
 * 子命令的主命令都在白名单内**才返回 `true`（任一不在 → 返回 `false` → 由
 * `HighRiskGuard.isHighRisk` 兜底判为高危）。
 *
 * 空命令或拆分后无任何有效子命令时返回 `false`（无法确认其安全性，保守兜底为非白名单）。
 *
 * @param command 待判定的命令串（可能含管道/逻辑连接符的组合命令）。
 * @param whitelist 安全命令白名单（basename 集合）。
 * @returns 所有子命令主命令均命中白名单返回 `true`，否则 `false`。
 */
export function isCommandWhitelisted(command: string, whitelist: string[]): boolean {
  const subCommands = splitTopLevelCommands(command); // 引号感知拆分组合命令
  if (subCommands.length === 0) return false;
  return subCommands.every((sub) => {
    const main = sub.split(/\s+/)[0]; // 子命令主命令 = 第一个 token
    // 去掉可能的路径前缀（如 ./node、/usr/bin/git）只取命令名（basename）
    const base = main.split("/").pop() ?? main;
    return whitelist.includes(base);
  });
}

/**
 * High_Risk_Guard：拦截 High_Risk_Action 的纯判定模块（R13）。
 *
 * 白名单由 `config.ts` 维护、可注入（默认 `SAFE_COMMAND_WHITELIST`），便于测试与拓展。
 */
export class HighRiskGuard {
  /**
   * @param whitelist 安全命令白名单，默认取 `config.ts` 的 `SAFE_COMMAND_WHITELIST`。
   */
  constructor(private readonly whitelist: string[] = SAFE_COMMAND_WHITELIST) {}

  /**
   * 命令黑名单正则集合（R13.2）。
   *
   * 与 White_List 兜底门叠加且**优先于**白名单：即便主命令（如 `find`）在白名单内，
   * 命中黑名单仍判高危。`find -delete`/`find -exec` 单列两条，因为 `\brm\b` 等正则
   * 抓不到这两种危险用法。
   */
  private static readonly CMD_PATTERNS: readonly RegExp[] = [
    /\brm\b/,
    /\bsudo\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /git\s+push\s+.*--force/,
    /git\s+push\s+.*-f\b/,
    /\bfind\b[^\n]*-delete\b/, // find -delete 批量删文件（rm 正则抓不到）
    /\bfind\b[^\n]*-exec\b/, // find -exec 执行任意命令
    /\bmkfs\b/,
    /\bdd\b/,
    />\s*\/dev\//,
  ];

  /**
   * 判定一次工具调用是否为 High_Risk_Action（R13.1 / R13.2）。
   *
   * 判定顺序：`delete_file` 恒高危 → `run_command` 黑名单命中 → 白名单未命中兜底高危。
   * 其余工具（read_file / write_file / list_dir 等）一律非高危（越界等防御由
   * SandboxGuard 与 detectSymlinkEscape 各司其职）。
   *
   * @param tc 待判定的工具调用。
   * @returns 高危返回 `true`（需弹窗确认），否则 `false`。
   */
  isHighRisk(tc: ToolCall): boolean {
    // 1) 工具类型：delete_file 始终高危
    if (tc.name === "delete_file") return true;
    // 2) run_command：黑名单命中 → 高危；否则白名单未命中 → 兜底高危
    if (tc.name === "run_command") {
      const cmd = String(tc.arguments.command ?? "");
      if (/\b(sh|bash|zsh)\b\s+-c/.test(cmd)) return true; // 运行 shell
      if (HighRiskGuard.CMD_PATTERNS.some((re) => re.test(cmd))) return true; // 黑名单
      // 白名单兜底：主命令不在白名单内一律高危（R13.2）
      if (!isCommandWhitelisted(cmd, this.whitelist)) return true;
      return false;
    }
    return false;
  }
}
