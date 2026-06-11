/**
 * concurrentScheduler.ts — 并发工具调度器。
 *
 * 核心职责：将 LLM 一轮返回的多个 tool calls 安全并发执行。
 *
 * 流程：
 * 1. 缓存预检 — 命中直接返回，不占执行槽
 * 2. 冲突分组 — conflictDetector.maxParallelSet 划分无冲突组
 * 3. 组间串行执行，组内并发
 * 4. 每个执行前 budget.acquire()，失败则降级
 * 5. semaphore 限流，防止 I/O 过载
 * 6. 关键失败时 abort 同组剩余任务
 * 7. 执行后写缓存 + consume budget
 *
 * 不做的事：
 * - 不做安全门检查（由调用方在 dispatch 前完成）
 * - 不做 LLM 交互（纯执行层）
 * - 不持有 agentState 引用（通过 eventBus 通知）
 */

import { createSemaphore, type Semaphore } from "./semaphore.js";
import type { BudgetGovernor, AcquireRequest, ResourceDimension } from "./budgetGovernor.js";
import type { ToolSemantics, Purity } from "../tools/toolSemantics.js";
import type { CacheDecision, ToolCache, CacheKey } from "../tools/cachePolicy.js";
import { decideCachePolicy, buildCacheKey } from "../tools/cachePolicy.js";

// ═══════════════════════════════════════════════════════════════════════
// 外部依赖接口
// ═══════════════════════════════════════════════════════════════════════

export interface ToolCall {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  priority?: "critical" | "normal" | "optional";
}

export interface ToolResult {
  callId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  durationMs: number;
  fromCache: boolean;
  aborted?: boolean;
  budgetDenied?: boolean;
}

export type ToolInvoker = (
  toolName: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface ConflictDetector {
  maxParallelSet(toolNames: string[]): string[][];
}

export interface SemanticRegistry {
  get(toolName: string): ToolSemantics | undefined;
}

export interface SchedulerEventBus {
  emit(event: SchedulerEvent): void;
}

export type SchedulerEvent =
  | { kind: "concurrent-group-start"; groupIndex: number; toolNames: string[] }
  | { kind: "concurrent-group-end"; groupIndex: number; results: ToolResult[] }
  | { kind: "tool-cache-hit"; callId: string; toolName: string }
  | { kind: "tool-budget-denied"; callId: string; toolName: string; dimension: ResourceDimension }
  | { kind: "tool-aborted"; callId: string; toolName: string; reason: string }
  ;

// ═══════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════

export interface SchedulerConfig {
  maxConcurrency: number;
  abortOnCriticalFailure: boolean;
  cacheEnabled: boolean;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrency: 6,
  abortOnCriticalFailure: true,
  cacheEnabled: true,
};

// ═══════════════════════════════════════════════════════════════════════
// Scheduler
// ═══════════════════════════════════════════════════════════════════════

export interface ConcurrentScheduler {
  dispatch(toolCalls: ToolCall[], invoker: ToolInvoker): Promise<ToolResult[]>;
  readonly stats: SchedulerStats;
}

export interface SchedulerStats {
  totalDispatched: number;
  totalCacheHits: number;
  totalBudgetDenied: number;
  totalAborted: number;
  totalErrors: number;
  avgConcurrency: number;
}

export interface SchedulerDeps {
  conflictDetector: ConflictDetector;
  budgetGovernor: BudgetGovernor;
  cache: ToolCache;
  semantics: SemanticRegistry;
  eventBus?: SchedulerEventBus;
  config?: Partial<SchedulerConfig>;
}

export function createConcurrentScheduler(deps: SchedulerDeps): ConcurrentScheduler {
  const cfg: SchedulerConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const semaphore: Semaphore = createSemaphore(cfg.maxConcurrency);

  const stats: SchedulerStats = {
    totalDispatched: 0,
    totalCacheHits: 0,
    totalBudgetDenied: 0,
    totalAborted: 0,
    totalErrors: 0,
    avgConcurrency: 0,
  };

  let dispatchCount = 0;
  let concurrencySum = 0;

  async function dispatch(toolCalls: ToolCall[], invoker: ToolInvoker): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return [];

    const results = new Map<string, ToolResult>();
    const pendingCalls: ToolCall[] = [];

    // ─── Phase 1: 缓存预检 ───
    for (const call of toolCalls) {
      stats.totalDispatched++;
      const sem = deps.semantics.get(call.toolName);
      if (!sem || !cfg.cacheEnabled) {
        pendingCalls.push(call);
        continue;
      }

      const decision = decideCachePolicy(sem, call.params, deps.cache.stats(call.toolName));
      if (decision.shouldCheckCache) {
        const key = buildCacheKey(call.toolName, call.params);
        const cached = deps.cache.get(key);
        if (cached) {
          results.set(call.id, {
            callId: call.id,
            toolName: call.toolName,
            success: true,
            output: cached.value,
            durationMs: 0,
            fromCache: true,
          });
          stats.totalCacheHits++;
          deps.eventBus?.emit({ kind: "tool-cache-hit", callId: call.id, toolName: call.toolName });
          continue;
        }
      }
      pendingCalls.push(call);
    }

    if (pendingCalls.length === 0) {
      return orderResults(toolCalls, results);
    }

    // ─── Phase 2: 冲突分组 ───
    const toolNames = pendingCalls.map(c => c.toolName);
    const groups = deps.conflictDetector.maxParallelSet(toolNames);

    // 把分组结果映射回 ToolCall 对象
    const callGroups = mapGroupsToCalls(groups, pendingCalls);

    // ─── Phase 3: 组间串行，组内并发 ───
    for (let gi = 0; gi < callGroups.length; gi++) {
      const group = callGroups[gi];
      deps.eventBus?.emit({
        kind: "concurrent-group-start",
        groupIndex: gi,
        toolNames: group.map(c => c.toolName),
      });

      const groupResults = await executeGroup(group, invoker);

      for (const r of groupResults) {
        results.set(r.callId, r);
      }

      deps.eventBus?.emit({
        kind: "concurrent-group-end",
        groupIndex: gi,
        results: groupResults,
      });
    }

    return orderResults(toolCalls, results);
  }

  async function executeGroup(group: ToolCall[], invoker: ToolInvoker): Promise<ToolResult[]> {
    const controller = new AbortController();
    const groupResults: ToolResult[] = [];

    const promises = group.map(call =>
      executeOne(call, invoker, controller).then(result => {
        // Abort immediately on critical failure (before allSettled resolves)
        if (
          cfg.abortOnCriticalFailure &&
          !result.success &&
          !result.fromCache &&
          !result.aborted &&
          isCritical(result.callId, group)
        ) {
          controller.abort(`critical tool ${result.toolName} failed`);
        }
        return result;
      })
    );
    const settled = await Promise.allSettled(promises);

    for (const s of settled) {
      if (s.status === "fulfilled") {
        groupResults.push(s.value);
      } else {
        stats.totalErrors++;
      }
    }

    // 更新平均并发度
    dispatchCount++;
    concurrencySum += Math.min(group.length, cfg.maxConcurrency);
    stats.avgConcurrency = concurrencySum / dispatchCount;

    return groupResults;
  }

  async function executeOne(
    call: ToolCall,
    invoker: ToolInvoker,
    controller: AbortController,
  ): Promise<ToolResult> {
    // Budget acquire
    const sem = deps.semantics.get(call.toolName);
    const dimension = inferDimension(sem);
    const priority = call.priority ?? "normal";

    if (dimension) {
      const req: AcquireRequest = {
        dimension,
        amount: 1,
        source: `scheduler:${call.toolName}`,
        priority,
      };
      const acq = deps.budgetGovernor.acquire(req);
      if (!acq.granted) {
        stats.totalBudgetDenied++;
        deps.eventBus?.emit({
          kind: "tool-budget-denied",
          callId: call.id,
          toolName: call.toolName,
          dimension,
        });
        return {
          callId: call.id,
          toolName: call.toolName,
          success: false,
          output: { error: "budget_denied", dimension, suggestion: acq.suggestion },
          durationMs: 0,
          fromCache: false,
          budgetDenied: true,
        };
      }
    }

    // Semaphore acquire
    const release = await semaphore.acquire();

    // Check abort before execution
    if (controller.signal.aborted) {
      release();
      stats.totalAborted++;
      deps.eventBus?.emit({
        kind: "tool-aborted",
        callId: call.id,
        toolName: call.toolName,
        reason: controller.signal.reason ?? "group-abort",
      });
      return {
        callId: call.id,
        toolName: call.toolName,
        success: false,
        output: { error: "aborted", reason: controller.signal.reason },
        durationMs: 0,
        fromCache: false,
        aborted: true,
      };
    }

    // Execute
    const start = Date.now();
    try {
      const output = await invoker(call.toolName, call.params, controller.signal);
      const durationMs = Date.now() - start;

      // Consume budget
      if (dimension) {
        deps.budgetGovernor.consume(dimension, 1);
      }

      // Write cache
      if (cfg.cacheEnabled && sem) {
        const decision = decideCachePolicy(sem, call.params, deps.cache.stats(call.toolName));
        if (decision.shouldWriteCache) {
          const key = buildCacheKey(call.toolName, call.params);
          deps.cache.set(key, output, decision.effectiveTtlMs, sem.determinism);
        }
      }

      return {
        callId: call.id,
        toolName: call.toolName,
        success: true,
        output,
        durationMs,
        fromCache: false,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      stats.totalErrors++;

      // Release reserved budget on failure
      if (dimension) {
        deps.budgetGovernor.release(dimension, 1);
      }

      const aborted = controller.signal.aborted;
      if (aborted) {
        deps.eventBus?.emit({ kind: "tool-aborted", callId: call.id, toolName: call.toolName, reason: String(controller.signal.reason) });
      }

      return {
        callId: call.id,
        toolName: call.toolName,
        success: false,
        output: { error: err instanceof Error ? err.message : String(err) },
        durationMs,
        fromCache: false,
        aborted,
      };
    } finally {
      release();
    }
  }

  return {
    dispatch,
    get stats() { return { ...stats }; },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════

function orderResults(original: ToolCall[], results: Map<string, ToolResult>): ToolResult[] {
  return original.map(call => results.get(call.id)!).filter(Boolean);
}

function mapGroupsToCalls(groups: string[][], calls: ToolCall[]): ToolCall[][] {
  const callsByName = new Map<string, ToolCall[]>();
  for (const call of calls) {
    if (!callsByName.has(call.toolName)) callsByName.set(call.toolName, []);
    callsByName.get(call.toolName)!.push(call);
  }

  const result: ToolCall[][] = [];
  for (const group of groups) {
    const groupCalls: ToolCall[] = [];
    for (const name of group) {
      const available = callsByName.get(name);
      if (available && available.length > 0) {
        groupCalls.push(available.shift()!);
      }
    }
    if (groupCalls.length > 0) result.push(groupCalls);
  }

  // 剩余未分配的（冲突分组可能漏掉重复 toolName 的 calls）
  for (const remaining of callsByName.values()) {
    for (const call of remaining) {
      // 每个单独一组，串行执行
      result.push([call]);
    }
  }

  return result;
}

function isCritical(callId: string, group: ToolCall[]): boolean {
  const call = group.find(c => c.id === callId);
  return call?.priority === "critical";
}

function inferDimension(sem: ToolSemantics | undefined): ResourceDimension | null {
  if (!sem) return null;
  if (sem.requiresNetwork) return "network-calls";
  if (sem.purity === "non-idempotent-write" || sem.purity === "destructive") return "disk-writes";
  if (sem.requiresFileSystem && sem.purity !== "pure-read") return "disk-writes";
  return null;
}
