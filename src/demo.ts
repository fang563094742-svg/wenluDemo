/**
 * demo.ts — 全链路端到端演示。
 *
 * 展示 SemanticRegistry → BudgetGovernor → ConflictDetector → ConcurrentScheduler
 * 完整协作流程。
 *
 * 运行: npx tsx src/demo.ts
 */

import { createSemanticRegistry } from "./tools/semanticRegistry.js";
import type { RegisteredTool, ToolSpec, ToolHandler } from "./tools/semanticRegistry.js";
import type { ToolSemantics } from "./tools/toolSemantics.js";
import { createConflictDetector } from "./tools/conflictDetector.js";
import { createBudgetGovernor } from "./runtime/budgetGovernor.js";
import { createToolCache } from "./tools/cachePolicy.js";
import {
  createConcurrentScheduler,
  type ToolCall,
  type ToolResult,
  type ToolInvoker,
  type SchedulerEvent,
} from "./runtime/concurrentScheduler.js";

// ═══════════════════════════════════════════════════════════════════════
// 1. 构建语义注册表 + 注册工具
// ═══════════════════════════════════════════════════════════════════════

const registry = createSemanticRegistry();

function makeSpec(name: string, desc: string): ToolSpec {
  return { name, description: desc, parameters: [] };
}

function makeSemantics(overrides: Partial<ToolSemantics> & { name: string }): ToolSemantics {
  return {
    purity: "pure-read",
    rollbackable: false,
    idempotent: true,
    determinism: "deterministic",
    cacheability: true,
    freshnessTtlMs: 30000,
    sourceVolatility: "slow-changing",
    inputArtifacts: [],
    outputArtifacts: [],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 50,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: [],
    chainable: true,
    ...overrides,
  };
}

function fakeHandler(name: string, delayMs: number): ToolHandler {
  return async (_args: Record<string, unknown>) => {
    await sleep(delayMs);
    return { tool: name, result: `${name} executed successfully` };
  };
}

function registerTool(name: string, desc: string, semanticsOverrides: Partial<ToolSemantics>, delayMs = 50): void {
  const tool: RegisteredTool = {
    spec: makeSpec(name, desc),
    semantics: makeSemantics({ name, ...semanticsOverrides }),
    handler: fakeHandler(name, delayMs),
    source: "builtin",
    registeredAt: new Date().toISOString(),
  };
  registry.register(tool);
}

// 注册 5 个模拟工具
registerTool("read_file", "读取文件内容", {
  purity: "pure-read",
  cacheability: true,
  freshnessTtlMs: 30000,
  outputArtifacts: [{ kind: "file-content" }],
});

registerTool("write_file", "写入文件", {
  purity: "idempotent-write",
  cacheability: false,
  freshnessTtlMs: 0,
  conflictKeys: ["filesystem-write"],
  inputArtifacts: [{ kind: "file-content" }],
  chainable: false,
}, 100);

registerTool("web_search", "网络搜索", {
  purity: "pure-read",
  determinism: "non-deterministic",
  cacheability: true,
  freshnessTtlMs: 300000,
  sourceVolatility: "fast-changing",
  requiresNetwork: true,
  costClass: "moderate",
  typicalDurationMs: 500,
  outputArtifacts: [{ kind: "search-results" }],
}, 200);

registerTool("execute_command", "执行 shell 命令", {
  purity: "non-idempotent-write",
  determinism: "non-deterministic",
  cacheability: false,
  freshnessTtlMs: 0,
  sourceVolatility: "real-time",
  conflictKeys: ["shell-session"],
  costClass: "moderate",
  typicalDurationMs: 1000,
}, 150);

registerTool("list_files", "列出目录文件", {
  purity: "pure-read",
  cacheability: true,
  freshnessTtlMs: 10000,
  sourceVolatility: "slow-changing",
  outputArtifacts: [{ kind: "directory-listing" }],
}, 30);

console.log(`\n[1] 注册表: ${registry.all().length} 个工具`);
console.log(`    可缓存: ${registry.findCacheable().map(t => t.spec.name).join(", ")}`);
console.log(`    纯读: ${registry.findPureRead().map(t => t.spec.name).join(", ")}`);

// ═══════════════════════════════════════════════════════════════════════
// 2. 冲突检测
// ═══════════════════════════════════════════════════════════════════════

const detector = createConflictDetector(registry);

console.log(`\n[2] 冲突检测:`);
const conflict1 = detector.check("read_file", "list_files");
console.log(`    read_file vs list_files: ${conflict1.canParallel ? "可并行" : "冲突"}`);

const conflict2 = detector.check("write_file", "execute_command");
console.log(`    write_file vs execute_command: ${conflict2.canParallel ? "可并行" : "冲突"} (${conflict2.reasons.map(r => r.conflictKey || r.exclusiveResource || "side-effects").join(",")})`);

const groups = detector.maxParallelSet(["read_file", "write_file", "web_search", "list_files", "execute_command"]);
console.log(`    最大并行分组: ${groups.map(g => `[${g.join(",")}]`).join(" → ")}`);

// ═══════════════════════════════════════════════════════════════════════
// 3. 预算治理
// ═══════════════════════════════════════════════════════════════════════

const governor = createBudgetGovernor({
  buckets: {
    "llm-tokens": { allocated: 100000, refillRate: 0 },
    "network-calls": { allocated: 20, refillRate: 5 },
    "disk-writes": { allocated: 50, refillRate: 10 },
    "cpu-time-ms": { allocated: 60000, refillRate: 0 },
    "destructive-ops": { allocated: 5, refillRate: 0 },
  },
});

console.log(`\n[3] 预算治理:`);
const snapshot1 = governor.snapshot();
console.log(`    初始: disk-writes=${snapshot1.buckets.find(b => b.dimension === "disk-writes")?.allocated ?? "N/A"}, llm-tokens=${snapshot1.buckets.find(b => b.dimension === "llm-tokens")?.allocated ?? "N/A"}`);

const acq1 = governor.acquire({ dimension: "disk-writes", amount: 3, source: "demo", priority: "normal" });
console.log(`    申请 3 disk-writes: ${acq1.granted ? "通过" : "拒绝"}`);

const acq2 = governor.acquire({ dimension: "network-calls", amount: 25, source: "demo", priority: "normal" });
console.log(`    申请 25 network-calls: ${acq2.granted ? "通过" : "拒绝"} (超额)`);

const snap2 = governor.snapshot();
console.log(`    降级等级: ${snap2.tier}`);

// ═══════════════════════════════════════════════════════════════════════
// 4. 并发调度（核心演示）
// ═══════════════════════════════════════════════════════════════════════

const cache = createToolCache(100);

const events: SchedulerEvent[] = [];
const eventBus = {
  emit(event: SchedulerEvent) {
    events.push(event);
  },
};

const scheduler = createConcurrentScheduler({
  conflictDetector: detector,
  budgetGovernor: governor,
  cache,
  semantics: { get: (name: string) => registry.getSemantics(name) },
  eventBus,
  config: { maxConcurrency: 4, abortOnCriticalFailure: true, cacheEnabled: true },
});

const invoker: ToolInvoker = async (toolName, params, _signal) => {
  const tool = registry.get(toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  return tool.handler(params);
};

const toolCalls: ToolCall[] = [
  { id: "call-1", toolName: "read_file", params: { path: "/src/index.ts" } },
  { id: "call-2", toolName: "list_files", params: { dir: "/src" } },
  { id: "call-3", toolName: "web_search", params: { query: "TypeScript best practices" } },
  { id: "call-4", toolName: "write_file", params: { path: "/tmp/out.txt", content: "hello" } },
  { id: "call-5", toolName: "execute_command", params: { cmd: "echo hello" } },
];

async function runDemo() {
  console.log(`\n[4] 并发调度 (${toolCalls.length} 个 tool calls):`);
  const start = Date.now();

  const results = await scheduler.dispatch(toolCalls, invoker);
  const elapsed = Date.now() - start;

  console.log(`    完成! 耗时 ${elapsed}ms`);
  console.log(`    结果:`);
  for (const r of results) {
    const status = r.success ? "OK" : r.budgetDenied ? "BUDGET_DENIED" : r.aborted ? "ABORTED" : "ERROR";
    const cache = r.fromCache ? " [cache]" : "";
    console.log(`      ${r.toolName}: ${status}${cache} (${r.durationMs}ms)`);
  }

  console.log(`\n    事件回放:`);
  for (const ev of events) {
    switch (ev.kind) {
      case "concurrent-group-start":
        console.log(`      → 组${ev.groupIndex} 开始: [${ev.toolNames.join(", ")}]`);
        break;
      case "concurrent-group-end":
        console.log(`      ← 组${ev.groupIndex} 结束: ${ev.results.length} 个结果`);
        break;
      case "tool-cache-hit":
        console.log(`      ⚡ 缓存命中: ${ev.toolName}`);
        break;
      case "tool-budget-denied":
        console.log(`      ⛔ 预算拒绝: ${ev.toolName} (${ev.dimension})`);
        break;
      case "tool-aborted":
        console.log(`      ✗ 中止: ${ev.toolName} (${ev.reason})`);
        break;
    }
  }

  // 第二次调度 — 验证缓存命中
  console.log(`\n[5] 第二次调度（验证缓存）:`);
  events.length = 0;
  const results2 = await scheduler.dispatch(
    [
      { id: "call-6", toolName: "read_file", params: { path: "/src/index.ts" } },
      { id: "call-7", toolName: "list_files", params: { dir: "/src" } },
    ],
    invoker,
  );
  for (const r of results2) {
    console.log(`      ${r.toolName}: ${r.fromCache ? "CACHE_HIT" : "EXECUTED"} (${r.durationMs}ms)`);
  }

  // 统计
  const stats = scheduler.stats;
  console.log(`\n[6] 调度器统计:`);
  console.log(`    总调度: ${stats.totalDispatched}`);
  console.log(`    缓存命中: ${stats.totalCacheHits}`);
  console.log(`    预算拒绝: ${stats.totalBudgetDenied}`);
  console.log(`    中止: ${stats.totalAborted}`);
  console.log(`    平均并发: ${stats.avgConcurrency.toFixed(2)}`);

  console.log(`\n✓ 全链路演示完成`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runDemo().catch(err => {
  console.error("Demo failed:", err);
  process.exit(1);
});
