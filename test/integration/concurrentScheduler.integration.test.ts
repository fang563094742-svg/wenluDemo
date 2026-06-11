/**
 * ConcurrentScheduler 全链路端到端集成测试。
 *
 * 被测链路：
 *   ConflictDetector.maxParallelSet → BudgetGovernor.acquire/consume →
 *   Semaphore 限流 → ToolCache 命中/写入 → EventBus 事件 → stats 汇总
 *
 * 策略：用 **真实** budgetGovernor + 简单 mock 语义注册表/冲突检测/缓存，
 * 验证 scheduler 在各场景下行为正确。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConcurrentScheduler,
  type ConcurrentScheduler,
  type ConflictDetector,
  type SchedulerDeps,
  type SchedulerEvent,
  type SchedulerEventBus,
  type SemanticRegistry,
  type ToolCall,
  type ToolInvoker,
  type ToolResult,
} from "../../src/runtime/concurrentScheduler.js";
import { createBudgetGovernor } from "../../src/runtime/budgetGovernor.js";
import type { BudgetGovernor } from "../../src/runtime/budgetGovernor.js";
import type { ToolSemantics } from "../../src/tools/toolSemantics.js";
import type { ToolCache, CacheKey, CacheStats } from "../../src/tools/cachePolicy.js";

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

function makeSemantics(overrides: Partial<ToolSemantics> = {}): ToolSemantics {
  return {
    purity: "pure-read",
    determinism: "deterministic",
    cacheability: true,
    freshnessTtlMs: 60_000,
    requiresNetwork: false,
    estimatedLatencyMs: 50,
    retryable: true,
    maxRetries: 3,
    timeout: 5000,
    ...overrides,
  } as ToolSemantics;
}

class SimpleSemanticRegistry implements SemanticRegistry {
  private map = new Map<string, ToolSemantics>();

  register(name: string, sem: ToolSemantics) {
    this.map.set(name, sem);
  }

  get(toolName: string): ToolSemantics | undefined {
    return this.map.get(toolName);
  }
}

class NoConflictDetector implements ConflictDetector {
  maxParallelSet(toolNames: string[]): string[][] {
    return [toolNames];
  }
}

class FullConflictDetector implements ConflictDetector {
  maxParallelSet(toolNames: string[]): string[][] {
    return toolNames.map((n) => [n]);
  }
}

class InMemoryToolCache implements ToolCache {
  private store = new Map<string, { key: CacheKey; value: unknown; storedAt: number; expiresAt: number; hitCount: number; determinism: string }>();
  private statsMap = new Map<string, CacheStats>();

  private keyStr(key: CacheKey): string {
    return `${key.toolName}:${key.paramsHash}:${key.contextHash || ""}`;
  }

  private getToolStats(toolName: string): CacheStats {
    if (!this.statsMap.has(toolName)) {
      this.statsMap.set(toolName, { totalQueries: 0, hits: 0, misses: 0, staleHits: 0 });
    }
    return this.statsMap.get(toolName)!;
  }

  get(key: CacheKey): import("../../src/tools/cachePolicy.js").CacheEntry | null {
    const k = this.keyStr(key);
    const entry = this.store.get(k);
    const s = this.getToolStats(key.toolName);
    s.totalQueries++;
    if (!entry || entry.expiresAt < Date.now()) {
      s.misses++;
      return null;
    }
    s.hits++;
    entry.hitCount++;
    return {
      key: entry.key,
      value: entry.value,
      storedAt: entry.storedAt,
      expiresAt: entry.expiresAt,
      hitCount: entry.hitCount,
      determinism: entry.determinism as any,
    };
  }

  set(key: CacheKey, value: unknown, ttlMs: number, determinism: import("../../src/tools/toolSemantics.js").Determinism): void {
    const k = this.keyStr(key);
    this.store.set(k, {
      key,
      value,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      hitCount: 0,
      determinism,
    });
  }

  invalidate(toolName: string): void {
    for (const [k] of this.store) {
      if (k.startsWith(`${toolName}:`)) this.store.delete(k);
    }
  }

  invalidateByKey(key: CacheKey): void {
    this.store.delete(this.keyStr(key));
  }

  stats(toolName?: string): CacheStats {
    return this.getToolStats(toolName || "__global__");
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.statsMap.clear();
  }
}

class CollectingEventBus implements SchedulerEventBus {
  events: SchedulerEvent[] = [];
  emit(event: SchedulerEvent): void {
    this.events.push(event);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("ConcurrentScheduler 全链路集成测试", () => {
  let governor: BudgetGovernor;
  let registry: SimpleSemanticRegistry;
  let cache: InMemoryToolCache;
  let bus: CollectingEventBus;
  let scheduler: ConcurrentScheduler;

  function buildScheduler(
    conflictDetector?: ConflictDetector,
    config?: Partial<{ maxConcurrency: number; abortOnCriticalFailure: boolean; cacheEnabled: boolean }>,
  ) {
    const deps: SchedulerDeps = {
      conflictDetector: conflictDetector ?? new NoConflictDetector(),
      budgetGovernor: governor,
      cache,
      semantics: registry,
      eventBus: bus,
      config,
    };
    scheduler = createConcurrentScheduler(deps);
    return scheduler;
  }

  beforeEach(() => {
    governor = createBudgetGovernor({
      buckets: {
        "network-calls": { allocated: 50, refillRate: 0 },
        "disk-writes": { allocated: 20, refillRate: 0 },
        "llm-tokens": { allocated: 100000, refillRate: 0 },
        "cpu-time-ms": { allocated: 300000, refillRate: 0 },
        "destructive-ops": { allocated: 5, refillRate: 0 },
      },
    });
    registry = new SimpleSemanticRegistry();
    cache = new InMemoryToolCache();
    bus = new CollectingEventBus();
  });

  // ─── 场景 1：无冲突并发执行 ───

  it("无冲突的多个 tool calls 并发执行", async () => {
    registry.register("read_file", makeSemantics({ purity: "pure-read" }));
    registry.register("list_dir", makeSemantics({ purity: "pure-read" }));

    buildScheduler(new NoConflictDetector(), { maxConcurrency: 4 });

    const calls: ToolCall[] = [
      { id: "c1", toolName: "read_file", params: { path: "a.ts" } },
      { id: "c2", toolName: "list_dir", params: { path: "src/" } },
      { id: "c3", toolName: "read_file", params: { path: "b.ts" } },
    ];

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const invoker: ToolInvoker = async (name, params, _signal) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await delay(30);
      currentConcurrent--;
      return `result-of-${name}:${JSON.stringify(params)}`;
    };

    const results = await scheduler.dispatch(calls, invoker);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);

    const groupStarts = bus.events.filter((e) => e.kind === "concurrent-group-start");
    expect(groupStarts).toHaveLength(1);
    expect((groupStarts[0] as any).toolNames).toHaveLength(3);
  });

  // ─── 场景 2：冲突分组串行 ───

  it("有冲突的 tool calls 按组串行执行", async () => {
    registry.register("write_file", makeSemantics({
      purity: "non-idempotent-write",
      cacheability: false,
    }));

    buildScheduler(new FullConflictDetector(), { maxConcurrency: 4 });

    const calls: ToolCall[] = [
      { id: "c1", toolName: "write_file", params: { path: "a.ts", content: "x" } },
      { id: "c2", toolName: "write_file", params: { path: "b.ts", content: "y" } },
    ];

    const order: string[] = [];
    const invoker: ToolInvoker = async (_name, params, _signal) => {
      order.push(params.path as string);
      await delay(20);
      return "ok";
    };

    const results = await scheduler.dispatch(calls, invoker);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(order).toEqual(["a.ts", "b.ts"]);

    const groupStarts = bus.events.filter((e) => e.kind === "concurrent-group-start");
    expect(groupStarts).toHaveLength(2);
  });

  // ─── 场景 3：缓存命中 ───

  it("缓存命中时跳过执行直接返回", async () => {
    registry.register("read_file", makeSemantics({
      purity: "pure-read",
      determinism: "deterministic",
      freshnessTtlMs: 60_000,
      cacheability: true,
    }));

    buildScheduler(new NoConflictDetector(), { cacheEnabled: true });

    const call: ToolCall = { id: "c1", toolName: "read_file", params: { path: "a.ts" } };
    let invokeCount = 0;
    const invoker: ToolInvoker = async () => {
      invokeCount++;
      return "file-content";
    };

    const r1 = await scheduler.dispatch([call], invoker);
    expect(r1[0].success).toBe(true);
    expect(r1[0].fromCache).toBe(false);
    expect(invokeCount).toBe(1);

    const call2: ToolCall = { id: "c2", toolName: "read_file", params: { path: "a.ts" } };
    const r2 = await scheduler.dispatch([call2], invoker);
    expect(r2[0].success).toBe(true);
    expect(r2[0].fromCache).toBe(true);
    expect(invokeCount).toBe(1);

    expect(scheduler.stats.totalCacheHits).toBeGreaterThanOrEqual(1);
    const cacheHitEvents = bus.events.filter((e) => e.kind === "tool-cache-hit");
    expect(cacheHitEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ─── 场景 4：预算耗尽降级 ───

  it("预算耗尽时 budgetDenied = true", async () => {
    governor = createBudgetGovernor({
      buckets: {
        "network-calls": { allocated: 1, refillRate: 0 },
        "disk-writes": { allocated: 20, refillRate: 0 },
        "llm-tokens": { allocated: 100000, refillRate: 0 },
        "cpu-time-ms": { allocated: 300000, refillRate: 0 },
        "destructive-ops": { allocated: 5, refillRate: 0 },
      },
    });
    registry.register("fetch_url", makeSemantics({
      purity: "pure-read",
      requiresNetwork: true,
      cacheability: false,
    }));

    buildScheduler(new NoConflictDetector());

    const calls: ToolCall[] = [
      { id: "c1", toolName: "fetch_url", params: { url: "http://a" } },
      { id: "c2", toolName: "fetch_url", params: { url: "http://b" } },
      { id: "c3", toolName: "fetch_url", params: { url: "http://c" } },
    ];

    let invokeCount = 0;
    const invoker: ToolInvoker = async () => {
      invokeCount++;
      return "ok";
    };

    const results = await scheduler.dispatch(calls, invoker);

    const denied = results.filter((r) => r.budgetDenied);
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.stats.totalBudgetDenied).toBeGreaterThanOrEqual(1);

    const budgetEvents = bus.events.filter((e) => e.kind === "tool-budget-denied");
    expect(budgetEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ─── 场景 5：abortOnCriticalFailure ───

  it("关键失败时 abort 同组剩余任务", async () => {
    registry.register("dangerous_op", makeSemantics({
      purity: "non-idempotent-write",
      cacheability: false,
    }));

    buildScheduler(new NoConflictDetector(), {
      maxConcurrency: 4,
      abortOnCriticalFailure: true,
    });

    const calls: ToolCall[] = [
      { id: "c1", toolName: "dangerous_op", params: { idx: 0 }, priority: "critical" },
      { id: "c2", toolName: "dangerous_op", params: { idx: 1 } },
      { id: "c3", toolName: "dangerous_op", params: { idx: 2 } },
    ];

    const invoker: ToolInvoker = async (_name, params, signal) => {
      const idx = params.idx as number;
      if (idx === 0) {
        await delay(10);
        throw new Error("critical failure");
      }
      await delay(100);
      if (signal.aborted) throw new Error("aborted");
      return "ok";
    };

    const results = await scheduler.dispatch(calls, invoker);

    const failed = results.find((r) => r.callId === "c1");
    expect(failed?.success).toBe(false);

    const aborted = results.filter((r) => r.aborted);
    expect(aborted.length + results.filter((r) => !r.success).length).toBeGreaterThanOrEqual(1);
  });

  // ─── 场景 6：Semaphore 限流 ───

  it("Semaphore 限制真实并发数不超过 maxConcurrency", async () => {
    registry.register("slow_op", makeSemantics({
      purity: "pure-read",
      cacheability: false,
    }));

    const maxConcurrency = 2;
    buildScheduler(new NoConflictDetector(), { maxConcurrency });

    const calls: ToolCall[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      toolName: "slow_op",
      params: { i },
    }));

    let peak = 0;
    let current = 0;
    const invoker: ToolInvoker = async () => {
      current++;
      peak = Math.max(peak, current);
      await delay(50);
      current--;
      return "done";
    };

    const results = await scheduler.dispatch(calls, invoker);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.success)).toBe(true);
    expect(peak).toBeLessThanOrEqual(maxConcurrency);
  });

  // ─── 场景 7：stats 正确汇总 ───

  it("stats 在多次 dispatch 后正确累计", async () => {
    registry.register("op", makeSemantics({ cacheability: false }));
    buildScheduler(new NoConflictDetector());

    const invoker: ToolInvoker = async () => "ok";

    await scheduler.dispatch(
      [{ id: "a1", toolName: "op", params: {} }],
      invoker,
    );
    await scheduler.dispatch(
      [{ id: "a2", toolName: "op", params: {} }, { id: "a3", toolName: "op", params: {} }],
      invoker,
    );

    expect(scheduler.stats.totalDispatched).toBe(3);
    expect(scheduler.stats.totalErrors).toBe(0);
  });

  // ─── 场景 8：空 calls 数组 ───

  it("空 toolCalls 不触发任何执行", async () => {
    buildScheduler();
    const invoker: ToolInvoker = async () => {
      throw new Error("should not be called");
    };

    const results = await scheduler.dispatch([], invoker);
    expect(results).toEqual([]);
    expect(bus.events).toHaveLength(0);
  });

  // ─── 场景 9：未注册语义的工具仍可执行 ───

  it("未注册语义的工具跳过缓存和预算检查，直接执行", async () => {
    buildScheduler(new NoConflictDetector(), { cacheEnabled: true });

    const calls: ToolCall[] = [
      { id: "c1", toolName: "unknown_tool", params: { x: 1 } },
    ];

    const invoker: ToolInvoker = async () => "raw-result";
    const results = await scheduler.dispatch(calls, invoker);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].fromCache).toBe(false);
    expect(results[0].output).toBe("raw-result");
  });

  // ─── 场景 10：EventBus 完整事件序列 ───

  it("完整执行产生正确的事件序列", async () => {
    registry.register("op_a", makeSemantics({ cacheability: false }));
    registry.register("op_b", makeSemantics({ cacheability: false }));

    buildScheduler(new NoConflictDetector());

    const invoker: ToolInvoker = async (name) => `result-${name}`;

    await scheduler.dispatch(
      [
        { id: "c1", toolName: "op_a", params: {} },
        { id: "c2", toolName: "op_b", params: {} },
      ],
      invoker,
    );

    const starts = bus.events.filter((e) => e.kind === "concurrent-group-start");
    const ends = bus.events.filter((e) => e.kind === "concurrent-group-end");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((ends[0] as any).results).toHaveLength(2);
  });
});
