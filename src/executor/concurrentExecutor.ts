/**
 * concurrentExecutor.ts — 将并发调度器集成到 executor 执行循环中。
 *
 * 设计原则：
 * - 安全门（sandbox / symlink / high-risk）仍然串行前置检查，只有通过了的 tool calls 才进入并发池
 * - 通过安全门的 tool calls 经 conflictDetector 分组后并发执行
 * - 完全向后兼容：不改 executor.ts，而是提供一个 enhanced runLoop
 */

import type { Task_Frame } from "../clarifier/types.js";
import type { LLM_Provider, LlmMessage } from "../llm/llmProvider.js";
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
  buildInitialContext,
  extractPaths,
  EXECUTOR_SYSTEM_PROMPT,
  MAX_STEPS,
} from "./executorShared.js";
import {
  createConcurrentScheduler,
  type ToolCall as SchedulerToolCall,
  type ToolInvoker,
  type ConflictDetector,
  type SemanticRegistry,
  type SchedulerEventBus,
} from "../runtime/concurrentScheduler.js";
import type { BudgetGovernor } from "../runtime/budgetGovernor.js";
import type { ToolCache } from "../tools/cachePolicy.js";

// ═══════════════════════════════════════════════════════════════════════
// 扩展的 Deps
// ═══════════════════════════════════════════════════════════════════════

export interface ConcurrentExecutorConfig {
  llm: LLM_Provider;
  tools?: readonly Executor_Tool[];
  highRiskGuard?: HighRiskGuard;
  maxSteps?: number;
  budgetGovernor: BudgetGovernor;
  cache: ToolCache;
  conflictDetector: ConflictDetector;
  semantics: SemanticRegistry;
  eventBus?: SchedulerEventBus;
  maxConcurrency?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════

const SUMMARY_MAX_LEN = 300;

function truncate(s: string, max = SUMMARY_MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断，共 ${s.length} 字符）`;
}

function describe(tc: ToolCall): string {
  const cmd = tc.arguments?.command;
  if (tc.name === "run_command" && typeof cmd === "string") {
    return `run_command: ${truncate(cmd, 120)}`;
  }
  const p = tc.arguments?.path;
  if (typeof p === "string") return `${tc.name}: ${p}`;
  return `${tc.name}: ${truncate(JSON.stringify(tc.arguments ?? {}), 120)}`;
}

function summarizeResult(result: ToolResult): string {
  if (result.ok) return truncate(result.output || "成功");
  return truncate(result.error ?? result.output ?? "失败");
}

function toolResultMessage(toolCallId: string, result: ToolResult): LlmMessage {
  return { role: "tool", content: JSON.stringify(result), toolCallId };
}

function formatProblem(tc: ToolCall, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `执行「${describe(tc)}」时遇到无法自行解决的问题：${msg}。请提供进一步指示。`;
}

// ═══════════════════════════════════════════════════════════════════════
// 核心：并发执行循环
// ═══════════════════════════════════════════════════════════════════════

interface GatedCall {
  tc: ToolCall;
  passed: true;
}

interface BlockedCall {
  tc: ToolCall;
  passed: false;
  reason: string;
  status: "blocked" | "skipped";
}

type SecurityResult = GatedCall | BlockedCall;

/**
 * 带并发执行能力的 executor runLoop。
 *
 * 相比原 runLoop 的改进：
 * 1. 同一轮 LLM 返回的多个 tool calls，安全门逐个检查后，把通过的批量并发执行
 * 2. 利用 ConcurrentScheduler 的缓存预检 + 冲突分组 + semaphore 限流
 * 3. Budget governor 自动降级
 * 4. 保留阻断性问题暂停、高危确认等人机交互语义
 */
export async function runConcurrentLoop(
  task: Task_Frame,
  wd: WorkingDirectoryLike,
  hooks: ExecutionHooks,
  config: ConcurrentExecutorConfig,
): Promise<ExecutionResult> {
  const sandbox = new SandboxGuard(wd.rootAbsPath);
  const tools = config.tools ?? BUILTIN_EXECUTOR_TOOLS;
  const toolRegistry = createToolRegistry(tools);
  const specs = toolSpecs(tools);
  const highRiskGuard = config.highRiskGuard ?? new HighRiskGuard();
  const maxSteps = config.maxSteps ?? MAX_STEPS;

  // 创建调度器
  const scheduler = createConcurrentScheduler({
    conflictDetector: config.conflictDetector,
    budgetGovernor: config.budgetGovernor,
    cache: config.cache,
    semantics: config.semantics,
    eventBus: config.eventBus,
    config: { maxConcurrency: config.maxConcurrency ?? 6, abortOnCriticalFailure: true, cacheEnabled: true },
  });

  const messages: LlmMessage[] = buildInitialContext(task);
  const log: ToolInvocation[] = [];

  const recordBlocked = (tc: ToolCall, reason: string): void => {
    log.push({
      tc: { name: tc.name, arguments: tc.arguments },
      result: { ok: false, output: "", error: reason },
      blocked: true,
    });
  };

  // 构造 invoker：由 toolRegistry 驱动真实执行
  const invoker: ToolInvoker = async (toolName, params, signal) => {
    if (signal.aborted) throw new Error("aborted");
    const tool = toolRegistry.resolve(toolName);
    const result = await tool.invoke(params as Record<string, string>, {
      workingDirRoot: wd.rootAbsPath,
      sandbox,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "tool execution failed");
    }
    return result;
  };

  for (let step = 0; step < maxSteps; step++) {
    const resp = await config.llm.completeWithTools({
      system: EXECUTOR_SYSTEM_PROMPT,
      messages,
      tools: specs,
    });

    // 完成信号
    if (resp.finalText && !(resp.toolCalls && resp.toolCalls.length > 0)) {
      if (!hasMaterializedRelevantActions(log, task.primaryTargets)) {
        messages.push(
          { role: "assistant", content: resp.finalText },
          { role: "user", content: "仅有计划、或只做了与目标无关的操作都不算完成。请对目标文件/目录执行实际更改，不要只做无关操作。" },
        );
        continue;
      }
      return { status: "completed", log, finalText: resp.finalText };
    }

    // 回灌 assistant tool_calls 消息
    if (resp.toolCalls && resp.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: resp.finalText ?? "",
        toolCalls: resp.toolCalls,
      });
    }

    const allCalls = resp.toolCalls ?? [];
    if (allCalls.length === 0) continue;

    // ─── Phase A: 安全门串行检查 ───
    const securityResults: SecurityResult[] = [];

    for (const tc of allCalls) {
      // sandbox 越界
      const violation = extractPaths(tc).find((p) => !sandbox.isInside(p));
      if (violation !== undefined) {
        const reason = `越界拒绝: ${violation} 不在 Working_Directory 内`;
        securityResults.push({ tc, passed: false, reason, status: "blocked" });
        recordBlocked(tc, reason);
        hooks.emitProgress({ kind: "tool-result", tool: tc.name, status: "blocked", resultSummary: `越界拒绝: ${violation}` });
        messages.push(toolResultMessage(tc.id, { ok: false, output: "", error: reason }));
        continue;
      }

      // symlink 逃逸
      const linkViolation = detectSymlinkEscape(tc, sandbox);
      if (linkViolation) {
        securityResults.push({ tc, passed: false, reason: linkViolation, status: "blocked" });
        recordBlocked(tc, linkViolation);
        hooks.emitProgress({ kind: "tool-result", tool: tc.name, status: "blocked", resultSummary: `符号链接逃逸已阻止: ${linkViolation}` });
        messages.push(toolResultMessage(tc.id, { ok: false, output: "", error: `符号链接逃逸已阻止: ${linkViolation}` }));
        continue;
      }

      // 高危确认（必须串行等待用户）
      if (highRiskGuard.isHighRisk(tc)) {
        hooks.emitProgress({ kind: "high-risk-pending", tool: tc.name, summary: describe(tc) });
        const decision = await hooks.confirmHighRisk(describe(tc));
        if (decision === "reject") {
          securityResults.push({ tc, passed: false, reason: "用户拒绝该高危动作，已跳过", status: "skipped" });
          hooks.emitProgress({ kind: "tool-result", tool: tc.name, status: "skipped", resultSummary: "用户拒绝该高危动作，已跳过" });
          messages.push(toolResultMessage(tc.id, { ok: false, output: "", error: "用户拒绝该高危动作，已跳过" }));
          continue;
        }
      }

      securityResults.push({ tc, passed: true });
    }

    // ─── Phase B: 并发执行通过安全门的 tool calls ───
    const passedCalls = securityResults.filter((r): r is GatedCall => r.passed);

    if (passedCalls.length === 0) continue;

    // 转换为 scheduler 格式
    const schedulerCalls: SchedulerToolCall[] = passedCalls.map(({ tc }) => ({
      id: tc.id,
      toolName: tc.name,
      params: tc.arguments ?? {},
    }));

    // emit tool-start for all
    for (const { tc } of passedCalls) {
      hooks.emitProgress({ kind: "tool-start", tool: tc.name, argsSummary: describe(tc) });
    }

    // 并发执行
    const results = await scheduler.dispatch(schedulerCalls, invoker);

    // ─── Phase C: 处理结果 ───
    for (const result of results) {
      const originalTc = passedCalls.find(({ tc }) => tc.id === result.callId)!.tc;

      if (result.success) {
        const finalResult = typeof result.output === "object" && result.output !== null && "ok" in (result.output as object)
          ? result.output as ToolResult
          : { ok: true, output: String(result.output ?? "") };

        log.push({
          tc: { name: originalTc.name, arguments: originalTc.arguments },
          result: finalResult,
          blocked: false,
        });
        hooks.emitProgress({
          kind: "tool-result",
          tool: originalTc.name,
          status: (finalResult as ToolResult).ok ? "ok" : "failed",
          resultSummary: summarizeResult(finalResult as ToolResult),
        });
        messages.push(toolResultMessage(originalTc.id, finalResult as ToolResult));
      } else if (result.aborted) {
        const errResult: ToolResult = { ok: false, output: "", error: "并发组内关键任务失败，已中止" };
        log.push({ tc: { name: originalTc.name, arguments: originalTc.arguments }, result: errResult, blocked: false });
        hooks.emitProgress({ kind: "tool-result", tool: originalTc.name, status: "failed", resultSummary: "组内中止" });
        messages.push(toolResultMessage(originalTc.id, errResult));
      } else if (result.budgetDenied) {
        const errResult: ToolResult = { ok: false, output: "", error: "预算不足，已降级跳过" };
        log.push({ tc: { name: originalTc.name, arguments: originalTc.arguments }, result: errResult, blocked: false });
        hooks.emitProgress({ kind: "tool-result", tool: originalTc.name, status: "failed", resultSummary: "预算不足" });
        messages.push(toolResultMessage(originalTc.id, errResult));
      } else {
        // 普通失败
        const errMsg = typeof result.output === "object" && result.output !== null
          ? (result.output as { error?: string }).error ?? JSON.stringify(result.output)
          : String(result.output ?? "unknown error");
        const errResult: ToolResult = { ok: false, output: "", error: errMsg };
        log.push({ tc: { name: originalTc.name, arguments: originalTc.arguments }, result: errResult, blocked: false });
        hooks.emitProgress({ kind: "tool-result", tool: originalTc.name, status: "failed", resultSummary: truncate(errMsg) });

        // 检查是否为阻断性问题
        if (errMsg.includes("BlockingError") || errMsg.includes("blocking")) {
          const answer = await hooks.askUser(formatProblem(originalTc, new Error(errMsg)));
          messages.push(toolResultMessage(originalTc.id, errResult), { role: "user", content: answer });
        } else {
          messages.push(toolResultMessage(originalTc.id, errResult));
        }
      }
    }
  }

  return { status: "max_steps_reached", log };
}

// ═══════════════════════════════════════════════════════════════════════
// ConcurrentExecutor 类
// ═══════════════════════════════════════════════════════════════════════

export class ConcurrentExecutor {
  constructor(private readonly config: ConcurrentExecutorConfig) {}

  run(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectoryLike,
    hooks: ExecutionHooks,
  ): Promise<ExecutionResult> {
    return runConcurrentLoop(taskFrame, workingDir, hooks, this.config);
  }
}
