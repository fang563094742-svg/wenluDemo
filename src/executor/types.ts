/**
 * Executor 执行层共享类型（任务 11.1，R12 / R13 / R14）。
 *
 * 本模块只承载 Executor tool-calling 执行循环涉及的**类型契约**，不含运行逻辑：
 *  - `ToolCall` / `ToolResult`：LLM 发起的工具调用及其执行结果。
 *  - `ToolContext`：工具执行时注入的上下文（sandbox 根 + 越界校验器）。
 *  - `Executor_Tool`：可插拔工具接口契约（R12.3 / R17.2）。
 *  - `ExecutionHooks`：执行循环回调（高危确认 / 阻断性提问 / 实时动作流推送）。
 *  - `ExecutionProgressEvent`：SSE `execution-progress` 事件载荷（四态结果）。
 *  - `ExecutionResult` / `ToolInvocation`：执行循环产物与单步调用记录。
 *
 * `ToolSpec` 与 `ToolInvocation` 在此处定义/承载，便于在 LLM Provider（任务 5.1）
 * 与 Session 聚合根（任务 14.1）尚未落地时也能让 Executor 类型独立成型；后续模块
 * 应从本模块或 llm 模块 import 以保持单一来源（接口结构相同、可结构化互换）。
 *
 * _Requirements: 12.2, 12.4_
 */

import type { SandboxGuard } from "./sandboxGuard.js";

/**
 * 供 LLM tool-calling 的工具声明（含 JSON Schema 参数约束）。
 *
 * 说明：LLM_Provider（任务 5.1，`llm/llmProvider.ts`）将提供与此结构一致的
 * 权威 `ToolSpec` 供 `completeWithTools` 使用；此处先行定义以让 `Executor_Tool`
 * 类型独立成型。二者字段结构相同，TypeScript 结构化类型下可互换；任务 5.1 落地后
 * 应统一为单一来源（由 llm 模块导出，executor 再 re-export 或 import）。
 */
export interface ToolSpec {
  /** 工具名（同时作为 ToolRegistry 的解析 key）。 */
  name: string;
  /** 给 LLM 的工具用途描述。 */
  description: string;
  /** 描述 `arguments` 结构的 JSON Schema。 */
  parameters: object;
}

/**
 * LLM 发起的一次工具调用（来自 `LlmToolResponse.toolCalls` 的单项）。
 *
 * 安全相关纯函数（`SandboxGuard.isInside` / `detectSymlinkEscape` 等）据
 * `name` 与 `arguments` 中的路径/命令字段做越界与逃逸判定。
 */
export interface ToolCall {
  /** 本次调用的唯一标识，用于把工具结果回灌给对应调用。 */
  id: string;
  /** 目标工具名（对应 `Executor_Tool.name` / ToolRegistry key）。 */
  name: string;
  /** 工具参数（如 `{ path }` / `{ command }`），结构由各工具 ToolSpec 约束。 */
  arguments: Record<string, unknown>;
}

/**
 * 工具执行结果。
 *
 * `ok === false` 表示**可回灌的非致命错误**（如文件不存在、命令非零退出、
 * `run_command` 超时），由执行循环回灌给 LLM 自行调整，不必然中断整个循环。
 */
export interface ToolResult {
  /** 是否成功。 */
  ok: boolean;
  /** 命令 stdout/stderr 或文件操作结果摘要。 */
  output: string;
  /** 失败时的描述性错误信息。 */
  error?: string;
  /**
   * 工具在**自身防御性纵深校验**中判定该次调用属于被安全门拦截
   * （sandbox 越界 / 符号链接逃逸），而非普通的可回灌失败（R12.2 / R12.4）。
   *
   * 内置工具（如 `write_file`）在写盘前会先做 `SandboxGuard.isInside` 越界校验与
   * `detectSymlinkEscape` 符号链接拒绝；命中即返回 `ok:false` 且 `blocked:true`，
   * 供执行循环（任务 11.11）据以把对应 `ToolInvocation.blocked` 置位并记录该次阻止。
   *
   * 可选字段：普通成功/失败结果不设置此字段（等价于 `false`）。
   */
  blocked?: boolean;
}

/**
 * 工具执行上下文：在 `Executor_Tool.invoke` 时注入。
 *
 * 工具内部仍须用 `sandbox` 对自身涉及的路径再次自校验（防御性纵深，R12.2）。
 */
export interface ToolContext {
  /** sandbox 根（Working_Directory 的真实绝对路径）。 */
  workingDirRoot: string;
  /** 路径越界校验器（已对根做 realpath 规范化）。 */
  sandbox: SandboxGuard;
}

/**
 * 可插拔工具接口契约（R12.3 / R17.2）。
 *
 * 内置实现见任务 11.10（`executor/tools/*`）：read_file / write_file / list_dir /
 * run_command / delete_file。所有路径在调用前已由 sandbox 校验、命中高危已由
 * High_Risk_Guard 处理（确认或跳过）。
 */
export interface Executor_Tool {
  /** 工具名（ToolRegistry 解析 key）。 */
  readonly name: string;
  /** 供 LLM tool-calling 的工具声明（含 JSON Schema）。 */
  readonly spec: ToolSpec;
  /**
   * 静态风险类别，配合 High_Risk_Guard：
   *  - `"safe"`：默认安全（如 read_file / write_file / list_dir）。
   *  - `"conditional"`：视参数而定（如 run_command 按命令判定、delete_file 恒高危）。
   */
  readonly riskClass: "safe" | "conditional";
  /**
   * 执行工具。`args` 为本次调用参数，`ctx` 提供 sandbox 根与越界校验器。
   * @returns 工具执行结果（失败以 `ToolResult.ok=false` 表达，便于回灌）。
   */
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * SSE `execution-progress` 事件载荷（对抗性审查后新增，R12.5）。
 *
 * 执行循环每执行一个工具（无论成功/失败/被拦/被跳过）都经此推送到 UI，
 * 既提升体验，也是防假执行的社会工程防线——用户能看到 System 是否真在对目标动手。
 *
 *  - `tool-start`：工具开始执行前推送，含工具名与参数摘要（如"正在修改 src/app.ts…"）。
 *  - `tool-result`：工具执行后推送，`status` 取四态：
 *      - `"ok"`      执行成功
 *      - `"failed"`  执行失败（含命令非零退出、`run_command` 超时等可回灌的非致命错误）
 *      - `"blocked"` 被安全门拦截（sandbox 越界 / 符号链接逃逸）
 *      - `"skipped"` 高危动作被用户拒绝而跳过
 *  - `high-risk-pending`：高危动作等待用户确认时推送。
 */
export type ExecutionProgressEvent =
  | { kind: "tool-start"; tool: string; argsSummary: string }
  | {
      kind: "tool-result";
      tool: string;
      status: "ok" | "failed" | "blocked" | "skipped";
      resultSummary: string;
    }
  | { kind: "high-risk-pending"; tool: string; summary: string };

/**
 * 执行循环回调（R13 / R14 / R12.5）。
 *
 * 由 Orchestrator/Web 层注入，桥接到 SSE 推送与用户交互（高危确认、阻断性提问）。
 */
export interface ExecutionHooks {
  /**
   * 高危确认弹窗：阻塞直到用户决定（R13）。
   * @returns `"confirm"` 放行执行 / `"reject"` 跳过该动作。
   */
  confirmHighRisk(description: string): Promise<"confirm" | "reject">;
  /**
   * 阻断性问题向用户提问：阻塞直到用户答复（R14.2 / R14.3）。
   * @returns 用户答复文本，回灌给 LLM 继续执行循环（R14.4）。
   */
  askUser(problem: string): Promise<string>;
  /**
   * 实时执行动作流推送（R12.5）：每个工具动作前后各推一条
   * `execution-progress` 事件到 UI。
   */
  emitProgress(event: ExecutionProgressEvent): void;
}

/**
 * 单步工具调用记录（执行循环逐步累积，构成 `ExecutionResult.log`）。
 *
 * 注：本类型亦被 Session 聚合根（任务 14.1）与完成判定纯函数
 * `hasMaterializedRelevantActions`（任务 11.8）复用，应从本模块 import 以保持单一来源。
 */
export interface ToolInvocation {
  /** 本次调用（design Data Models 仅留 name/arguments 即足够判定落地相关性）。 */
  tc: Pick<ToolCall, "name" | "arguments">;
  /** 执行结果。 */
  result: ToolResult;
  /** 是否被安全门拦截（越界 / 符号链接逃逸），R12.4。 */
  blocked?: boolean;
  /** 高危动作是否经用户确认放行。 */
  riskConfirmed?: boolean;
}

/**
 * 执行循环产物。
 *
 *  - `"completed"`：循环内"声称完成"（仍须经 verifying 强制验收，见状态机）。
 *  - `"max_steps_reached"`：达到最大步数仍未完成。
 *  - `"aborted"`：执行被中止。
 */
export interface ExecutionResult {
  status: "completed" | "max_steps_reached" | "aborted";
  /** 全过程工具调用记录。 */
  log: ToolInvocation[];
  /** LLM 声称完成时给出的最终文本（若有）。 */
  finalText?: string;
}
