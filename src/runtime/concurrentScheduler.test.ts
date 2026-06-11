/**
 * concurrentScheduler.test.ts — 并发调度器单测
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createConcurrentScheduler,
  type ToolCall,
  type ToolInvoker,
  type ConflictDetector,
  type SemanticRegistry,
  type SchedulerEventBus,
  type SchedulerEvent,
} from "./concurrentScheduler.js";
import { createBudgetGovernor } from "./budgetGovernor.js";
import { createToolCache } from "../tools/cachePolicy.js";
import type { ToolSemantics } from "../tools/toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════

const READ_SEMANTICS = {
  name: "read_file",
  purity: "pure-read",
  determinism: "deterministic",
  requiresNetwork: false,
  requiresFileSystem: true,
  typicalDurationMs: 10,
  cacheability: true,
  freshnessTtlMs: 30000,
  rollbackable: true,
  idempotent: true,
  requiresUserFocus: false,
  requiresBrowser: false,
  requiresDatabase: false,
  costClass: "free",
  sourceVolatility: "static",
  inputArtifacts: [],
  outputArtifacts: [],
  conflictKeys: [],
  exclusiveResources: [],
  composableAfter: [],
  composableBefore: [],
  chainable: true,
} as ToolSemantics;

const WRITE_SEMANTICS = {
  name: "write_file",
  purity: "non-idempotent-write",
  determinism: "non-deterministic",
  requiresNetwork: false,
  requiresFileSystem: true,
  typicalDurationMs: 50,
  cacheability: false,
  freshnessTtlMs: 0,
  rollbackable: true,
  idempotent: false,
  requiresUserFocus: false,
  requiresBrowser: false,
  requiresDatabase: false,
  costClass: "free",
  sourceVolatility: "fast-changing",
  inputArtifacts: [],
  outputArtifacts: [],
  conflictKeys: ["fs:write"],
  exclusiveResources: [],
  composableAfter: [],
  composableBefore: [],
  chainable: true,
} as ToolSemantics;

const NET_SEMANTICS = {
  name: "fetch_url",
  purity: "pure-read",
  determinism: "non-deterministic",
  requiresNetwork: true,
  requiresFileSystem: false,
  typicalDurationMs: 200,
  cacheability: true,
  freshnessTtlMs: 60000,
  rollbackable: false,
  idempotent: true,
  requiresUserFocus: false,
  requiresBrowser: false,
  requiresDatabase: false,
  costClass: "cheap",
  sourceVolatility: "fast-changing",
  inputArtifacts: [],
  outputArtifacts: [],
  conflictKeys: [],
  exclusiveResources: [],
  composableAfter: [],
  composableBefore: [],
  chainable: true,
} as ToolSemantics;

function createMockSemantics(): SemanticRegistry {
  const map = new Map<string, ToolSemantics>([
    ["read_file", READ_SEMANTICS],
    ["write_file", WRITE_SEMANTICS],
    ["fetch_url", NET_SEMANTICS],
  ]);
  return { get: (name) => map.get(name) };
}

function createMockConflictDetector(): ConflictDetector {
  return {
    maxParallelSet(toolNames: string[]): string[][] {
      const writes = toolNames.filter(n => n === "write_file");
      const others = toolNames.filter(n => n !== "write_file");
      const groups: string[][] = [];
      if (others.length > 0) groups.push(others);
      // writes must be serial
      for (const w of writes) groups.push([w]);
      return groups;
    },
  };
}

function makeCall(id: string, toolName: string, params: Record<string, unknown> = {}): ToolCall {
  return { id, toolName, params };
}

function createSlowInvoker(delayMs = 20): ToolInvoker {
  return async (name, params, signal) => {
    await new Promise(r => setTimeout(r, delayMs));
    if (signal.aborted) throw new Error("aborted");
    return { ok: true, output: `${name} done`, path: params.path };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("ConcurrentScheduler", () => {
  let events: SchedulerEvent[];
  let eventBus: SchedulerEventBus;

  beforeEach(() => {
    events = [];
    eventBus = { emit: (e) => events.push(e) };
  });

  it("should execute multiple reads in parallel", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    const calls: ToolCall[] = [
      makeCall("1", "read_file", { path: "/a.ts" }),
      makeCall("2", "read_file", { path: "/b.ts" }),
      makeCall("3", "read_file", { path: "/c.ts" }),
    ];

    const start = Date.now();
    const results = await scheduler.dispatch(calls, createSlowInvoker(30));
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    // 并发执行应该 < 3*30ms（串行需 90ms）
    expect(elapsed).toBeLessThan(80);
    expect(results[0].callId).toBe("1");
    expect(results[2].callId).toBe("3");
  });

  it("should serialize writes while parallelizing reads", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    const executionOrder: string[] = [];
    const invoker: ToolInvoker = async (name, params, signal) => {
      executionOrder.push(`${name}:${(params as {path?: string}).path ?? "?"}`);
      await new Promise(r => setTimeout(r, 10));
      return { ok: true, output: "done" };
    };

    const calls: ToolCall[] = [
      makeCall("r1", "read_file", { path: "a" }),
      makeCall("r2", "read_file", { path: "b" }),
      makeCall("w1", "write_file", { path: "c" }),
      makeCall("w2", "write_file", { path: "d" }),
    ];

    const results = await scheduler.dispatch(calls, invoker);
    expect(results).toHaveLength(4);

    // reads should be in same group (parallel), writes in separate groups (serial)
    const groupStartEvents = events.filter(e => e.kind === "concurrent-group-start");
    expect(groupStartEvents.length).toBeGreaterThanOrEqual(3); // 1 group for reads + 2 for writes
  });

  it("should return cached results without invoking", async () => {
    const cache = createToolCache();
    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: createBudgetGovernor(),
      cache,
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
    });

    const invoker = vi.fn(createSlowInvoker(10));

    // First call — should invoke
    const calls = [makeCall("1", "read_file", { path: "/x.ts" })];
    const r1 = await scheduler.dispatch(calls, invoker);
    expect(r1[0].success).toBe(true);
    expect(r1[0].fromCache).toBe(false);
    expect(invoker).toHaveBeenCalledTimes(1);

    // Second call — should hit cache
    const r2 = await scheduler.dispatch([makeCall("2", "read_file", { path: "/x.ts" })], invoker);
    expect(r2[0].success).toBe(true);
    expect(r2[0].fromCache).toBe(true);
    expect(invoker).toHaveBeenCalledTimes(1); // not called again

    expect(events.some(e => e.kind === "tool-cache-hit")).toBe(true);
  });

  it("should deny execution when budget is exhausted", async () => {
    const governor = createBudgetGovernor({
      buckets: {
        "llm-tokens": { allocated: 100000 },
        "network-calls": { allocated: 1, refillRate: 0 }, // only 1 allowed
        "disk-writes": { allocated: 200 },
        "cpu-time-ms": { allocated: 300000 },
        "destructive-ops": { allocated: 5 },
      },
    });

    // Exhaust network budget
    governor.consume("network-calls", 1);

    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: governor,
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    const calls = [makeCall("1", "fetch_url", { url: "https://example.com" })];
    const results = await scheduler.dispatch(calls, createSlowInvoker());

    expect(results[0].success).toBe(false);
    expect(results[0].budgetDenied).toBe(true);
    expect(events.some(e => e.kind === "tool-budget-denied")).toBe(true);
  });

  it("should respect maxConcurrency semaphore", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: { maxParallelSet: (names) => [names] }, // all parallel
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 2, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const invoker: ToolInvoker = async (name, params, signal) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 30));
      currentConcurrent--;
      return { ok: true, output: "done" };
    };

    const calls: ToolCall[] = Array.from({ length: 5 }, (_, i) =>
      makeCall(String(i), "read_file", { path: `/${i}.ts` })
    );

    await scheduler.dispatch(calls, invoker);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2); // should use full capacity
  });

  it("should abort group on critical failure", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: { maxParallelSet: (names) => [names] },
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    const invoker: ToolInvoker = async (name, params, signal) => {
      const path = (params as { path?: string }).path;
      if (path === "fail") throw new Error("critical failure");
      await new Promise(r => setTimeout(r, 100)); // long enough for abort to fire
      if (signal.aborted) throw new Error("aborted");
      return { ok: true, output: "done" };
    };

    const calls: ToolCall[] = [
      { id: "critical", toolName: "read_file", params: { path: "fail" }, priority: "critical" },
      makeCall("slow1", "read_file", { path: "ok1" }),
      makeCall("slow2", "read_file", { path: "ok2" }),
    ];

    const results = await scheduler.dispatch(calls, invoker);
    const abortedResults = results.filter(r => r.aborted);
    // critical fails, others should eventually resolve (possibly aborted)
    expect(results.find(r => r.callId === "critical")?.success).toBe(false);
    expect(events.some(e => e.kind === "tool-aborted")).toBe(true);
  });

  it("should track stats correctly", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      eventBus,
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
    });

    const calls: ToolCall[] = [
      makeCall("1", "read_file", { path: "/a" }),
      makeCall("2", "read_file", { path: "/b" }),
    ];

    await scheduler.dispatch(calls, createSlowInvoker(5));

    const stats = scheduler.stats;
    expect(stats.totalDispatched).toBe(2);
    expect(stats.totalCacheHits).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.avgConcurrency).toBeGreaterThan(0);
  });

  it("should handle empty calls gracefully", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: createMockConflictDetector(),
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
    });

    const results = await scheduler.dispatch([], createSlowInvoker());
    expect(results).toEqual([]);
  });

  it("should preserve result order matching input order", async () => {
    const scheduler = createConcurrentScheduler({
      conflictDetector: { maxParallelSet: (names) => [names] },
      budgetGovernor: createBudgetGovernor(),
      cache: createToolCache(),
      semantics: createMockSemantics(),
      config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
    });

    const invoker: ToolInvoker = async (name, params, signal) => {
      // random delay
      await new Promise(r => setTimeout(r, Math.random() * 30));
      return { ok: true, output: (params as {path?: string}).path };
    };

    const calls = Array.from({ length: 8 }, (_, i) =>
      makeCall(`id-${i}`, "read_file", { path: `/file-${i}` })
    );

    const results = await scheduler.dispatch(calls, invoker);
    expect(results.map(r => r.callId)).toEqual(calls.map(c => c.id));
  });
});
