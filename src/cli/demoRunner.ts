import { createConcurrentScheduler } from "../runtime/concurrentScheduler.js";
import type { ToolCall, ToolInvoker, SchedulerEvent, SemanticRegistry, ConflictDetector, SchedulerEventBus } from "../runtime/concurrentScheduler.js";
import { createToolCache } from "../tools/cachePolicy.js";
import { createBudgetGovernor } from "../runtime/budgetGovernor.js";
import { TOOL_SEMANTICS } from "../tools/toolSemantics.js";
import type { ToolSemantics } from "../tools/toolSemantics.js";

/**
 * Minimal demo scheduler runner — shows concurrent scheduling + budget governance.
 */
export async function runDemoScheduler(_args: string[]): Promise<void> {
  // --- Budget Governor ---
  const governor = createBudgetGovernor();

  // --- Semantic registry adapter ---
  const registry: SemanticRegistry = {
    get(toolName: string): ToolSemantics | undefined {
      return (TOOL_SEMANTICS as Record<string, ToolSemantics>)[toolName];
    },
  };

  // --- Conflict detector: tools writing to same path cannot run concurrently ---
  const conflicts: ConflictDetector = {
    maxParallelSet(toolNames: string[]): string[][] {
      // Naive: write tools can't overlap, reads can
      const reads = toolNames.filter(t => t.startsWith("read") || t.startsWith("list"));
      const writes = toolNames.filter(t => !t.startsWith("read") && !t.startsWith("list"));
      const groups: string[][] = [];
      if (reads.length > 0) groups.push(reads);
      for (const w of writes) groups.push([w]);
      return groups.length > 0 ? groups : [toolNames];
    },
  };

  // --- Event bus ---
  const eventBus: SchedulerEventBus = {
    emit(ev: SchedulerEvent) {
      console.log(`[sched] ${ev.kind}`);
    },
  };

  // --- Tool invoker (stub) ---
  const invoker: ToolInvoker = async (_toolName: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
    const delay = Math.floor(Math.random() * 200) + 50;
    await new Promise((r) => setTimeout(r, delay));
    return { ok: true, result: `[stub] ${_toolName} completed` };
  };

  // --- Cache ---
  const cache = createToolCache(64);

  // --- Create scheduler ---
  const scheduler = createConcurrentScheduler({
    conflictDetector: conflicts,
    budgetGovernor: governor,
    cache,
    semantics: registry,
    eventBus,
  });

  // --- Prepare tool calls ---
  const calls: ToolCall[] = [
    { id: "1", toolName: "list_files", params: { path: "/src" }, priority: "normal" },
    { id: "2", toolName: "read_file", params: { path: "/src/index.ts" }, priority: "normal" },
    { id: "3", toolName: "write_file", params: { path: "/src/index.ts", content: "…" }, priority: "critical" },
    { id: "4", toolName: "run_command", params: { cmd: "npm test" }, priority: "optional" },
  ];

  console.log("=== Demo Scheduler Start ===");
  const snap = governor.snapshot();
  console.log(`Tier: ${snap.tier}, lowestRatio: ${snap.lowestBucketRatio}`);

  // --- Budget gate: acquire before dispatch ---
  for (const call of calls) {
    const acq = governor.acquire({
      dimension: "llm-tokens",
      amount: 25,
      source: "demo",
      priority: call.priority ?? "normal",
    });
    if (!acq.granted) {
      console.log(`[budget] DENIED ${call.toolName}: tier=${acq.tier}`);
    }
  }

  // --- Dispatch all at once (scheduler groups internally) ---
  const results = await scheduler.dispatch(calls, invoker);
  console.log(`=== Done === ${results.length} results, cacheHits=${scheduler.stats.totalCacheHits}`);
}
