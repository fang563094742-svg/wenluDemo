/**
 * Delivery_Verifier —— 交付验收（任务 13.3，R15 / R12.5）。
 *
 * 本模块承载交付验收阶段（`verifying` → `delivered` → `accepted`）的三项职责：
 *
 *  1. {@link runAcceptanceTests} —— 强制运行 Task_Frame 的 Acceptance_Test（R12.5 / R15.1）。
 *     逐条执行 `checkMethod`，支持三类可执行检验：
 *       - **shell 命令查退出码**（默认）：退出码 0 视为 passed；
 *       - **文件内容断言**（`file:` 前缀）：在 sandbox 内读取目标文件并断言；
 *       - **HTTP 请求查响应码**（`http(s)://` / `GET https://…`）：按期望状态码判定。
 *     执行同受 {@link SandboxGuard} 越界校验与 {@link HighRiskGuard} 高危拦截约束（与执行
 *     循环同源、不绕过任何安全门），并对每条 `checkMethod` 施加 `ACCEPTANCE_TEST_TIMEOUT_MS`
 *     （默认 10s）超时 —— 超时即**视为该测试 failed**（detail 记 timeout），不挂死整条验收
 *     流程，继续跑后续测试。
 *
 *  2. {@link buildReport} —— 收集证据产出 {@link Delivery_Report}（R15.1 / R15.2）。
 *     从执行 log 派生：对每个被改动的文件给出对应 `fileDiffs` 条目、对每条所跑命令给出对应
 *     `commandOutputs` 条目（证据覆盖所有落地动作，对齐 design Property 20），并据
 *     `acceptanceTestResults` 置 `hasFailures = some(r => !r.passed)`（存在失败时 UI 须显著标红）。
 *
 *  3. {@link DefaultDeliveryVerifier.accept} —— 仅在用户"确认完成"时把会话标记为已验收
 *     （R15.4 / R15.5 / R15.6）。不存在任何自动/超时路径：仅 `delivered` 状态下被显式调用
 *     才置 `accepted = true` 并转 `accepted` 状态。
 *
 * 裁决（`verifying` 是否进入 `delivered`）复用既有纯函数 {@link decideAfterVerify}（任务 13.1），
 * 保持单一来源（design Property 26）。
 *
 * _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 12.5_
 */

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { ACCEPTANCE_TEST_TIMEOUT_MS } from "../config/config.js";
import type { Acceptance_Test, Task_Frame } from "../clarifier/types.js";
import type { BackupHandle } from "../backup/backupManager.js";
import { HighRiskGuard } from "../executor/highRiskGuard.js";
import { SandboxGuard, type WorkingDirectoryLike } from "../executor/sandboxGuard.js";
import { createRunCommandTool } from "../executor/tools/runCommand.js";
import type {
  ExecutionHooks,
  ExecutionResult,
  ToolCall,
  ToolInvocation,
} from "../executor/types.js";
import { SessionState, type Session } from "../orchestrator/session.js";
import { decideAfterVerify, type AcceptanceTestResult } from "./decideAfterVerify.js";

// re-export 验收裁决纯函数与结果类型，便于交付层调用方单点引入。
export { decideAfterVerify };
export type { AcceptanceTestResult };

// ===========================================================================
// 类型契约（design.md「6. 交付验收（R15）」；本模块为 Delivery_Report 权威来源）
// ===========================================================================

/**
 * 交付报告（R15.1 / R15.2）：足以完整证明任务完成的证据集合。
 *
 * 证据派生原则（对齐 design Property 20）：
 *  - `fileDiffs`：对每个被改动的文件给出对应 diff 条目；
 *  - `commandOutputs`：对每条所跑命令给出对应输出条目；
 *  - `acceptanceTestResults`：逐条 passed/failed/detail（必含、不可为空时放行由状态机把关）；
 *  - `hasFailures = acceptanceTestResults.some(r => !r.passed)`，为真时 UI 须显著标红。
 */
export interface Delivery_Report {
  /** 人类可读的交付概述。 */
  summary: string;
  /** 每个被改动文件的差异（git diff 或快照对比）。 */
  fileDiffs: { path: string; diff: string }[];
  /** 每条所跑命令及其输出摘要。 */
  commandOutputs: { command: string; output: string }[];
  /** 逐条验收测试结果（passed/failed/detail）。 */
  acceptanceTestResults: AcceptanceTestResult[];
  /** = acceptanceTestResults.some(r => !r.passed)；为真时报告须显著标红。 */
  hasFailures: boolean;
}

/**
 * Delivery_Verifier 接口契约（design.md「6. 交付验收（R15）」）。
 */
export interface Delivery_Verifier {
  /**
   * 强制运行 Task_Frame 中的 Acceptance_Test（R12.5 / R15.1）。
   * 逐条执行 `checkMethod`，受 sandbox + High_Risk_Guard 约束并施加超时；超时视为该测试 failed。
   * @param hooks 可选执行回调（实时进度推送 / 高危确认）；不传则静默执行、高危检验直接判 failed。
   */
  runAcceptanceTests(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    hooks?: ExecutionHooks,
  ): Promise<AcceptanceTestResult[]>;

  /** 收集证据，产出 Delivery_Report 并告知用户任务完成（R15.1 / R15.2）。 */
  buildReport(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    backup: BackupHandle | undefined,
    execResult: ExecutionResult,
    acceptanceTestResults: AcceptanceTestResult[],
  ): Promise<Delivery_Report>;

  /** 用户点击"确认完成"才标记 accepted（R15.4-6）。 */
  accept(session: Session): void;
}

// ===========================================================================
// checkMethod 分类与执行
// ===========================================================================

/** `checkMethod` 的三类可执行检验形态。 */
export type CheckKind = "http" | "file" | "shell";

/** HTTP 检验解析结果。 */
interface HttpCheck {
  kind: "http";
  method: string;
  url: string;
  /** 期望状态码；缺省时任意 2xx 视为通过。 */
  expectedStatus?: number;
}

/** 文件内容断言解析结果。 */
interface FileCheck {
  kind: "file";
  /** 目标文件路径（相对 sandbox 根或绝对）。 */
  target: string;
  /** 断言种类：存在 / 包含子串 / 匹配正则。 */
  assertion:
    | { mode: "exists" }
    | { mode: "contains"; needle: string }
    | { mode: "matches"; pattern: string };
}

/** shell 命令检验（默认形态，查退出码）。 */
interface ShellCheck {
  kind: "shell";
  command: string;
}

/** 单条检验方式解析后的判别联合。 */
export type ParsedCheck = HttpCheck | FileCheck | ShellCheck;

/** HTTP 形态匹配：可选方法 + http(s) URL。 */
const HTTP_RE = /^(?:(GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+)?(https?:\/\/\S+)/i;

/** 期望状态码标注匹配（如 `=> 200`、`expect 204`、`status 200`、`→ 201`）。 */
const EXPECT_STATUS_RE = /(?:=>|→|\bexpect(?:s|ed)?\b|\bstatus(?:[ _]code)?\b)\s*[:=]?\s*(\d{3})/i;

/** 反引号包裹的命令片段匹配：提取**首段**反引号内的完整内容（`[^`]*` 已跨行匹配，含 heredoc）。 */
const BACKTICK_RE = /`([^`]*)`/;

/**
 * 自然语言包裹解包（纯函数，确定性）：从 `checkMethod` 原始串中提取**首段反引号内**的完整命令。
 *
 * 背景：经 Clarifier 的 sufficient 分支产出的真实 `checkMethod` 常为「自然语言包裹」形态，
 * 真正要执行的命令在反引号 `` ` `` 内，外面包着"运行 …… 并检查退出码为 0。"这类中文散文，
 * 例如 `运行 \`test -f README.md\` 并检查退出码为 0。`。若不解包，整串会被当作 shell 命令、
 * 首 token（"运行"）不在白名单 → 被高危门误拦 → 验收误判 failed。
 *
 * 解包规则：
 *  - 取**第一段**反引号内的完整内容（`[^`]*` 跨行匹配，正确处理多行 heredoc 如
 *    `python - <<'PY' … PY`，以及内含 `&&`/`|` 的命令）；去除外层散文与"并检查退出码为 0"等后缀。
 *  - 提取内容去首尾空白后非空 → 返回该命令串；
 *  - 无反引号、或反引号内为空 → 返回 `null`（调用方退化为对原始整串分类，行为不变）。
 *
 * @param raw 原始 checkMethod 字符串。
 * @returns 首段反引号内的命令串（去空白、非空）；无可解包内容时返回 `null`。
 */
export function unwrapBacktickedCommand(raw: string): string | null {
  const m = BACKTICK_RE.exec(raw ?? "");
  if (!m) return null;
  const inner = m[1].trim();
  return inner.length > 0 ? inner : null;
}

/**
 * 把自由文本 `checkMethod` 分类解析为可执行的检验形态（纯函数）。
 *
 * 分派优先级：**自然语言包裹解包**（提取首段反引号内的命令）→ HTTP（含 http(s):// 或
 * `<METHOD> https://…`）→ 文件断言（`file:` 前缀）→ 其余一律按 shell 命令（查退出码）。
 * 该分派确定、可被独立测试。
 *
 * @param raw 原始 checkMethod 字符串。
 * @returns 解析后的检验形态；空串退化为 shell（空命令，执行时直接判 failed）。
 */
export function classifyCheckMethod(raw: string): ParsedCheck {
  // 0) 自然语言包裹解包：若含反引号包裹的命令，先提取首段反引号内的完整内容作为待分类的实际
  //    命令串（去掉"运行/执行/Run…"散文与"并检查退出码为 0"等后缀）；无反引号则保持原行为。
  const unwrapped = unwrapBacktickedCommand(raw ?? "");
  const text = unwrapped ?? (raw ?? "").trim();

  // 1) HTTP
  const httpMatch = HTTP_RE.exec(text);
  if (httpMatch) {
    const method = (httpMatch[1] ?? "GET").toUpperCase();
    // URL 取捕获组并剥离尾随的状态码标注片段（如 " => 200"）。
    let url = httpMatch[2];
    const statusMatch = EXPECT_STATUS_RE.exec(text);
    const expectedStatus = statusMatch ? Number(statusMatch[1]) : undefined;
    // 若 URL 误吞了形如 "=>" 之后的内容，按空白切回首段。
    url = url.split(/\s/)[0];
    return { kind: "http", method, url, expectedStatus };
  }

  // 2) 文件断言：`file:<path>[ contains <text> | matches <regex> | exists]`
  if (/^file:/i.test(text)) {
    const body = text.slice(text.indexOf(":") + 1).trim();
    const containsMatch = /^(.*?)\s+contains\s+(.+)$/is.exec(body);
    if (containsMatch) {
      return {
        kind: "file",
        target: containsMatch[1].trim(),
        assertion: { mode: "contains", needle: stripQuotes(containsMatch[2].trim()) },
      };
    }
    const matchesMatch = /^(.*?)\s+matches\s+(.+)$/is.exec(body);
    if (matchesMatch) {
      return {
        kind: "file",
        target: matchesMatch[1].trim(),
        assertion: { mode: "matches", pattern: stripRegexDelimiters(matchesMatch[2].trim()) },
      };
    }
    const existsMatch = /^(.*?)\s+exists\s*$/is.exec(body);
    if (existsMatch) {
      return { kind: "file", target: existsMatch[1].trim(), assertion: { mode: "exists" } };
    }
    // 仅给出路径 → 退化为"存在性"断言。
    return { kind: "file", target: body, assertion: { mode: "exists" } };
  }

  // 3) 兜底：shell 命令
  return { kind: "shell", command: text };
}

/** 去掉首尾成对引号（单/双引号）。 */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 去掉 `/regex/flags` 形态的分隔符，返回纯正则体（保留 flags 会另行解析）。 */
function stripRegexDelimiters(s: string): string {
  const m = /^\/(.*)\/[a-z]*$/is.exec(s);
  return m ? m[1] : s;
}

/** 执行 `executeCheckMethod` 的可注入选项。 */
export interface ExecuteCheckOptions {
  /** 单条 checkMethod 超时（毫秒），默认 `ACCEPTANCE_TEST_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /** 高危识别器，默认 `new HighRiskGuard()`。 */
  highRiskGuard?: HighRiskGuard;
  /** 可选执行回调（高危确认 / 实时进度）。 */
  hooks?: ExecutionHooks;
}

/** 单条检验的执行结果（passed + 细节）。 */
export interface CheckOutcome {
  passed: boolean;
  detail: string;
}

/**
 * 执行单条 `checkMethod`（shell 退出码 / 文件内容断言 / HTTP 响应码），R15.1。
 *
 * 安全约束：
 *  - shell 检验经 `HighRiskGuard` 拦截（黑名单 + 白名单兜底）。命中高危时——若提供 hooks
 *    则经 `confirmHighRisk` 弹窗，拒绝即判 failed；未提供 hooks 则**不静默执行危险命令**、
 *    直接判 failed（detail 注明被高危门拦截）。执行经 `run_command` 工具，其内部已做
 *    sandbox cwd 自校验、符号链接逃逸检测与超时终止子进程。
 *  - file 检验在 sandbox 内解析目标路径并经 `SandboxGuard.isInside` 越界校验，越界即 failed。
 *  - 所有形态均施加超时；超时视为该条 failed（detail 记 timeout），不挂死整条验收流程。
 *
 * @returns `{ passed, detail }`；任何异常/超时都被收敛为 `passed:false`，绝不抛出。
 */
export async function executeCheckMethod(
  checkMethod: string,
  sandbox: SandboxGuard,
  options: ExecuteCheckOptions = {},
): Promise<CheckOutcome> {
  const timeoutMs = options.timeoutMs ?? ACCEPTANCE_TEST_TIMEOUT_MS;
  const guard = options.highRiskGuard ?? new HighRiskGuard();
  const parsed = classifyCheckMethod(checkMethod);

  try {
    switch (parsed.kind) {
      case "http":
        return await runHttpCheck(parsed, timeoutMs);
      case "file":
        return await withTimeout(runFileCheck(parsed, sandbox), timeoutMs);
      case "shell":
        return await runShellCheck(parsed, sandbox, guard, timeoutMs, options.hooks);
      default: {
        const _never: never = parsed;
        return { passed: false, detail: `未知检验形态: ${JSON.stringify(_never)}` };
      }
    }
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { passed: false, detail: `验收检验超时（>${timeoutMs}ms，timeout），视为失败` };
    }
    return { passed: false, detail: `验收检验执行异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 超时错误标记（供 `executeCheckMethod` 把超时收敛为 failed）。 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** 给一个 Promise 套上超时；超时拒绝为 {@link TimeoutError}（不影响底层 Promise，仅用于读类操作）。 */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`操作超时（>${timeoutMs}ms）`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 执行 shell 检验：经高危门 + run_command 工具（含超时/越界/符号链接防御），查退出码。 */
async function runShellCheck(
  parsed: ShellCheck,
  sandbox: SandboxGuard,
  guard: HighRiskGuard,
  timeoutMs: number,
  hooks?: ExecutionHooks,
): Promise<CheckOutcome> {
  const command = parsed.command;
  if (command.length === 0) {
    return { passed: false, detail: "空的 checkMethod 命令，视为失败" };
  }

  const tc: ToolCall = { id: "acceptance-check", name: "run_command", arguments: { command } };

  // 高危门：命中黑名单或白名单兜底未命中 → 高危。
  if (guard.isHighRisk(tc)) {
    if (!hooks) {
      return {
        passed: false,
        detail: `检验命令被高危门拦截（未提供确认通道，拒绝静默执行）: ${command}`,
      };
    }
    hooks.emitProgress({ kind: "high-risk-pending", tool: "acceptance-test", summary: command });
    const decision = await hooks.confirmHighRisk(`验收检验命令属高危动作: ${command}`);
    if (decision === "reject") {
      return { passed: false, detail: `用户拒绝执行高危验收检验命令: ${command}` };
    }
  }

  // 经 run_command 工具执行（cwd = sandbox 根，内部已做越界/符号链接/超时防御）。
  const tool = createRunCommandTool(timeoutMs);
  const result = await tool.invoke(
    { command },
    { workingDirRoot: sandbox.rootRealPath, sandbox },
  );
  return { passed: result.ok, detail: result.error ? `${result.error}\n${result.output}` : result.output };
}

/** 执行文件内容断言：sandbox 内解析路径并越界校验，读取后按断言判定。 */
async function runFileCheck(parsed: FileCheck, sandbox: SandboxGuard): Promise<CheckOutcome> {
  const target = parsed.target;
  if (target.length === 0) {
    return { passed: false, detail: "文件断言缺少目标路径，视为失败" };
  }
  if (!sandbox.isInside(target)) {
    return { passed: false, detail: `文件断言目标越界（不在 Working_Directory 内）: ${target}` };
  }
  const absPath = path.resolve(sandbox.rootRealPath, target);

  if (parsed.assertion.mode === "exists") {
    try {
      await fsp.access(absPath);
      return { passed: true, detail: `文件存在: ${target}` };
    } catch {
      return { passed: false, detail: `文件不存在: ${target}` };
    }
  }

  let content: string;
  try {
    content = await fsp.readFile(absPath, "utf8");
  } catch (err) {
    return { passed: false, detail: `无法读取文件 ${target}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (parsed.assertion.mode === "contains") {
    const ok = content.includes(parsed.assertion.needle);
    return {
      passed: ok,
      detail: ok
        ? `文件 ${target} 含期望内容`
        : `文件 ${target} 不含期望子串: ${parsed.assertion.needle}`,
    };
  }

  // matches
  let re: RegExp;
  try {
    re = new RegExp(parsed.assertion.pattern);
  } catch (err) {
    return { passed: false, detail: `无效的断言正则: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ok = re.test(content);
  return {
    passed: ok,
    detail: ok ? `文件 ${target} 匹配正则` : `文件 ${target} 不匹配正则: ${parsed.assertion.pattern}`,
  };
}

/** 执行 HTTP 检验：发请求并按期望状态码（或任意 2xx）判定，含超时中止。 */
async function runHttpCheck(parsed: HttpCheck, timeoutMs: number): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(parsed.url, { method: parsed.method, signal: controller.signal });
    const status = resp.status;
    const ok =
      parsed.expectedStatus !== undefined
        ? status === parsed.expectedStatus
        : status >= 200 && status < 300;
    return {
      passed: ok,
      detail: ok
        ? `HTTP ${parsed.method} ${parsed.url} → ${status}（符合期望${parsed.expectedStatus !== undefined ? ` ${parsed.expectedStatus}` : " 2xx"}）`
        : `HTTP ${parsed.method} ${parsed.url} → ${status}（期望${parsed.expectedStatus !== undefined ? ` ${parsed.expectedStatus}` : " 2xx"}）`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { passed: false, detail: `HTTP 请求超时（>${timeoutMs}ms，timeout），视为失败: ${parsed.url}` };
    }
    return { passed: false, detail: `HTTP 请求失败: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// 证据收集（buildReport）
// ===========================================================================

/** git diff 子进程的默认超时（防 buildReport 因 git 卡住而挂死）。 */
const DIFF_TIMEOUT_MS = 10_000;

/** 从执行 log 提取所跑命令及其输出（每条所跑命令一个条目；被安全门拦截未执行的不计）。 */
function collectCommandOutputs(
  log: ToolInvocation[],
): { command: string; output: string }[] {
  const out: { command: string; output: string }[] = [];
  for (const inv of log) {
    if (inv.tc.name !== "run_command" || inv.blocked) continue;
    const command = String(inv.tc.arguments.command ?? "");
    out.push({ command, output: inv.result.output ?? "" });
  }
  return out;
}

/** 从执行 log 提取被真实改动的文件路径（write_file / delete_file，已落地且未被拦截，去重）。 */
function collectModifiedPaths(log: ToolInvocation[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const inv of log) {
    if (inv.blocked || !inv.result.ok) continue;
    if (inv.tc.name !== "write_file" && inv.tc.name !== "delete_file") continue;
    const p = inv.tc.arguments.path;
    if (typeof p !== "string" || p.length === 0) continue;
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  return ordered;
}

/** 以超时执行 git 子命令；失败时返回 `null`（执行 `git diff --no-index` 差异退出码 1 视为正常）。 */
function runGit(rootAbsPath: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", rootAbsPath, ...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // `git diff` / `git diff --no-index` 在「有差异」时以退出码 1 结束，但 stdout 即为 diff。
          const out = typeof stdout === "string" ? stdout : "";
          resolve(out.length > 0 ? out : null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * 为单个被改动文件计算 diff 证据（R15.2）。
 *  - git 备份（git-commit / git-stash 且有 gitRef）：`git diff <ref> -- <relPath>`。
 *  - 文件快照备份（file-snapshot 且有 snapshotPath）：`git diff --no-index <快照文件> <当前文件>`。
 *  - 无可用基准或 git 不可用：返回描述性占位，仍保证"每个改动文件都有对应 diff 条目"。
 */
async function computeFileDiff(
  rootAbsPath: string,
  filePath: string,
  backup: BackupHandle | undefined,
  timeoutMs: number,
): Promise<string> {
  const abs = path.resolve(rootAbsPath, filePath);
  const rel = path.relative(rootAbsPath, abs) || path.basename(abs);

  if (backup && (backup.strategy === "git-commit" || backup.strategy === "git-stash") && backup.gitRef) {
    const diff = await runGit(rootAbsPath, ["diff", backup.gitRef, "--", rel], timeoutMs);
    if (diff !== null) return diff.length > 0 ? diff : `（${rel}：相对备份 ${backup.gitRef} 无文本差异）`;
    return `（${rel}：git diff 未能生成差异，可能为二进制文件或 git 不可用）`;
  }

  if (backup && backup.strategy === "file-snapshot" && backup.snapshotPath) {
    const snapshotFile = path.join(backup.snapshotPath, rel);
    const diff = await runGit(
      rootAbsPath,
      ["diff", "--no-index", "--", snapshotFile, abs],
      timeoutMs,
    );
    if (diff !== null && diff.length > 0) return diff;
    return `（${rel}：相对快照 ${snapshotFile} 无文本差异或无法对比）`;
  }

  return `（${rel}：无备份基准，无法生成 diff；该文件在执行中被改动）`;
}

// ===========================================================================
// 默认实现
// ===========================================================================

/** `DefaultDeliveryVerifier` 构造选项（注入便于测试与 config 覆盖）。 */
export interface DeliveryVerifierOptions {
  /** 每条 checkMethod 超时（毫秒），默认 `ACCEPTANCE_TEST_TIMEOUT_MS`。 */
  acceptanceTimeoutMs?: number;
  /** 高危识别器，默认 `new HighRiskGuard()`。 */
  highRiskGuard?: HighRiskGuard;
  /** git diff 子进程超时（毫秒），默认 `DIFF_TIMEOUT_MS`。 */
  diffTimeoutMs?: number;
  /** 注入时钟（返回 ISO8601 字符串），便于测试确定性；默认取当前时刻。 */
  now?: () => string;
}

/**
 * `Delivery_Verifier` 的默认实现：强制验收测试运行 + 证据报告 + 用户验收标记。
 */
export class DefaultDeliveryVerifier implements Delivery_Verifier {
  private readonly acceptanceTimeoutMs: number;
  private readonly highRiskGuard: HighRiskGuard;
  private readonly diffTimeoutMs: number;
  private readonly now: () => string;

  constructor(options: DeliveryVerifierOptions = {}) {
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? ACCEPTANCE_TEST_TIMEOUT_MS;
    this.highRiskGuard = options.highRiskGuard ?? new HighRiskGuard();
    this.diffTimeoutMs = options.diffTimeoutMs ?? DIFF_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 逐条强制运行 Task_Frame 的 Acceptance_Test（R12.5 / R15.1）。
   *
   * 每条 checkMethod 经 sandbox + High_Risk_Guard 约束并施加超时；任一条超时/异常仅令该条
   * failed，绝不挂死整条验收流程（继续跑后续测试）。
   */
  async runAcceptanceTests(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    hooks?: ExecutionHooks,
  ): Promise<AcceptanceTestResult[]> {
    const sandbox = SandboxGuard.createForDir(workingDir);
    const results: AcceptanceTestResult[] = [];

    for (const t of taskFrame.acceptanceTests) {
      hooks?.emitProgress({
        kind: "tool-start",
        tool: "acceptance-test",
        argsSummary: describeTest(t),
      });

      const outcome = await executeCheckMethod(t.checkMethod, sandbox, {
        timeoutMs: this.acceptanceTimeoutMs,
        highRiskGuard: this.highRiskGuard,
        hooks,
      });

      results.push({
        testId: t.id,
        description: t.description,
        checkMethod: t.checkMethod,
        passed: outcome.passed,
        detail: outcome.detail,
      });

      hooks?.emitProgress({
        kind: "tool-result",
        tool: "acceptance-test",
        status: outcome.passed ? "ok" : "failed",
        resultSummary: outcome.detail,
      });
    }

    return results;
  }

  /**
   * 收集证据产出 Delivery_Report（R15.1 / R15.2）。
   *
   * 证据 1:1 覆盖落地动作：每个被改动文件一条 `fileDiffs`、每条所跑命令一条 `commandOutputs`；
   * `hasFailures` 由 `acceptanceTestResults` 派生（存在失败时 UI 须显著标红）。
   */
  async buildReport(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    backup: BackupHandle | undefined,
    execResult: ExecutionResult,
    acceptanceTestResults: AcceptanceTestResult[],
  ): Promise<Delivery_Report> {
    const log = execResult.log;
    const commandOutputs = collectCommandOutputs(log);

    const modifiedPaths = collectModifiedPaths(log);
    const fileDiffs = await Promise.all(
      modifiedPaths.map(async (p) => ({
        path: p,
        diff: await computeFileDiff(workingDir.rootAbsPath, p, backup, this.diffTimeoutMs),
      })),
    );

    const hasFailures = acceptanceTestResults.some((r) => !r.passed);
    const passedCount = acceptanceTestResults.filter((r) => r.passed).length;

    const summary = [
      `任务「${taskFrame.objective}」已执行完成。`,
      `改动文件 ${fileDiffs.length} 个，执行命令 ${commandOutputs.length} 条。`,
      `验收测试 ${acceptanceTestResults.length} 项，通过 ${passedCount} 项${hasFailures ? "，存在失败项（已标红）" : "，全部通过"}。`,
    ].join(" ");

    return { summary, fileDiffs, commandOutputs, acceptanceTestResults, hasFailures };
  }

  /**
   * 仅在用户"确认完成"时把会话标记为已验收（R15.4 / R15.5 / R15.6）。
   *
   * 不存在任何自动/超时路径：本方法只能由用户的"确认完成"动作显式调用，且仅在 `delivered`
   * 状态下生效——置 `accepted = true` 并转 `accepted` 状态；非 `delivered` 状态调用即抛错，
   * 以防止绕过验收门。
   *
   * @throws Error 当会话不处于 `delivered` 状态时（防止非法标记已验收）。
   */
  accept(session: Session): void {
    if (session.state !== SessionState.Delivered) {
      throw new Error(
        `accept 仅在 delivered 状态合法：当前状态为 ${session.state}，` +
          `任务的最终验收权归用户，不通过任何自动/超时途径标记已验收（R15.4/15.6）。`,
      );
    }
    session.accepted = true;
    session.state = SessionState.Accepted;
    session.updatedAt = this.now();
  }
}

/** 验收测试进度事件的简短描述。 */
function describeTest(t: Acceptance_Test): string {
  return `验收: ${t.description}（检验: ${t.checkMethod}）`;
}
