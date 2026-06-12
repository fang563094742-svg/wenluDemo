/**
 * Distiller 单元测试（Req 4 / 蒸馏，复用并扩展 skill-flywheel.distillSkill）
 * ------------------------------------------------------------------
 * 聚焦"对 distillSkill 封装的二期扩展逻辑"（一期 distillSkill 内核已由
 * skill-flywheel 自带测试覆盖，此处不重复测内核三道闸本身）：
 *  - User_Neutral 判定经 mock LLM 透传到候选（Req 18.4）
 *  - 缺轨迹的可执行取向信号不蒸馏为可执行类、保留 pending（Req 3.5/5.1）
 *  - 蒸馏 LLM 预算超额时剩余信号保留 pending、留待下一批次（Req 20.3）
 *  - LLM 预算分配 allocateLlmBudget / 轨迹整形 shapeTrajectory 纯逻辑
 *
 * 全程注入内存 store + mock LLM，不触达真实 PG / 不硬编码任何 provider。
 *
 * Validates: Requirements 4.1, 4.7, 18.4, 20.3
 */
import { describe, it, expect } from "vitest";
import {
  createDistiller,
  allocateLlmBudget,
  shapeTrajectory,
  type DistillStore,
  type DistillClassifier,
  type DistillExtension,
} from "../distiller.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { HarvestSignal, SkillCandidate, TrajectoryEvent } from "../types.js";

// ── 测试夹具：内存 store ──

interface MemStore {
  store: DistillStore;
  candidates: SkillCandidate[];
  markCalls: Array<{ id: string; status: string }>;
  statusOf(id: string): string;
}

function createMemStore(
  signals: HarvestSignal[],
  traj: Record<string, TrajectoryEvent[]> = {},
): MemStore {
  const queue = new Map<string, HarvestSignal>(signals.map((s) => [s.id ?? "", { ...s }]));
  const candidates: SkillCandidate[] = [];
  const markCalls: Array<{ id: string; status: string }> = [];
  let seq = 0;
  const store: DistillStore = {
    async fetchPendingSignals(limit) {
      return [...queue.values()]
        .filter((s) => (s.status ?? "pending") === "pending")
        .slice(0, limit);
    },
    async fetchTrajectory(signal) {
      // 有 task_id 按 task_id 关联；无则按 `win:<signalId>` 键模拟时间窗关联。
      const key = signal.task_id ?? `win:${signal.id}`;
      return traj[key] ?? [];
    },
    async markSignalStatus(id, status) {
      markCalls.push({ id, status });
      const s = queue.get(id);
      if (s) s.status = status;
    },
    async insertCandidate(c) {
      const id = `cand_${++seq}`;
      candidates.push({ ...c, id });
      return id;
    },
  };
  return {
    store,
    candidates,
    markCalls,
    statusOf: (id) => queue.get(id)?.status ?? "pending",
  };
}

// ── 测试夹具：mock LLM 分类器（可计调用次数 + 覆写输出） ──

function mockClassifier(
  over: Partial<DistillExtension> = {},
  counter?: { n: number },
): DistillClassifier {
  return {
    async classify(input) {
      if (counter) counter.n++;
      return {
        kind: input.hasTrajectory ? "executable" : "soft",
        user_neutral: true,
        applicable_scenario: input.goal,
        taxonomy: input.skill.taxonomy,
        platform: input.skill.platform[0],
        ...over,
      };
    },
  };
}

// ── 信号 / 轨迹构造 ──

let sigSeq = 0;
function mkSignal(over: Partial<HarvestSignal> = {}): HarvestSignal {
  return {
    id: `sig_${++sigSeq}`,
    signal_role: "executable_seed",
    source_tool: "forge_capability",
    source_weight: "user_task",
    contributor_id: "00000000-0000-0000-0000-000000000001",
    payload: { goal: "open chess app and make a move" },
    task_id: `task_${sigSeq}`,
    status: "pending",
    enqueued_at: new Date().toISOString(),
    ...over,
  };
}

function mkTrajEvent(over: Partial<TrajectoryEvent> = {}): TrajectoryEvent {
  return {
    user_id: "00000000-0000-0000-0000-000000000001",
    task_id: "task_1",
    action_name: "open",
    args_summary: "chessApp",
    result_summary: "ok opened",
    ts: new Date().toISOString(),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────

describe("allocateLlmBudget（Req 20.3）", () => {
  it("默认预算 5 → 蒸馏2/去重2/软评审1", () => {
    expect(allocateLlmBudget(5)).toEqual({ distill: 2, dedup: 2, softReview: 1 });
  });
  it("预算偏小按优先级截断（蒸馏优先）", () => {
    expect(allocateLlmBudget(3)).toEqual({ distill: 2, dedup: 1, softReview: 0 });
    expect(allocateLlmBudget(1)).toEqual({ distill: 1, dedup: 0, softReview: 0 });
    expect(allocateLlmBudget(0)).toEqual({ distill: 0, dedup: 0, softReview: 0 });
  });
  it("超大预算各阶段仍受上限封顶", () => {
    expect(allocateLlmBudget(100)).toEqual({ distill: 2, dedup: 2, softReview: 1 });
  });
});

describe("shapeTrajectory（TrajectoryEvent → ExecutionStep）", () => {
  it("按时间正序整形并推断 outcome（无失败语义→achieved）", () => {
    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-01-01T00:01:00.000Z";
    const steps = shapeTrajectory([
      mkTrajEvent({ ts: t1, action_name: "move", result_summary: "ok" }),
      mkTrajEvent({ ts: t0, action_name: "open", result_summary: "ok" }),
    ]);
    expect(steps.map((s) => s.action.startsWith("open") ? "open" : "move")).toEqual(["open", "move"]);
    expect(steps.every((s) => s.outcome === "achieved")).toBe(true);
  });

  it("结果摘要含失败语义→wrong_effect（不固化错误经验）", () => {
    const [step] = shapeTrajectory([mkTrajEvent({ result_summary: "permission denied 失败" })]);
    expect(step.outcome).toBe("wrong_effect");
  });
});

describe("Distiller · User_Neutral 判定经 LLM 透传（Req 18.4）", () => {
  it("LLM 判 user_neutral=false → 候选 user_neutral=false", async () => {
    const sig = mkSignal({ task_id: "task_un" });
    const mem = createMemStore([sig], { task_un: [mkTrajEvent({ task_id: "task_un" })] });
    const distiller = createDistiller({
      store: mem.store,
      llm: mockClassifier({ user_neutral: false }),
      config: DEFAULT_REFLUX_CONFIG,
    });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].user_neutral).toBe(false);
    expect(report.candidates[0].draft.user_neutral).toBe(false);
    expect(mem.statusOf(sig.id!)).toBe("distilled");
  });

  it("LLM 判 user_neutral=true → 候选 user_neutral=true 且为可执行（有轨迹）", async () => {
    const sig = mkSignal({ task_id: "task_un2" });
    const mem = createMemStore([sig], { task_un2: [mkTrajEvent({ task_id: "task_un2" })] });
    const distiller = createDistiller({
      store: mem.store,
      llm: mockClassifier({ user_neutral: true, kind: "executable" }),
      config: DEFAULT_REFLUX_CONFIG,
    });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].user_neutral).toBe(true);
    expect(report.candidates[0].kind).toBe("executable");
    // 复用 distillSkill 内核：执行体结构被带入草稿
    const exec = report.candidates[0].draft.exec as { steps: unknown[] };
    expect(Array.isArray(exec.steps)).toBe(true);
    expect(exec.steps.length).toBeGreaterThan(0);
  });
});

describe("Distiller · 缺轨迹不蒸馏为可执行类（Req 3.5/5.1）", () => {
  it("executable_seed 无可关联轨迹 → 跳过、不产出候选、保留 pending", async () => {
    const sig = mkSignal({ task_id: "task_notraj" }); // 无对应轨迹条目
    const mem = createMemStore([sig], {}); // 空轨迹
    const distiller = createDistiller({
      store: mem.store,
      llm: mockClassifier({ kind: "executable" }), // 即便 LLM 想判可执行也不允许
      config: DEFAULT_REFLUX_CONFIG,
    });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(0);
    expect(report.skippedNoTrajectory).toContain(sig.id);
    // 保留 pending：不应被标 distilled/rejected
    expect(mem.statusOf(sig.id!)).toBe("pending");
    expect(mem.markCalls).toHaveLength(0);
  });

  it("soft_seed 无轨迹 → 仍可蒸馏为 soft 候选（kind=soft）", async () => {
    const sig = mkSignal({
      signal_role: "soft_seed",
      source_tool: "add_rule",
      task_id: "task_soft",
      payload: { goal: "总结一个通用的复盘方法" },
    });
    const mem = createMemStore([sig], {}); // 无轨迹
    const distiller = createDistiller({
      store: mem.store,
      llm: mockClassifier(),
      config: DEFAULT_REFLUX_CONFIG,
    });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].kind).toBe("soft");
    expect(mem.statusOf(sig.id!)).toBe("distilled");
  });
});

describe("Distiller · 蒸馏 LLM 预算超额保留 pending（Req 20.3）", () => {
  it("蒸馏配额=1 时，仅首条蒸馏，其余保留 pending 留待下一批次", async () => {
    const s1 = mkSignal({ id: "b1", task_id: "tb1" });
    const s2 = mkSignal({ id: "b2", task_id: "tb2" });
    const s3 = mkSignal({ id: "b3", task_id: "tb3" });
    const mem = createMemStore([s1, s2, s3], {
      tb1: [mkTrajEvent({ task_id: "tb1" })],
      tb2: [mkTrajEvent({ task_id: "tb2" })],
      tb3: [mkTrajEvent({ task_id: "tb3" })],
    });
    const counter = { n: 0 };
    const distiller = createDistiller({
      store: mem.store,
      llm: mockClassifier({}, counter),
      // Pipeline_LLM_Budget=1 → allocateLlmBudget.distill=1
      config: { ...DEFAULT_REFLUX_CONFIG, Pipeline_LLM_Budget: 1 },
    });
    const report = await distiller.distillPendingBatch(10);

    expect(report.budget.distill).toBe(1);
    expect(report.candidates).toHaveLength(1);
    expect(report.deferredBudget).toHaveLength(2);
    expect(report.llmCallsUsed).toBe(1);
    expect(counter.n).toBe(1); // LLM 只被调用一次

    // 首条 distilled，其余两条保留 pending（不标状态）
    expect(mem.statusOf("b1")).toBe("distilled");
    expect(mem.statusOf("b2")).toBe("pending");
    expect(mem.statusOf("b3")).toBe("pending");
  });
});

describe("Distiller · 无 LLM 注入时确定性扩展（不计预算）", () => {
  it("不注入 LLM → 走确定性扩展，llmCallsUsed=0，仍产出候选", async () => {
    const sig = mkSignal({ task_id: "task_det" });
    const mem = createMemStore([sig], { task_det: [mkTrajEvent({ task_id: "task_det" })] });
    const distiller = createDistiller({ store: mem.store, config: DEFAULT_REFLUX_CONFIG });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    expect(report.llmCallsUsed).toBe(0);
    expect(report.candidates[0].kind).toBe("executable"); // 有轨迹 → executable
    expect(report.candidates[0].user_neutral).toBe(true); // 确定性保守判中立
  });
});
