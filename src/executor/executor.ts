/**
 * Executor tool-calling 执行循环（任务 11.11，★核心，R12-R14）。
 *
 * 在 Working_Directory sandbox 内，由 LLM tool-calling 循环驱动**真实执行**（改代码、
 * 跑命令、操作文件），受 sandbox 越界拦截与 High_Risk_Guard 约束，并能在「小问题自解」
 * 与「阻断性问题暂停问用户」之间切换。本模块只承载执行循环编排逻辑；安全判定纯函数
 * （`SandboxGuard` / `detectSymlinkEscape` / `HighRiskGuard` / `hasMaterializedRelevantActions`）
 * 与各内置工具均从既有模块 import，保持单一来源。
 *
 * 循环逐步（与 design.md「Executor 循环详解」一致）：
 *   1. `buildInitialContext`：构造初始上下文（Task_Frame + Acceptance_Test + primaryTargets + 工具声明）。
 *   2. `llm.completeWithTools` 决定下一步：
 *      - 返回 `finalText` 且无 tool calls → 完成校验 `hasMaterializedRelevantActions`
 *        （必须有触及 primaryTargets 的真实落地动作，否则回灌提示 LLM 继续，R12.5）。
 *      - 返回 tool calls → 对每个 tool call 依次过四道闸再执行：
 *        a. sandbox 越界拦截（realpath 解析后判定；命中→记录 blocked + 回灌错误，R12.4）。
 *        b. `detectSymlinkEscape` 符号链接逃逸拦截（命中→记录 blocked + 回灌错误，R12.2）。
 *        c. 高危调度门：`HighRiskGuard.isHighRisk` 命中→ `emitProgress(high-risk-pending)` +
 *           `hooks.confirmHighRisk` 暂停弹窗；confirm 放行执行（R13.3），reject 跳过并回灌
 *           「用户拒绝」（R13.4）；未确认绝不执行（R13.1/R13.5）。
 *        d. 执行：`emitProgress(tool-start)` → `tool.invoke` → `emitProgress(tool-result)`
 *           四态 status（ok/failed/blocked/skipped）→ 结果回灌 LLM（R14.1 小问题自解）。
 *           invoke 抛错时按 `isBlocking` 分流：阻断性问题经 `hooks.askUser` 暂停等待答复后
 *           回灌继续（R14.2/14.3/14.4），非阻断性小问题直接回灌让 LLM 自行调整（R14.1）。
 *   3. 达到 `maxSteps` 仍未声称完成 → 返回 `max_steps_reached`。
 *
 * `run_command` 的执行超时（`RUN_COMMAND_TIMEOUT_MS`）已在工具层（任务 11.10）实现：超时即
 * 终止子进程并以 `ToolResult{ ok:false, error:"...超时..." }` 返回，本循环按普通可回灌失败
 * 处理（计为 `tool-result` 的 `failed` 状态），不会挂死循环。
 *
 * _Requirements: 12.1, 12.4, 12.5, 13.1, 13.3, 13.4, 13.5, 14.1, 14.2, 14.3, 14.4_
 */

import type { Task_Frame } from "../clarifier/types.js";
import type {
  LLM_Provider,
  LlmMessage,
} from "../llm/llmProvider.js";
import { hasMaterializedRelevantActions } from "./completion.js";
import { HighRiskGuard } from "./highRiskGuard.js";
import { SandboxGuard, type WorkingDirectoryLike } from "./sandboxGuard.js";
import { detectSymlinkEscape } from "./symlinkEscape.js";
import {
  BUILTIN_EXECUTOR_TOOLS,
  createToolRegistry,
  toolSpecs,
} from "./toolRegistry.js";
import type {
  Executor_Tool,
  ExecutionHooks,
  ExecutionResult,
  ToolCall,
  ToolInvocation,
  ToolResult,
} from "./types.js";
import {
  runConcurrentLoop,
  type ConcurrentExecutorConfig,
} from "./concurrentExecutor.js";

/** 执行循环步数硬上限：每步对应一次 `completeWithTools`，防止无限循环。 */
export const MAX_STEPS = 50;

/**
 * Executor 执行循环 system prompt（强调「必须真实落地，不能只给计划」，R12.5）。
 *
 * 强约束：所有操作限定在 Working_Directory（sandbox）内；通过工具真实改动目标文件/目录；
 * 仅输出计划或代码文本而不落地不算完成（R12.1/R12.2/R12.5）。
 */
export const EXECUTOR_SYSTEM_PROMPT = [
  "你是问路（Wenlu）的执行器（Executor），在一个受限的工作目录（Working_Directory / sandbox）内真实地完成任务。",
  "硬性要求：",
  "1. 你必须通过提供的工具（read_file / write_file / list_dir / run_command / delete_file）真实地改动目标文件/目录，",
  "   而不是只给出计划、思路或代码文本——仅有计划或文本不算完成。",
  "2. 所有文件与命令操作必须限定在 Working_Directory 范围内；任何越界操作都会被安全门拦截并回灌错误。",
  "3. 优先对任务的主要操作对象（primaryTargets）执行实际更改；不要用无关的临时操作伪装“已落地”。",
  "4. 高危动作（删除文件、运行 shell、sudo、chmod、改权限、git force push、未知命令等）会暂停等待用户确认。",
  "5. 遇到可自行解决的小问题（如文件不存在、命令非零退出）应在后续步骤自行调整；只有真正无法推进的阻断性问题才需要向用户求助。",
  "当且仅当任务已真实落地完成时，停止调用工具并给出最终完成说明。",
].join("\n");

/**
 * 执行循环依赖项（注入便于测试与可插拔，R6 / R17.3）。
 */
export interface ExecutorDeps {
  /** LLM 供应方，用于 tool-calling 决策（`completeWithTools`）。 */
  llm: LLM_Provider;
  /**
   * 可用工具集合，默认 `BUILTIN_EXECUTOR_TOOLS`。循环据此装配 ToolRegistry
   * 并取 `ToolSpec[]` 喂给 LLM。
   */
  tools?: readonly Executor_Tool[];
  /** 高危动作识别器，默认 `new HighRiskGuard()`（用 config 默认白名单）。 */
  highRiskGuard?: HighRiskGuard;
  /** 步数上限，默认 `MAX_STEPS`。 */
  maxSteps?: number;
  /** 并发执行配置。若提供，则自动切换到并发调度路径。 */
  concurrent?: Omit<ConcurrentExecutorConfig, "llm" | "tools" | "highRiskGuard" | "maxSteps">;
}

/**
 * 阻断性问题错误：标记一个执行错误属于「需要用户决策、无法自行解决」的阻断性问题，
 * 据此在执行循环中触发 `hooks.askUser` 暂停（R14.2）。
 *
 * 约定：工具 `invoke` 抛出的普通错误默认视为**非阻断性小问题**（LLM 在后续步骤自解，
 * R14.1）；仅当抛出的错误为 `BlockingError`，或对象带 `blocking === true` 标记时，才判为
 * 阻断性问题。该约定使「小问题 vs 阻断性」分流可被确定性测试（Property 19）。
 */
export class BlockingError extends Error {
  /** 判别标记，便于跨实例/结构化判定。 */
  readonly blocking = true as const;
  constructor(message: string) {
    super(message);
    this.name = "BlockingError";
  }
}

/**
 * 判定执行错误是否为阻断性问题（R14.1 / R14.2）。
 *
 * @param err 工具 `invoke` 抛出的错误。
 * @returns `true` 表示阻断性（需 `askUser` 暂停）；`false` 表示小问题（回灌后 LLM 自解）。
 */
export function isBlocking(err: unknown): boolean {
  if (err instanceof BlockingError) return true;
  if (
    err !== null &&
    typeof err === "object" &&
    (err as { blocking?: unknown }).blocking === true
  ) {
    return true;
  }
  return false;
}

// ===========================================================================
// 内部辅助：消息构造 / 摘要 / 路径提取
// ===========================================================================

/** 摘要截断长度（保持 SSE/回灌摘要简洁）。 */
const SUMMARY_MAX_LEN = 300;

/** 截断长字符串，超长追加省略号。 */
function truncate(s: string, max = SUMMARY_MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断，共 ${s.length} 字符）`;
}

/** 构造 assistant 角色消息。 */
function assistant(content: string): LlmMessage {
  return { role: "assistant", content };
}

/** 构造 user 角色消息。 */
function user(content: string): LlmMessage {
  return { role: "user", content };
}

/** 把工具结果回灌为 `tool` 角色消息（关联其 tool call id）。 */
function toolResultMessage(toolCallId: string, result: ToolResult): LlmMessage {
  return {
    role: "tool",
    content: JSON.stringify(result),
    toolCallId,
  };
}

/**
 * 构造执行循环初始上下文：把 Task_Frame 的目标、逻辑阶段、已消解前提、主要操作对象、
 * 验收测试注入首条 user 消息，作为完成判据与执行依据（R12.5）。
 */
export function buildInitialContext(task: Task_Frame): LlmMessage[] {
  const lines: string[] = [];
  lines.push("# 待执行任务");
  lines.push(`目标（objective）：${task.objective}`);

  if (task.phases.length > 0) {
    lines.push("\n## 逻辑阶段");
    for (const p of [...task.phases].sort((a, b) => a.order - b.order)) {
      lines.push(`- (${p.order}) ${p.title}`);
    }
  }

  if (task.resolvedPreconditions.length > 0) {
    lines.push("\n## 已澄清的执行前提");
    for (const pc of task.resolvedPreconditions) {
      const val = pc.resolvedValue ?? pc.proposedDefault ?? "(未指定)";
      lines.push(`- ${pc.description}：${val}`);
    }
  }

  if (task.primaryTargets && task.primaryTargets.length > 0) {
    lines.push("\n## 主要操作对象（primaryTargets，必须对其真实落地改动）");
    for (const t of task.primaryTargets) lines.push(`- ${t}`);
  } else {
    lines.push(
      "\n## 主要操作对象\n（未指定具体目标；至少需有一个真实落地动作才算完成）",
    );
  }

  lines.push("\n## 验收测试（完成后将逐条强制运行，全部通过才算交付）");
  for (const at of task.acceptanceTests) {
    lines.push(`- [${at.id}] ${at.description} —— 检验方式：${at.checkMethod}`);
  }

  lines.push(
    "\n请在 Working_Directory（sandbox）内通过工具真实完成上述任务；完成后停止调用工具并给出完成说明。",
  );

  return [user(lines.join("\n"))];
}

/**
 * 提取 tool call 中需做 sandbox 越界校验的路径参数（R12.2 / R12.4）。
 *
 * 内置文件类工具（read_file / write_file / list_dir / delete_file）的越界面来自其
 * `path` 参数；`run_command` 的工作目录恒为 sandbox 根（由工具层自校验）、命令中显式路径
 * 与 `ln -s` 越界由工具层与 `detectSymlinkEscape` 各司其职，故此处只提取字符串 `path` 参数。
 */
export function extractPaths(tc: ToolCall): string[] {
  const p = tc.arguments?.path;
  return typeof p === "string" && p.length > 0 ? [p] : [];
}

/** 高危确认/事件用的简短动作描述。 */
function describe(tc: ToolCall): string {
  const cmd = tc.arguments?.command;
  if (tc.name === "run_command" && typeof cmd === "string") {
    return `run_command: ${truncate(cmd, 120)}`;
  }
  const p = tc.arguments?.path;
  if (typeof p === "string") return `${tc.name}: ${p}`;
  return `${tc.name}: ${truncate(JSON.stringify(tc.arguments ?? {}), 120)}`;
}

/** tool-start 事件的参数摘要。 */
function summarizeArgs(tc: ToolCall): string {
  return describe(tc);
}

/** tool-result 事件的结果摘要。 */
function summarizeResult(result: ToolResult): string {
  if (result.ok) return truncate(result.output || "成功");
  return truncate(result.error ?? result.output ?? "失败");
}

/** 阻断性问题向用户提问的文案。 */
function formatProblem(tc: ToolCall, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `执行「${describe(tc)}」时遇到无法自行解决的问题：${msg}。请提供进一步指示。`;
}

// ===========================================================================
// 执行循环
// ===========================================================================

/**
 * 运行 Executor tool-calling 执行循环（R12-R14）。
 *
 * @param task  经澄清产出的结构化任务（含 Acceptance_Test 与 primaryTargets）。
 * @param wd    已确认的 Working_Directory（sandbox 根）。
 * @param hooks 执行回调（高危确认 / 阻断性提问 / 实时动作流推送）。
 * @param deps  依赖项（LLM 供应方、工具集合、高危识别器、步数上限）。
 * @returns 执行结果（`completed` / `max_steps_reached`；`completed` 仍须经 verifying 强制验收）。
 */
export async function runLoop(
  task: Task_Frame,
  wd: WorkingDirectoryLike,
  hooks: ExecutionHooks,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const sandbox = new SandboxGuard(wd.rootAbsPath);
  const tools = deps.tools ?? BUILTIN_EXECUTOR_TOOLS;
  const toolRegistry = createToolRegistry(tools);
  const specs = toolSpecs(tools);
  const highRiskGuard = deps.highRiskGuard ?? new HighRiskGuard();
  const maxSteps = deps.maxSteps ?? MAX_STEPS;

  const messages: LlmMessage[] = buildInitialContext(task);
  const log: ToolInvocation[] = [];

  /** 记录一次「被安全门拦截」的 tool call（R12.4）。 */
  const recordBlocked = (tc: ToolCall, reason: string): void => {
    log.push({
      tc: { name: tc.name, arguments: tc.arguments },
      result: { ok: false, output: "", error: reason },
      blocked: true,
    });
  };

  for (let step = 0; step < maxSteps; step++) {
    const resp = await deps.llm.completeWithTools({
      system: EXECUTOR_SYSTEM_PROMPT,
      messages,
      tools: specs,
    });

    // 完成信号：返回 finalText 且无 tool calls。
    if (resp.finalText && !(resp.toolCalls && resp.toolCalls.length > 0)) {
      // 完成校验：必须有触及 primaryTargets 的真实落地动作（R12.5）。
      if (!hasMaterializedRelevantActions(log, task.primaryTargets)) {
        messages.push(
          assistant(resp.finalText),
          user(
            "仅有计划、或只做了与目标无关的操作都不算完成。" +
              "请对目标文件/目录执行实际更改，不要只做无关操作。",
          ),
        );
        continue;
      }
      // 注：此处 return 仅表示循环内「声称完成」，Orchestrator 随后进入 verifying
      // 强制运行 Acceptance_Test，全部通过才进入 delivered（见状态机）。
      return { status: "completed", log, finalText: resp.finalText };
    }

    // OpenAI 兼容协议要求：每条 role:"tool" 结果消息之前，必须有一条声明了对应 tool_call
    // 的 role:"assistant" 消息（带 tool_calls）。故在执行/拦截任何工具前，先把本轮模型返回
    // 的 tool_calls 作为一条 assistant 消息回灌；随后每个 tool call（无论执行、被安全门拦截
    // 还是被用户拒绝跳过）都会回灌一条与其 id 配对的 role:"tool" 结果消息，避免"孤立 tool
    // 消息"导致端点返回 400。
    if (resp.toolCalls && resp.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: resp.finalText ?? "",
        toolCalls: resp.toolCalls,
      });
    }

    for (const tc of resp.toolCalls ?? []) {
      // 1) sandbox 越界拦截（realpath 解析后判定，R12.2 / R12.4）。
      const violation = extractPaths(tc).find((p) => !sandbox.isInside(p));
      if (violation !== undefined) {
        const reason = `越界拒绝: ${violation} 不在 Working_Directory 内`;
        recordBlocked(tc, reason);
        hooks.emitProgress({
          kind: "tool-result",
          tool: tc.name,
          status: "blocked",
          resultSummary: `越界拒绝: ${violation}`,
        });
        messages.push(toolResultMessage(tc.id, { ok: false, output: "", error: reason }));
        continue;
      }

      // 1b) 符号链接逃逸拦截（R12.2）。
      const linkViolation = detectSymlinkEscape(tc, sandbox);
      if (linkViolation) {
        recordBlocked(tc, linkViolation);
        hooks.emitProgress({
          kind: "tool-result",
          tool: tc.name,
          status: "blocked",
          resultSummary: `符号链接逃逸已阻止: ${linkViolation}`,
        });
        messages.push(
          toolResultMessage(tc.id, {
            ok: false,
            output: "",
            error: `符号链接逃逸已阻止: ${linkViolation}`,
          }),
        );
        continue;
      }

      // 2) 高危调度门（黑名单 + 白名单兜底，R13）。
      let riskConfirmed = false;
      if (highRiskGuard.isHighRisk(tc)) {
        hooks.emitProgress({
          kind: "high-risk-pending",
          tool: tc.name,
          summary: describe(tc),
        });
        const decision = await hooks.confirmHighRisk(describe(tc)); // 暂停→弹窗（R13.1）
        if (decision === "reject") {
          // R13.4：跳过该动作并继续循环，回灌「用户拒绝」。
          hooks.emitProgress({
            kind: "tool-result",
            tool: tc.name,
            status: "skipped",
            resultSummary: "用户拒绝该高危动作，已跳过",
          });
          messages.push(
            toolResultMessage(tc.id, {
              ok: false,
              output: "",
              error: "用户拒绝该高危动作，已跳过",
            }),
          );
          continue;
        }
        riskConfirmed = true; // confirm → 放行执行（R13.3）
      }

      // 3) 真实执行（前后推送实时执行动作流，R12.5）。
      hooks.emitProgress({
        kind: "tool-start",
        tool: tc.name,
        argsSummary: summarizeArgs(tc),
      });
      try {
        const tool = toolRegistry.resolve(tc.name);
        const result = await tool.invoke(tc.arguments, {
          workingDirRoot: wd.rootAbsPath,
          sandbox,
        });
        // 工具自身防御性纵深可能返回 blocked:true（越界/符号链接），据此分类四态。
        const status = result.blocked ? "blocked" : result.ok ? "ok" : "failed";
        log.push({
          tc: { name: tc.name, arguments: tc.arguments },
          result,
          blocked: result.blocked,
          riskConfirmed: riskConfirmed || undefined,
        });
        hooks.emitProgress({
          kind: "tool-result",
          tool: tc.name,
          status,
          resultSummary: summarizeResult(result),
        });
        messages.push(toolResultMessage(tc.id, result)); // 结果回灌（R14.1 小问题自解）
      } catch (err) {
        hooks.emitProgress({
          kind: "tool-result",
          tool: tc.name,
          status: "failed",
          resultSummary: truncate(String(err)),
        });
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isBlocking(err)) {
          // 阻断性问题：暂停问用户（R14.2 / R14.3），答复回灌继续（R14.4）。
          const answer = await hooks.askUser(formatProblem(tc, err));
          messages.push(
            toolResultMessage(tc.id, { ok: false, output: "", error: errMsg }),
            user(answer),
          );
        } else {
          // 小问题：结果回灌让 LLM 自行调整（R14.1）。
          messages.push(
            toolResultMessage(tc.id, { ok: false, output: "", error: errMsg }),
          );
        }
      }
    }
  }

  return { status: "max_steps_reached", log };
}

/**
 * Executor 接口实现（design「Executor 执行层」契约）。
 *
 * 持有执行依赖（LLM / 工具 / 高危识别器），`run` 委托给 `runLoop`。便于编排层（任务 14.x）
 * 以单一对象注入并调用，同时保留 `runLoop` 作为可独立测试的纯编排函数。
 */
export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  run(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    hooks: ExecutionHooks,
  ): Promise<ExecutionResult> {
    if (this.deps.concurrent) {
      const config: ConcurrentExecutorConfig = {
        llm: this.deps.llm,
        tools: this.deps.tools,
        highRiskGuard: this.deps.highRiskGuard,
        maxSteps: this.deps.maxSteps,
        ...this.deps.concurrent,
      };
      return runConcurrentLoop(taskFrame, workingDir, hooks, config);
    }
    return runLoop(taskFrame, workingDir, hooks, this.deps);
  }
}
