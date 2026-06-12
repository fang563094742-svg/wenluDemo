/**
 * Classifier（状态机 + 双门）单元测试。
 *
 * 全程依赖注入式 mock（内存 ClassifierStore + skillRepo stub + deduplicator stub +
 * verifier stub + mock constitution），独立可跑（不连真实 PG / 真实 LLM / 真实宪法）。
 * 覆盖任务 7.7 要求：
 *  - 状态机转移：forge→evidence_pending、pred hit/miss→proven/rejected、真值闸点亮、复用点亮；
 *  - 反向点亮：按 task_id 点亮 seeded 候选；
 *  - Promotion_Gate 合取各失败分支（未 proven / 安全失败 / 双门第二项未满足）；
 *  - autonomous 不主动晋升、proven 物化 active；
 *  - 升级各触发条件（低置信/矛盾、suspect_duplicate、High_Score+Conflict 模糊、安全边界）
 *    置 pending_review 并进人工队列；
 *  - 人工结论最高优先（自动门不推翻已决终态）；
 *  - 未触发升级的绝大多数候选走自动门直接晋升/拒绝、不进人工队列。
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 9.10, 9.11,
 *            16.1, 16.3, 16.4, 16.5, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import { describe, expect, it, vi } from "vitest";

import {
  createClassifier,
  createInMemoryClassifierStore,
  type Classifier,
  type ClassifierDeps,
  type InMemoryClassifierStore,
} from "../classifier.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { SkillRepo } from "../skillRepo.js";
import type { Deduplicator, ConflictFreeResult } from "../deduplicator.js";
import type { Verifier, SoftReviewResult } from "../verifier.js";
import type { ConstitutionAdjudicator } from "../classifier.js";
import type { Skill, SkillCandidate, CandidateStatus } from "../types.js";
import type { SourceSignal, Verdict } from "../../sovereign/types.js";

// ─────────────────────────────────────────────────────────────────
// 构造器 / stub
// ─────────────────────────────────────────────────────────────────

let candSeq = 0;
function mkCandidate(over: Partial<SkillCandidate> = {}): SkillCandidate {
  const id = over.id ?? `cand-${++candSeq}`;
  const now = "2024-01-01T00:00:00.000Z";
  return {
    id,
    kind: over.kind ?? "executable",
    draft: over.draft ?? { title: "open app", description: "open an application" },
    category: over.category ?? "automation",
    source_role: over.source_role ?? "executable_seed",
    source_weight: over.source_weight ?? "user_task",
    user_neutral: over.user_neutral ?? true,
    status: over.status ?? "seeded",
    contributor_id: over.contributor_id ?? "user-1",
    linked_prediction_id: over.linked_prediction_id,
    linked_verifiable_id: over.linked_verifiable_id,
    trajectory_ref: over.trajectory_ref,
    contributor_reuse_success: over.contributor_reuse_success ?? 0,
    merged_into: over.merged_into,
    created_at: now,
    updated_at: now,
  };
}

function mkSkill(id: string): Skill {
  const now = "2024-01-01T00:00:00.000Z";
  return {
    id,
    kind: "executable",
    title: "open app",
    description: "open an application",
    exec_vars: [],
    exec_steps: [],
    taxonomy: { taskType: "generic" },
    category: "automation",
    tags: [],
    platform: ["any"],
    os_scope: "variant",
    source: "self_learned",
    user_neutral: true,
    is_starter: false,
    status: "active",
    version: 1,
    provenance: { createdAt: now, verifiedCount: 0, totalCount: 0 },
    quality: { use_count: 0, success_count: 0, success_rate: 0, silent_count: 0 },
    cross_user_breadth: 1,
    variants: [],
    created_at: now,
    updated_at: now,
  };
}

/** 记录 promote 调用次数的 skillRepo stub（仅实现 classifier 用到的 promote/get）。 */
function makeSkillRepoStub(): SkillRepo & { promoteCalls: string[] } {
  const promoteCalls: string[] = [];
  const stub = {
    promoteCalls,
    async promote(candidateId: string): Promise<Skill> {
      promoteCalls.push(candidateId);
      return mkSkill(`skill-for-${candidateId}`);
    },
    async get(skillId: string): Promise<Skill | null> {
      return mkSkill(skillId);
    },
  };
  return stub as unknown as SkillRepo & { promoteCalls: string[] };
}

/** deduplicator stub：按给定 ConflictFreeResult 返回。 */
function makeDedupStub(result: ConflictFreeResult): Pick<Deduplicator, "isConflictFree"> {
  return {
    async isConflictFree(): Promise<ConflictFreeResult> {
      return result;
    },
  };
}

const CONFLICT_FREE: ConflictFreeResult = {
  conflictFree: true,
  ambiguous: false,
  reason: "no conflict",
};

/** verifier stub：按给定 pass 返回软评审结果。 */
function makeVerifierStub(pass: boolean): Pick<Verifier, "reviewSoft"> {
  return {
    async reviewSoft(): Promise<SoftReviewResult> {
      return { score: pass ? 0.9 : 0.1, pass };
    },
  };
}

/** mock constitution：返回固定 Verdict。 */
function makeConstitutionStub(verdict: Partial<Verdict>): ConstitutionAdjudicator {
  return {
    adjudicate(): Verdict {
      return {
        adopt: "userTrajectory",
        intervention: "strong",
        confidence: 0.9,
        rationale: "stub",
        drivingAllowed: false,
        ...verdict,
      };
    },
  };
}

/** 组装 classifier + store 便捷函数。 */
function setup(
  candidates: SkillCandidate[],
  opts: {
    cf?: ConflictFreeResult;
    softPass?: boolean;
    constitution?: ConstitutionAdjudicator;
    invocationByTask?: Record<string, string[]>;
    onPromoteToKb?: ClassifierDeps["onPromoteToKb"];
  } = {},
): { classifier: Classifier; store: InMemoryClassifierStore; repo: SkillRepo & { promoteCalls: string[] } } {
  const store = createInMemoryClassifierStore({
    candidates,
    invocationByTask: opts.invocationByTask,
  });
  const repo = makeSkillRepoStub();
  const classifier = createClassifier({
    skillRepo: repo,
    deduplicator: makeDedupStub(opts.cf ?? CONFLICT_FREE),
    verifier: makeVerifierStub(opts.softPass ?? true),
    store,
    constitution: opts.constitution,
    onPromoteToKb: opts.onPromoteToKb,
    config: DEFAULT_REFLUX_CONFIG,
  });
  return { classifier, store, repo };
}

const N_HARD = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_hard; // 3

// ─────────────────────────────────────────────────────────────────
// 7.1 状态机转移
// ─────────────────────────────────────────────────────────────────

describe("Classifier 状态机转移（7.1）", () => {
  it("forge 信号：seeded → evidence_pending 并绑定预测", async () => {
    const cand = mkCandidate({ status: "seeded" });
    const { classifier, store } = setup([cand]);
    const r = await classifier.onForgeSeed(cand.id, "pred-1");
    expect(r.status).toBe("evidence_pending");
    expect(r.changed).toBe(true);
    const after = await store.getCandidate(cand.id);
    expect(after?.linked_prediction_id).toBe("pred-1");
  });

  it("预测命中：evidence_pending → proven", async () => {
    const cand = mkCandidate({ status: "evidence_pending", linked_prediction_id: "pred-1" });
    const { classifier } = setup([cand]);
    const r = await classifier.onPredictionSettled("pred-1", "hit");
    expect(r?.status).toBe("proven");
  });

  it("预测落空：evidence_pending → rejected（自动拒绝）", async () => {
    const cand = mkCandidate({ status: "evidence_pending", linked_prediction_id: "pred-2" });
    const { classifier } = setup([cand]);
    const r = await classifier.onPredictionSettled("pred-2", "miss");
    expect(r?.status).toBe("rejected");
  });

  it("未知预测 id：结算返回 null", async () => {
    const { classifier } = setup([]);
    const r = await classifier.onPredictionSettled("nope", "hit");
    expect(r).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 7.2 seeded → proven 点亮
// ─────────────────────────────────────────────────────────────────

describe("Classifier seeded→proven 点亮（7.2）", () => {
  it("真值闸点亮：seeded → proven", async () => {
    const cand = mkCandidate({ status: "seeded" });
    const { classifier } = setup([cand]);
    const r = await classifier.lightByTruthGate(cand.id);
    expect(r.status).toBe("proven");
    expect(r.changed).toBe(true);
  });

  it("复用成功达硬阈值 N：executable seeded → proven", async () => {
    const cand = mkCandidate({ status: "seeded", kind: "executable" });
    const { classifier } = setup([cand]);
    let last;
    for (let i = 0; i < N_HARD; i++) last = await classifier.recordReuseSuccess(cand.id);
    expect(last?.status).toBe("proven");
  });

  it("复用未达阈值：保持 seeded", async () => {
    const cand = mkCandidate({ status: "seeded", kind: "executable" });
    const { classifier } = setup([cand]);
    const r = await classifier.recordReuseSuccess(cand.id);
    expect(r.status).toBe("seeded");
    expect(r.changed).toBe(false);
  });

  it("软性类达阈值但 LLM 评审未通过：保持 seeded", async () => {
    const cand = mkCandidate({ status: "seeded", kind: "soft", source_role: "soft_seed" });
    const { classifier } = setup([cand], { softPass: false });
    let last;
    const nSoft = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_soft;
    for (let i = 0; i < nSoft; i++) last = await classifier.recordReuseSuccess(cand.id);
    expect(last?.status).toBe("seeded");
  });

  it("软性类评审通过：reviewSoftCandidate 点亮 proven", async () => {
    const cand = mkCandidate({ status: "seeded", kind: "soft", source_role: "soft_seed" });
    const { classifier } = setup([cand], { softPass: true });
    const r = await classifier.reviewSoftCandidate(cand.id);
    expect(r.status).toBe("proven");
  });
});

// ─────────────────────────────────────────────────────────────────
// 7.3 反向点亮
// ─────────────────────────────────────────────────────────────────

describe("Classifier 反向点亮（7.3）", () => {
  it("任务成功按 task_id 点亮 seeded 候选（复用计数 +1，达阈值转 proven）", async () => {
    // 该候选已累计 N-1 次复用，反向点亮再 +1 即达阈值。
    const cand = mkCandidate({
      status: "seeded",
      kind: "executable",
      contributor_reuse_success: N_HARD - 1,
    });
    const { classifier } = setup([cand], { invocationByTask: { "task-9": [cand.id] } });
    const results = await classifier.onTruthGateTaskSuccess("task-9");
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("proven");
  });

  it("非 seeded 的关联候选不被点亮", async () => {
    const cand = mkCandidate({ status: "proven" });
    const { classifier } = setup([cand], { invocationByTask: { "task-x": [cand.id] } });
    const results = await classifier.onTruthGateTaskSuccess("task-x");
    expect(results).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7.5 Promotion_Gate 合取硬门 + 物化
// ─────────────────────────────────────────────────────────────────

describe("Classifier Promotion_Gate 双门合取（7.5）", () => {
  it("未 proven：不晋升（pending），不进人工队列", async () => {
    const cand = mkCandidate({ status: "seeded" });
    const { classifier, store, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("pending");
    expect(repo.promoteCalls).toHaveLength(0);
    expect(store.enqueued.size).toBe(0);
  });

  it("安全预审明确失败：自动拒绝 rejected", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "fail" });
    expect(d.outcome).toBe("rejected");
    expect(repo.promoteCalls).toHaveLength(0);
    expect(store.enqueued.size).toBe(0);
    expect((await store.getCandidate(cand.id))?.status).toBe("rejected");
  });

  it("脱敏明确不通过：自动拒绝 rejected", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { sanitize: "fail" });
    expect(d.outcome).toBe("rejected");
  });

  it("proven 但双门第二项未满足（复用<N 且非 High_Score）：pending、不晋升", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const { classifier, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass", highScore: false });
    expect(d.outcome).toBe("pending");
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("复用≥N：proven 经 skillRepo.promote 物化 active", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("promoted");
    expect(d.skill).toBeDefined();
    expect(repo.promoteCalls).toEqual([cand.id]);
    expect(store.enqueued.size).toBe(0);
  });

  it("High_Score ∧ Conflict_Free（复用<N）：晋升 active", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const { classifier, repo } = setup([cand], { cf: CONFLICT_FREE });
    const d = await classifier.evaluate(cand.id, { highScore: true });
    expect(d.outcome).toBe("promoted");
    expect(repo.promoteCalls).toEqual([cand.id]);
  });

  it("enforce 模式晋升经 onPromoteToKb 喂入 skill-kb", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const onPromoteToKb = vi.fn();
    const { classifier } = setup([cand], { onPromoteToKb });
    await classifier.evaluate(cand.id, { mode: "enforce" });
    expect(onPromoteToKb).toHaveBeenCalledTimes(1);
  });

  it("已物化（merged_into）：evaluate 幂等返回 promoted、不重复 promote", async () => {
    const cand = mkCandidate({ status: "proven", merged_into: "skill-existing" });
    const { classifier, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id);
    expect(d.outcome).toBe("promoted");
    expect(repo.promoteCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7.4 Source_Weight 影响
// ─────────────────────────────────────────────────────────────────

describe("Classifier Source_Weight（7.4）", () => {
  it("autonomous 来源：双门满足也不主动晋升（held）", async () => {
    const cand = mkCandidate({
      status: "proven",
      source_weight: "autonomous",
      contributor_reuse_success: N_HARD,
    });
    const { classifier, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("held");
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("user_task 来源：双门满足正常晋升", async () => {
    const cand = mkCandidate({
      status: "proven",
      source_weight: "user_task",
      contributor_reuse_success: N_HARD,
    });
    const { classifier, repo } = setup([cand]);
    const d = await classifier.evaluate(cand.id);
    expect(d.outcome).toBe("promoted");
    expect(repo.promoteCalls).toEqual([cand.id]);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7.6 升级判定 + 人工兜底 + 人工优先
// ─────────────────────────────────────────────────────────────────

describe("Classifier 升级判定 Human_Review_Escalation（7.6）", () => {
  it("(a) constitution 低置信：enforce 下升级 pending_review 并进人工队列", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const constitution = makeConstitutionStub({ confidence: 0.2, intervention: "soft" });
    const { classifier, store, repo } = setup([cand], { constitution });
    const signals: SourceSignal[] = [
      { source: "userTrajectory", stance: "x", strength: 0.5, canDrive: true },
    ];
    const d = await classifier.evaluate(cand.id, { mode: "enforce", signals });
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("constitution");
    expect(store.enqueued.has(cand.id)).toBe(true);
    expect((await store.getCandidate(cand.id))?.status).toBe("pending_review");
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("(a) constitution 矛盾未决（intervention=hold）：升级 pending_review", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const constitution = makeConstitutionStub({ confidence: 0.9, intervention: "hold" });
    const { classifier, store } = setup([cand], { constitution });
    const signals: SourceSignal[] = [
      { source: "userExplicit", stance: "x", strength: 0.5, canDrive: true },
    ];
    const d = await classifier.evaluate(cand.id, { mode: "enforce", signals });
    expect(d.outcome).toBe("escalated");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("(b) suspect_duplicate：升级 pending_review 并进人工队列", async () => {
    const cand = mkCandidate({ status: "suspect_duplicate" });
    const { classifier, store } = setup([cand]);
    const d = await classifier.evaluate(cand.id);
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("suspect_duplicate");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("(c) High_Score 但 Conflict 模糊：升级 pending_review", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const ambiguousCf: ConflictFreeResult = {
      conflictFree: false,
      ambiguous: true,
      reason: "fuzzy",
    };
    const { classifier, store } = setup([cand], { cf: ambiguousCf });
    const d = await classifier.evaluate(cand.id, { highScore: true });
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("conflict_ambiguous");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("(d) 安全边界存疑：升级 pending_review", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store } = setup([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "boundary" });
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("safety_boundary");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("人工 approved 终态最高优先：即便安全失败也不被自动门推翻", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const { classifier, store, repo } = setup([cand]);
    store.setHumanVerdict(cand.id, { decision: "approved", reviewed_by: "admin-1" });
    // 即使安全失败（自动门本会拒绝），人工 approved 仍胜出并物化。
    const d = await classifier.evaluate(cand.id, { safety: "fail" });
    expect(d.outcome).toBe("human_approved");
    expect(d.skill).toBeDefined();
    expect(repo.promoteCalls).toEqual([cand.id]);
    // 不进人工队列（已是人工终态）。
    expect(store.enqueued.size).toBe(0);
  });

  it("人工 rejected 终态最高优先：即便双门满足也不被晋升", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand]);
    store.setHumanVerdict(cand.id, { decision: "rejected", reviewed_by: "admin-1" });
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("human_rejected");
    expect(repo.promoteCalls).toHaveLength(0);
    expect((await store.getCandidate(cand.id))?.status).toBe("rejected");
  });
});

// ─────────────────────────────────────────────────────────────────
// 绝大多数候选走自动门，不进人工队列（Req 10.4）
// ─────────────────────────────────────────────────────────────────

describe("Classifier 自动门为主（10.4）", () => {
  it("一批正常候选全部经自动门晋升/拒绝、无一进入人工队列", async () => {
    const promote = Array.from({ length: 6 }, () =>
      mkCandidate({ status: "proven", contributor_reuse_success: N_HARD }),
    );
    const reject = Array.from({ length: 4 }, () => mkCandidate({ status: "proven" }));
    const { classifier, store } = setup([...promote, ...reject]);

    for (const c of promote) {
      const d = await classifier.evaluate(c.id, { safety: "pass", sanitize: "pass" });
      expect(d.outcome).toBe("promoted");
    }
    for (const c of reject) {
      const d = await classifier.evaluate(c.id, { safety: "fail" });
      expect(d.outcome).toBe("rejected");
    }
    // 绝大多数（此处全部）走自动门，人工队列为空。
    expect(store.enqueued.size).toBe(0);
  });
});
