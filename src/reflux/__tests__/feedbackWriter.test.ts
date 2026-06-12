/**
 * Feedback_Writer（回写 / 静默 / 淘汰）单元测试。
 *
 * 全程依赖注入式 mock（内存 FeedbackWriterStore + recordSkillUsage 桩 + skillRepo 桩 +
 * classifier 桩），独立可跑（不连真实 PG / 真实 LLM）。覆盖任务 15：
 *  - 回写质量分（成功 / 失败均经 recordSkillUsage，Req 12.1）；
 *  - 达 Promotion_Threshold_N 触发晋升评估（Req 12.2）；未达 N 不触发；
 *  - 静默继承扫描：超 T_silent 且未使用 → silent_count++ 并降质量分（Req 12.4/12.5）；
 *    已使用 / 未超期不降分；
 *  - 淘汰：active 低分够样本 → retired；长期静默 use_count=0 → retired；不满足条件保持 active
 *    （Req 10.7/10.8/12.3）。
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 10.7, 10.8
 */

import { describe, expect, it, vi } from "vitest";

import {
  createFeedbackWriter,
  createInMemoryFeedbackWriterStore,
  DEFAULT_SILENT_DECAY_FACTOR,
  type FeedbackWriterDeps,
  type MemFeedbackInheritance,
  type MemFeedbackSkill,
} from "../feedbackWriter.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { SkillRepo } from "../skillRepo.js";
import type { Classifier, ClassifyDecision, TransitionResult } from "../classifier.js";

// ─────────────────────────────────────────────────────────────────
// 构造器 / stub
// ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2024-06-01T00:00:00.000Z");

/** 只实现 setStatus 的 skillRepo 桩，记录调用便于断言淘汰。 */
function mkSkillRepoStub() {
  const setStatus = vi.fn(async (_id: string, _status: "active" | "retired") => {});
  return { setStatus } as unknown as Pick<SkillRepo, "setStatus"> & {
    setStatus: ReturnType<typeof vi.fn>;
  };
}

/** classifier 桩：recordReuseSuccess 返回预设 transition，evaluate 返回预设 decision。 */
function mkClassifierStub(opts: {
  transition: TransitionResult;
  decision?: ClassifyDecision;
}) {
  const recordReuseSuccess = vi.fn(async (_id: string) => opts.transition);
  const evaluate = vi.fn(
    async (id: string): Promise<ClassifyDecision> =>
      opts.decision ?? { outcome: "promoted", candidateId: id, reason: "stub" },
  );
  return {
    recordReuseSuccess,
    evaluate,
  } as unknown as Pick<Classifier, "recordReuseSuccess" | "evaluate"> & {
    recordReuseSuccess: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
  };
}

function mkSkill(over: Partial<MemFeedbackSkill> = {}): MemFeedbackSkill {
  return {
    id: over.id ?? "skill-1",
    status: over.status ?? "active",
    use_count: over.use_count ?? 0,
    success_rate: over.success_rate ?? 0.0,
    silent_count: over.silent_count ?? 0,
    // 默认远早于窗口起点（观察够久）。
    created_at: over.created_at ?? "2024-01-01T00:00:00.000Z",
  };
}

function mkInheritance(over: Partial<MemFeedbackInheritance> = {}): MemFeedbackInheritance {
  return {
    user_id: over.user_id ?? "user-1",
    skill_id: over.skill_id ?? "skill-1",
    acquired_at: over.acquired_at ?? "2024-01-01T00:00:00.000Z",
    last_used_at: over.last_used_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────
// 回写质量分（Req 12.1）
// ─────────────────────────────────────────────────────────────────

describe("Feedback_Writer · recordReuse 回写质量分（Req 12.1）", () => {
  it("成功复用经 recordSkillUsage 回写（success=true）", async () => {
    const recordSkillUsage = vi.fn(async () => {});
    const fw = createFeedbackWriter({
      skillRepo: mkSkillRepoStub(),
      recordSkillUsage,
      store: createInMemoryFeedbackWriterStore(),
    });

    const r = await fw.recordReuse({ userId: "u1", skillId: "s1", success: true });

    expect(r.recorded).toBe(true);
    expect(recordSkillUsage).toHaveBeenCalledWith("u1", "s1", true);
    // 未带候选 / 未注入 classifier：不触发晋升评估。
    expect(r.reuseTransition).toBeUndefined();
    expect(r.promotion).toBeUndefined();
  });

  it("失败复用同样经 recordSkillUsage 回写（success=false）", async () => {
    const recordSkillUsage = vi.fn(async () => {});
    const fw = createFeedbackWriter({
      skillRepo: mkSkillRepoStub(),
      recordSkillUsage,
      store: createInMemoryFeedbackWriterStore(),
    });

    await fw.recordReuse({ userId: "u1", skillId: "s1", success: false });

    expect(recordSkillUsage).toHaveBeenCalledWith("u1", "s1", false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 达 N 触发晋升评估（Req 12.2）
// ─────────────────────────────────────────────────────────────────

describe("Feedback_Writer · 达 Promotion_Threshold_N 触发晋升评估（Req 12.2）", () => {
  it("候选复用累加点亮 proven → 触发 classifier.evaluate", async () => {
    const recordSkillUsage = vi.fn(async () => {});
    const classifier = mkClassifierStub({
      transition: {
        candidateId: "cand-1",
        status: "proven",
        changed: true,
        reason: "达阈值点亮 proven",
      },
      decision: { outcome: "promoted", candidateId: "cand-1", reason: "晋升" },
    });
    const fw = createFeedbackWriter({
      skillRepo: mkSkillRepoStub(),
      recordSkillUsage,
      classifier,
      store: createInMemoryFeedbackWriterStore(),
    });

    const r = await fw.recordReuse({
      userId: "u1",
      skillId: "s1",
      success: true,
      candidateId: "cand-1",
    });

    expect(classifier.recordReuseSuccess).toHaveBeenCalledWith("cand-1");
    expect(classifier.evaluate).toHaveBeenCalledWith("cand-1", undefined);
    expect(r.reuseTransition?.status).toBe("proven");
    expect(r.promotion?.outcome).toBe("promoted");
  });

  it("候选复用未达阈值（仍 seeded）→ 不触发 evaluate", async () => {
    const classifier = mkClassifierStub({
      transition: {
        candidateId: "cand-1",
        status: "seeded",
        changed: false,
        reason: "复用 1/3 未达阈值",
      },
    });
    const fw = createFeedbackWriter({
      skillRepo: mkSkillRepoStub(),
      recordSkillUsage: vi.fn(async () => {}),
      classifier,
      store: createInMemoryFeedbackWriterStore(),
    });

    const r = await fw.recordReuse({
      userId: "u1",
      skillId: "s1",
      success: true,
      candidateId: "cand-1",
    });

    expect(classifier.recordReuseSuccess).toHaveBeenCalledWith("cand-1");
    expect(classifier.evaluate).not.toHaveBeenCalled();
    expect(r.promotion).toBeUndefined();
  });

  it("失败复用即便带候选也不累加复用计数（不触发晋升）", async () => {
    const classifier = mkClassifierStub({
      transition: { candidateId: "cand-1", status: "seeded", changed: false, reason: "" },
    });
    const fw = createFeedbackWriter({
      skillRepo: mkSkillRepoStub(),
      recordSkillUsage: vi.fn(async () => {}),
      classifier,
      store: createInMemoryFeedbackWriterStore(),
    });

    await fw.recordReuse({ userId: "u1", skillId: "s1", success: false, candidateId: "cand-1" });

    expect(classifier.recordReuseSuccess).not.toHaveBeenCalled();
    expect(classifier.evaluate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// 静默继承扫描（Req 12.4/12.5）
// ─────────────────────────────────────────────────────────────────

describe("Feedback_Writer · 静默继承扫描降分（Req 12.4/12.5）", () => {
  it("超 T_silent 且从未使用 → silent_count++ 且 success_rate 按衰减因子下调", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s1", success_rate: 0.8, silent_count: 0 })],
      inheritances: [
        // 8 天前继承、从未使用（默认 T_silent=7 天）→ 静默。
        mkInheritance({
          skill_id: "s1",
          acquired_at: new Date(NOW - 8 * DAY_MS).toISOString(),
          last_used_at: null,
        }),
      ],
    });
    const fw = createFeedbackWriter({ skillRepo: mkSkillRepoStub(), store });

    const r = await fw.scanSilentInheritance(NOW);

    expect(r.scanned).toBe(1);
    expect(r.penalizedSkillIds).toEqual(["s1"]);
    const s = store.skills.get("s1")!;
    expect(s.silent_count).toBe(1);
    expect(s.success_rate).toBeCloseTo(0.8 * DEFAULT_SILENT_DECAY_FACTOR, 6);
  });

  it("已被使用（last_used_at 非空）不计静默、不降分", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s1", success_rate: 0.8 })],
      inheritances: [
        mkInheritance({
          skill_id: "s1",
          acquired_at: new Date(NOW - 30 * DAY_MS).toISOString(),
          last_used_at: new Date(NOW - 1 * DAY_MS).toISOString(),
        }),
      ],
    });
    const fw = createFeedbackWriter({ skillRepo: mkSkillRepoStub(), store });

    const r = await fw.scanSilentInheritance(NOW);

    expect(r.scanned).toBe(0);
    expect(store.skills.get("s1")!.silent_count).toBe(0);
    expect(store.skills.get("s1")!.success_rate).toBe(0.8);
  });

  it("继承未超 T_silent 不计静默", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s1" })],
      inheritances: [
        // 3 天前继承（< 7 天）。
        mkInheritance({
          skill_id: "s1",
          acquired_at: new Date(NOW - 3 * DAY_MS).toISOString(),
          last_used_at: null,
        }),
      ],
    });
    const fw = createFeedbackWriter({ skillRepo: mkSkillRepoStub(), store });

    const r = await fw.scanSilentInheritance(NOW);
    expect(r.scanned).toBe(0);
  });

  it("同一技能多条静默继承按条数累加 silent_count", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s1", success_rate: 1.0, silent_count: 0 })],
      inheritances: [
        mkInheritance({ user_id: "u1", skill_id: "s1", acquired_at: new Date(NOW - 10 * DAY_MS).toISOString() }),
        mkInheritance({ user_id: "u2", skill_id: "s1", acquired_at: new Date(NOW - 10 * DAY_MS).toISOString() }),
        mkInheritance({ user_id: "u3", skill_id: "s1", acquired_at: new Date(NOW - 10 * DAY_MS).toISOString() }),
      ],
    });
    const fw = createFeedbackWriter({ skillRepo: mkSkillRepoStub(), store });

    const r = await fw.scanSilentInheritance(NOW);
    expect(r.scanned).toBe(3);
    expect(store.skills.get("s1")!.silent_count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// 淘汰扫描（Req 10.7/10.8/12.3）
// ─────────────────────────────────────────────────────────────────

describe("Feedback_Writer · 淘汰扫描 active→retired（Req 10.7/10.8/12.3）", () => {
  it("active 低分且 use_count≥Min_Sample → 置 retired", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [
        // success_rate 0.3 < 0.5(默认阈值)，use_count 6 ≥ 5(默认 Min_Sample)。
        mkSkill({ id: "s-low", status: "active", use_count: 6, success_rate: 0.3 }),
      ],
    });
    const skillRepo = mkSkillRepoStub();
    const fw = createFeedbackWriter({ skillRepo, store });

    const r = await fw.scanEliminations(NOW);

    expect(r.retiredSkillIds).toEqual(["s-low"]);
    expect(skillRepo.setStatus).toHaveBeenCalledWith("s-low", "retired");
  });

  it("长期静默（use_count=0 且 silent_count≥Min_Sample）→ 置 retired（Req 12.5）", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s-silent", status: "active", use_count: 0, silent_count: 5 })],
    });
    const skillRepo = mkSkillRepoStub();
    const fw = createFeedbackWriter({ skillRepo, store });

    const r = await fw.scanEliminations(NOW);

    expect(r.retiredSkillIds).toEqual(["s-silent"]);
    expect(skillRepo.setStatus).toHaveBeenCalledWith("s-silent", "retired");
  });

  it("样本不足（use_count<Min_Sample）即便低分也不淘汰", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [mkSkill({ id: "s-young", status: "active", use_count: 2, success_rate: 0.1 })],
    });
    const skillRepo = mkSkillRepoStub();
    const fw = createFeedbackWriter({ skillRepo, store });

    const r = await fw.scanEliminations(NOW);

    expect(r.retiredSkillIds).toEqual([]);
    expect(skillRepo.setStatus).not.toHaveBeenCalled();
  });

  it("高分技能不淘汰；已 retired 不重复处理", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [
        mkSkill({ id: "s-good", status: "active", use_count: 10, success_rate: 0.9 }),
        mkSkill({ id: "s-retired", status: "retired", use_count: 10, success_rate: 0.1 }),
      ],
    });
    const skillRepo = mkSkillRepoStub();
    const fw = createFeedbackWriter({ skillRepo, store });

    const r = await fw.scanEliminations(NOW);

    expect(r.retiredSkillIds).toEqual([]);
    expect(skillRepo.setStatus).not.toHaveBeenCalled();
  });

  it("观察未够久（created_at 晚于窗口起点）不淘汰", async () => {
    const store = createInMemoryFeedbackWriterStore({
      skills: [
        // 默认 Elimination_Window=30 天；created_at 仅 1 天前 → 未够久。
        mkSkill({
          id: "s-fresh",
          status: "active",
          use_count: 6,
          success_rate: 0.2,
          created_at: new Date(NOW - 1 * DAY_MS).toISOString(),
        }),
      ],
    });
    const skillRepo = mkSkillRepoStub();
    const fw = createFeedbackWriter({ skillRepo, store });

    const r = await fw.scanEliminations(NOW);
    expect(r.retiredSkillIds).toEqual([]);
  });
});

// 默认配置自检：保证测试假设的阈值与默认值一致。
describe("Feedback_Writer · 默认配置假设自检", () => {
  it("默认阈值与测试假设一致", () => {
    expect(DEFAULT_REFLUX_CONFIG.T_silent_ms).toBe(7 * DAY_MS);
    expect(DEFAULT_REFLUX_CONFIG.Elimination_Window_ms).toBe(30 * DAY_MS);
    expect(DEFAULT_REFLUX_CONFIG.Elimination_Threshold).toBe(0.5);
    expect(DEFAULT_REFLUX_CONFIG.Min_Sample).toBe(5);
    expect(DEFAULT_SILENT_DECAY_FACTOR).toBeGreaterThan(0);
    expect(DEFAULT_SILENT_DECAY_FACTOR).toBeLessThan(1);
  });
});
