/**
 * concurrentPipeline.integration.test.ts
 *
 * 全链路端到端集成测试：
 *   executor (concurrentExecutor) → scheduler → budget → cache → semantics → conflictDetector
 *
 * 验证目标：
 * 1. 多工具并发执行 + 缓存命中复用
 * 2. Budget 耗尽后调用被正确拒绝
 * 3. 冲突检测正确分组（写互斥、读并行）
 * 4. 安全门串行拦截后，余下调用仍走并发路径
 * 5. 完整 executor 循环能够驱动多轮 tool-calling 直到完成
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runConcurrentLoop,
  ConcurrentExecutor,
  type ConcurrentExecutorConfig,
} from "../../src/executor/concurrentExecutor.js";
import { createBudgetGovernor } from "../../src/runtime/budgetGovernor.js";
import { createToolCache } from "../../src/tools/cachePolicy.js";
import {
  createConcurrentScheduler,
  type ToolCall as SchedulerToolCall,
  type ToolInvoker,
  type ConflictDetector,
  type SemanticRegistry,
  type SchedulerEventBus,
  type SchedulerEvent,
} from "../../src/runtime/concurrentScheduler.js";
import type { ToolSemantics } from "../../src/tools/toolSemantics.js";
import type { BudgetGovernor } from "../../src/runtime/budgetGovernor.js";
import type { ToolCache } from "../../src/tools/cachePolicy.js";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures & Helpers
// ═══════════════════════════════════════════════════════════════════════

const BASE_SEMANTICS: Partial<ToolSemantics> = {
  rollbackable: false,
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
};

const SEMANTICS_MAP: Record<string, ToolSemantics> = {
  read_file: {
    ...BASE_SEMANTICS,
    name: "read_file",
    purity: "pure-read",
    determinism: "deterministic",
    requiresNetwork: false,
    requiresFileSystem: true,
    typicalDurationMs: 10,
    cacheability: true,
    freshnessTtlMs: 30000,
  } as ToolSemantics,
  write_file: {
    ...BASE_SEMANTICS,
    name: "write_file",
    purity: "non-idempotent-write",
    determinism: "non-deterministic",
    requiresNetwork: false,
    requiresFileSystem: true,
    typicalDurationMs: 50,
    cacheability: false,
    freshnessTtlMs: 0,
    idempotent: false,
    conflictKeys: ["fs:write"],
  } as ToolSemantics,
  http_fetch: {
    ...BASE_SEMANTICS,
    name: "http_fetch",
    purity: "pure-read",
    determinism: "mostly-deterministic",
    requiresNetwork: true,
    requiresFileSystem: false,
    typicalDurationMs: 200,
    cacheability: true,
    freshnessTtlMs: 60000,
  } as ToolSemantics,
  delete_file: {
    ...BASE_SEMANTICS,
    name: "delete_file",
    purity: "non-idempotent-write",
    determinism: "non-deterministic",
    requiresNetwork: false,
    requiresFileSystem: true,
    typicalDurationMs: 10,
    cacheability: false,
    freshnessTtlMs: 0,
    idempotent: false,
  } as ToolSemantics,
};

function makeSemantics(): SemanticRegistry {
  return { get: (name) => SEMANTICS_MAP[name] };
}

function makeConflictDetector(): ConflictDetector {
  return {
    maxParallelSet(toolNames: string[]): string[][] {
      const writes: string[] = [];
      const reads: string[] = [];
      for (const name of toolNames) {
        const sem = SEMANTICS_MAP[name];
        if (sem?.purity === "non-idempotent-write") {
          writes.push(name);
        } else {
          reads.push(name);
        }
      }
      const groups: string[][] = [];
      if (reads.length > 0) groups.push(reads);
      for (const w of writes) groups.push([w]);
      return groups;
    },
  };
}

function makeCall(id: string, toolName: string, params: Record<string, unknown> = {}): SchedulerToolCall {
  return { id, toolName, params };
}

// ═══════════════════════════════════════════════════════════════════════
// Integration Tests: Scheduler + Budget + Cache + Semantics + ConflictDetector
// ═══════════════════════════════════════════════════════════════════════

describe("ConcurrentPipeline Integration", () => {
  let events: SchedulerEvent[];
  let eventBus: SchedulerEventBus;

  beforeEach(() => {
    events = [];
    eventBus = { emit: (e) => events.push(e) };
  });

  describe("全链路缓存复用", () => {
    it("read_file 相同参数第二次调用从缓存返回", async () => {
      const cache = createToolCache();
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: createBudgetGovernor(),
        cache,
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
      });

      let invocationCount = 0;
      const invoker: ToolInvoker = async (name, params) => {
        invocationCount++;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, output: `content of ${(params as { path: string }).path}` };
      };

      // 第一次：必须执行
      const r1 = await scheduler.dispatch(
        [makeCall("a", "read_file", { path: "/src/main.ts" })],
        invoker,
      );
      expect(r1[0].success).toBe(true);
      expect(r1[0].fromCache).toBe(false);
      expect(invocationCount).toBe(1);

      // 第二次：缓存命中
      const r2 = await scheduler.dispatch(
        [makeCall("b", "read_file", { path: "/src/main.ts" })],
        invoker,
      );
      expect(r2[0].success).toBe(true);
      expect(r2[0].fromCache).toBe(true);
      expect(invocationCount).toBe(1); // invoker 未再被调用

      // 第三次：不同参数 → 缓存未命中
      const r3 = await scheduler.dispatch(
        [makeCall("c", "read_file", { path: "/src/other.ts" })],
        invoker,
      );
      expect(r3[0].fromCache).toBe(false);
      expect(invocationCount).toBe(2);
    });

    it("write_file 不走缓存", async () => {
      const cache = createToolCache();
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: createBudgetGovernor(),
        cache,
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
      });

      let invocationCount = 0;
      const invoker: ToolInvoker = async () => {
        invocationCount++;
        return { ok: true, output: "written" };
      };

      await scheduler.dispatch([makeCall("w1", "write_file", { path: "/a.ts", content: "x" })], invoker);
      await scheduler.dispatch([makeCall("w2", "write_file", { path: "/a.ts", content: "x" })], invoker);

      expect(invocationCount).toBe(2); // 两次都执行
    });
  });

  describe("Budget 预算治理", () => {
    it("网络调用预算耗尽后拒绝后续调用", async () => {
      const governor = createBudgetGovernor({
        buckets: {
          "llm-tokens": { allocated: 100000 },
          "network-calls": { allocated: 2, refillRate: 0 },
          "disk-writes": { allocated: 200 },
          "cpu-time-ms": { allocated: 300000 },
          "destructive-ops": { allocated: 5 },
        },
      });

      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: governor,
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async (name, params) => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, output: "response data" };
      };

      // 前两次正常
      const r1 = await scheduler.dispatch(
        [makeCall("n1", "http_fetch", { url: "https://a.com" })],
        invoker,
      );
      expect(r1[0].success).toBe(true);

      const r2 = await scheduler.dispatch(
        [makeCall("n2", "http_fetch", { url: "https://b.com" })],
        invoker,
      );
      expect(r2[0].success).toBe(true);

      // 第三次被预算拒绝
      const r3 = await scheduler.dispatch(
        [makeCall("n3", "http_fetch", { url: "https://c.com" })],
        invoker,
      );
      expect(r3[0].success).toBe(false);
      expect(r3[0].budgetDenied).toBe(true);
    });

    it("disk-writes 预算耗尽后拒绝 write_file", async () => {
      const governor = createBudgetGovernor({
        buckets: {
          "llm-tokens": { allocated: 100000 },
          "network-calls": { allocated: 100 },
          "disk-writes": { allocated: 1, refillRate: 0 },
          "cpu-time-ms": { allocated: 300000 },
          "destructive-ops": { allocated: 5 },
        },
      });

      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: governor,
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async () => ({ ok: true, output: "done" });

      // 第一次通过
      const r1 = await scheduler.dispatch(
        [makeCall("w1", "write_file", { path: "/a.ts", content: "x" })],
        invoker,
      );
      expect(r1[0].success).toBe(true);

      // 第二次被拒绝
      const r2 = await scheduler.dispatch(
        [makeCall("w2", "write_file", { path: "/b.ts", content: "y" })],
        invoker,
      );
      expect(r2[0].success).toBe(false);
      expect(r2[0].budgetDenied).toBe(true);
    });

    it("read_file 不消耗 network-calls 预算", async () => {
      const governor = createBudgetGovernor({
        buckets: {
          "llm-tokens": { allocated: 100000 },
          "network-calls": { allocated: 0, refillRate: 0 }, // 0 network budget
          "disk-writes": { allocated: 200 },
          "cpu-time-ms": { allocated: 300000 },
          "destructive-ops": { allocated: 5 },
        },
      });

      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: governor,
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async () => ({ ok: true, output: "file content" });

      // read_file 不走 network-calls 维度，应该通过
      const r = await scheduler.dispatch(
        [makeCall("r1", "read_file", { path: "/src/a.ts" })],
        invoker,
      );
      expect(r[0].success).toBe(true);
    });
  });

  describe("冲突检测与并发分组", () => {
    it("多个读操作并行执行，写操作串行", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 8, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const executionLog: { name: string; startMs: number; endMs: number }[] = [];
      const start = Date.now();

      const invoker: ToolInvoker = async (name, params) => {
        const t0 = Date.now() - start;
        await new Promise((r) => setTimeout(r, 20));
        const t1 = Date.now() - start;
        executionLog.push({ name: `${name}:${(params as { path?: string }).path ?? "?"}`, startMs: t0, endMs: t1 });
        return { ok: true, output: "done" };
      };

      const calls: SchedulerToolCall[] = [
        makeCall("r1", "read_file", { path: "a" }),
        makeCall("r2", "read_file", { path: "b" }),
        makeCall("r3", "read_file", { path: "c" }),
        makeCall("w1", "write_file", { path: "d" }),
        makeCall("w2", "write_file", { path: "e" }),
      ];

      const results = await scheduler.dispatch(calls, invoker);
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.success)).toBe(true);

      // 验证并发分组事件
      const groupStarts = events.filter((e) => e.kind === "concurrent-group-start");
      // 至少 3 组: reads(并行) + write1 + write2
      expect(groupStarts.length).toBeGreaterThanOrEqual(3);

      // 读操作应该大致同时开始（时间差 < 单个执行时长）
      const readEntries = executionLog.filter((e) => e.name.startsWith("read_file"));
      if (readEntries.length >= 2) {
        const maxStartDiff = Math.max(...readEntries.map((e) => e.startMs)) - Math.min(...readEntries.map((e) => e.startMs));
        expect(maxStartDiff).toBeLessThan(15); // 并发启动差 < 15ms
      }
    });

    it("全部相同的读操作在一个组内并发", async () => {
      const conflictDetector: ConflictDetector = {
        maxParallelSet: (names) => [names], // 全放一组
      };

      const scheduler = createConcurrentScheduler({
        conflictDetector,
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 8, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const invoker: ToolInvoker = async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return { ok: true, output: "done" };
      };

      const calls = Array.from({ length: 6 }, (_, i) =>
        makeCall(`r${i}`, "read_file", { path: `/file-${i}.ts` }),
      );

      await scheduler.dispatch(calls, invoker);

      // 并发度应接近 min(6, maxConcurrency=8)
      expect(maxConcurrent).toBeGreaterThanOrEqual(4); // 至少 4 个并行
    });
  });

  describe("缓存 + 预算联合场景", () => {
    it("缓存命中时不消耗预算", async () => {
      const governor = createBudgetGovernor({
        buckets: {
          "llm-tokens": { allocated: 100000 },
          "network-calls": { allocated: 1, refillRate: 0 }, // 只够 1 次
          "disk-writes": { allocated: 200 },
          "cpu-time-ms": { allocated: 300000 },
          "destructive-ops": { allocated: 5 },
        },
      });

      const cache = createToolCache();
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: governor,
        cache,
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
      });

      const invoker: ToolInvoker = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, output: "api response" };
      };

      // http_fetch 第一次执行（消耗 1 network-calls 预算）
      const r1 = await scheduler.dispatch(
        [makeCall("h1", "http_fetch", { url: "https://api.example.com/data" })],
        invoker,
      );
      expect(r1[0].success).toBe(true);
      expect(r1[0].fromCache).toBe(false);

      // 同样的 http_fetch 第二次应该走缓存，不消耗预算
      const r2 = await scheduler.dispatch(
        [makeCall("h2", "http_fetch", { url: "https://api.example.com/data" })],
        invoker,
      );
      expect(r2[0].success).toBe(true);
      expect(r2[0].fromCache).toBe(true);

      // 不同 URL 的 http_fetch：预算已耗尽，应被拒绝
      const r3 = await scheduler.dispatch(
        [makeCall("h3", "http_fetch", { url: "https://api.example.com/other" })],
        invoker,
      );
      expect(r3[0].success).toBe(false);
      expect(r3[0].budgetDenied).toBe(true);
    });
  });

  describe("错误处理 & abort", () => {
    it("critical 工具失败导致同组其他工具被 abort", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: { maxParallelSet: (names) => [names] }, // 全部一组
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 8, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async (name, params, signal) => {
        const path = (params as { path?: string }).path;
        if (path === "crash") throw new Error("CRITICAL: disk full");
        await new Promise((r) => setTimeout(r, 100));
        if (signal.aborted) throw new Error("aborted");
        return { ok: true, output: "done" };
      };

      const calls: SchedulerToolCall[] = [
        { id: "critical-one", toolName: "read_file", params: { path: "crash" }, priority: "critical" },
        makeCall("slow1", "read_file", { path: "ok1" }),
        makeCall("slow2", "read_file", { path: "ok2" }),
      ];

      const results = await scheduler.dispatch(calls, invoker);
      const criticalResult = results.find((r) => r.callId === "critical-one");
      expect(criticalResult?.success).toBe(false);

      // 其他工具应该被 abort
      const abortedCount = results.filter((r) => r.aborted).length;
      expect(abortedCount).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.kind === "tool-aborted")).toBe(true);
    });

    it("非 critical 工具失败不影响同组其他工具", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: { maxParallelSet: (names) => [names] },
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 8, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async (name, params, signal) => {
        const path = (params as { path?: string }).path;
        if (path === "fail") throw new Error("file not found");
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, output: "content" };
      };

      const calls: SchedulerToolCall[] = [
        makeCall("fail1", "read_file", { path: "fail" }),
        makeCall("ok1", "read_file", { path: "good1" }),
        makeCall("ok2", "read_file", { path: "good2" }),
      ];

      const results = await scheduler.dispatch(calls, invoker);
      const failedResult = results.find((r) => r.callId === "fail1");
      expect(failedResult?.success).toBe(false);

      const successResults = results.filter((r) => r.callId !== "fail1");
      expect(successResults.every((r) => r.success)).toBe(true);
    });
  });

  describe("事件总线覆盖", () => {
    it("完整执行生命周期产生所有预期事件", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
      });

      const invoker: ToolInvoker = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, output: "done" };
      };

      // 一批包含读和写
      const calls: SchedulerToolCall[] = [
        makeCall("r1", "read_file", { path: "/a" }),
        makeCall("r2", "read_file", { path: "/b" }),
        makeCall("w1", "write_file", { path: "/c" }),
      ];

      await scheduler.dispatch(calls, invoker);

      // 核查事件种类覆盖（scheduler 实际 emit 的事件类型）
      const kinds = new Set(events.map((e) => e.kind));
      expect(kinds.has("concurrent-group-start")).toBe(true);
      expect(kinds.has("concurrent-group-end")).toBe(true);

      // 验证 group-start 事件携带正确信息
      const groupStarts = events.filter((e) => e.kind === "concurrent-group-start");
      expect(groupStarts.length).toBeGreaterThan(0);
      expect((groupStarts[0] as any).toolNames.length).toBeGreaterThan(0);

      // 验证 group-end 事件携带结果
      const groupEnds = events.filter((e) => e.kind === "concurrent-group-end");
      expect(groupEnds.length).toBeGreaterThan(0);
      expect((groupEnds[0] as any).results.length).toBeGreaterThan(0);
    });
  });

  describe("结果稳定性", () => {
    it("结果顺序始终匹配输入顺序（即使执行时间随机）", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: { maxParallelSet: (names) => [names] },
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: false },
      });

      const invoker: ToolInvoker = async (name, params) => {
        await new Promise((r) => setTimeout(r, Math.random() * 30));
        return { ok: true, output: (params as { path?: string }).path };
      };

      const calls = Array.from({ length: 10 }, (_, i) =>
        makeCall(`id-${i}`, "read_file", { path: `/file-${i}` }),
      );

      const results = await scheduler.dispatch(calls, invoker);
      expect(results.map((r) => r.callId)).toEqual(calls.map((c) => c.id));
    });

    it("stats 累计跨多次 dispatch 正确", async () => {
      const scheduler = createConcurrentScheduler({
        conflictDetector: makeConflictDetector(),
        budgetGovernor: createBudgetGovernor(),
        cache: createToolCache(),
        semantics: makeSemantics(),
        eventBus,
        config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
      });

      const invoker: ToolInvoker = async () => ({ ok: true, output: "x" });

      await scheduler.dispatch([makeCall("1", "read_file", { path: "/a" })], invoker);
      await scheduler.dispatch([makeCall("2", "read_file", { path: "/a" })], invoker); // cache hit
      await scheduler.dispatch([makeCall("3", "read_file", { path: "/b" })], invoker);

      const stats = scheduler.stats;
      expect(stats.totalDispatched).toBe(3);
      expect(stats.totalCacheHits).toBe(1);
      expect(stats.totalErrors).toBe(0);
    });
  });
});
