/**
 * 技能反哺（Skill Reflux）· 治理升级与人工优先测试（任务 19.3）
 * ------------------------------------------------------------------
 * 构造同一技能同时存在「人工 admin 显式结论」与「自动门结论」的场景，断言：
 *  (a) 各 Human_Review_Escalation 触发 → 候选置 pending_review 并进既有人工队列；
 *  (b) 人工终态最高优先、自动门不推翻已决终态；
 *  (c) 未触发升级的绝大多数候选由自动门直接晋升/拒绝、不进人工队列；
 *  并新增 admin 鉴权拒绝测试：非管理员调用人工审核入口被拒（未授权）且不执行审核动作。
 *
 * 全程内存实现 + 注入桩（mock constitution / dedup / verifier / skillRepo），
 * admin 鉴权部分直接驱动 `requireAdmin` 中间件，独立可跑（不连真实 PG / LLM / 网络）。
 *
 * 关联 Property 1（晋升不可绕过，含人工终态优先）。
 * Validates: Requirements 10.4, 10.5, 10.7, 16.3
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClassifier,
  createInMemoryClassifierStore,
  type Classifier,
  type ConstitutionAdjudicator,
  type InMemoryClassifierStore,
} from "../classifier.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { SkillRepo } from "../skillRepo.js";
import type { ConflictFreeResult, Deduplicator } from "../deduplicator.js";
import type { SoftReviewResult, Verifier } from "../verifier.js";
import type { Skill, SkillCandidate } from "../types.js";
import type { SourceSignal, Verdict } from "../../sovereign/types.js";
import { requireAdmin } from "../../auth/middleware.js";

const N_HARD = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_hard; // 3
const NOW = "2024-01-01T00:00:00.000Z";

let seq = 0;
function mkCandidate(over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: over.id ?? `cand-${++seq}`,
    kind: over.kind ?? "executable",
    draft: over.draft ?? { title: "open app", description: "open" },
    category: over.category ?? "automation",
    source_role: over.source_role ?? "executable_seed",
    source_weight: over.source_weight ?? "user_task",
    user_neutral: over.user_neutral ?? true,
    status: over.status ?? "seeded",
    contributor_id: over.contributor_id ?? "user-1",
    contributor_reuse_success: over.contributor_reuse_success ?? 0,
    merged_into: over.merged_into,
    created_at: NOW,
    updated_at: NOW,
  };
}

function mkSkill(id: string): Skill {
  return {
    id, kind: "executable", title: "open app", description: "open",
    exec_vars: [], exec_steps: [], taxonomy: { taskType: "generic" },
    category: "automation", tags: [], platform: ["any"], os_scope: "variant",
    source: "self_learned", user_neutral: true, is_starter: false, status: "active", version: 1,
    provenance: { createdAt: NOW, verifiedCount: 0, totalCount: 0 },
    quality: { use_count: 0, success_count: 0, success_rate: 0, silent_count: 0 },
    cross_user_breadth: 1, variants: [], created_at: NOW, updated_at: NOW,
  };
}

function makeSkillRepoStub(): SkillRepo & { promoteCalls: string[] } {
  const promoteCalls: string[] = [];
  const stub = {
    promoteCalls,
    async promote(candidateId: string): Promise<Skill> { promoteCalls.push(candidateId); return mkSkill(`skill-${candidateId}`); },
    async get(skillId: string): Promise<Skill | null> { return mkSkill(skillId); },
  };
  return stub as unknown as SkillRepo & { promoteCalls: string[] };
}

const CONFLICT_FREE: ConflictFreeResult = { conflictFree: true, ambiguous: false, reason: "no conflict" };
function makeDedupStub(result: ConflictFreeResult = CONFLICT_FREE): Pick<Deduplicator, "isConflictFree"> {
  return { async isConflictFree() { return result; } };
}
function makeVerifierStub(pass = true): Pick<Verifier, "reviewSoft"> {
  return { async reviewSoft(): Promise<SoftReviewResult> { return { score: pass ? 0.9 : 0.1, pass }; } };
}
function makeConstitutionStub(verdict: Partial<Verdict>): ConstitutionAdjudicator {
  return {
    adjudicate(): Verdict {
      return { adopt: "userTrajectory", intervention: "strong", confidence: 0.9, rationale: "stub", drivingAllowed: false, ...verdict };
    },
  };
}

function setup(
  candidates: SkillCandidate[],
  opts: {
    cf?: ConflictFreeResult;
    constitution?: ConstitutionAdjudicator;
    humanVerdicts?: Record<string, { decision: "approved" | "rejected"; reviewed_by: string }>;
  } = {},
): { classifier: Classifier; store: InMemoryClassifierStore; repo: SkillRepo & { promoteCalls: string[] } } {
  const store = createInMemoryClassifierStore({ candidates, humanVerdicts: opts.humanVerdicts });
  const repo = makeSkillRepoStub();
  const classifier = createClassifier({
    skillRepo: repo,
    deduplicator: makeDedupStub(opts.cf),
    verifier: makeVerifierStub(true),
    store,
    constitution: opts.constitution,
    config: DEFAULT_REFLUX_CONFIG,
  });
  return { classifier, store, repo };
}

const ENFORCE_SIGNALS: SourceSignal[] = [{ source: "userTrajectory", stance: "x", strength: 0.5, canDrive: true }];

// ═══════════════════════════════════════════════════════════════════
// (a) Human_Review_Escalation 各触发条件 → pending_review 并进人工队列
// ═══════════════════════════════════════════════════════════════════

describe("(a) 升级触发 → pending_review 并进人工队列（10.5）", () => {
  it("constitution 低置信 → escalated（constitution）", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand], { constitution: makeConstitutionStub({ confidence: 0.2, intervention: "soft" }) });
    const d = await classifier.evaluate(cand.id, { mode: "enforce", signals: ENFORCE_SIGNALS });
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("constitution");
    expect(store.enqueued.has(cand.id)).toBe(true);
    expect((await store.getCandidate(cand.id))?.status).toBe("pending_review");
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("constitution 矛盾未决（intervention=hold）→ escalated", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store } = setup([cand], { constitution: makeConstitutionStub({ confidence: 0.95, intervention: "hold" }) });
    const d = await classifier.evaluate(cand.id, { mode: "enforce", signals: ENFORCE_SIGNALS });
    expect(d.outcome).toBe("escalated");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("suspect_duplicate（疑似重复未决）→ escalated", async () => {
    const cand = mkCandidate({ status: "suspect_duplicate" });
    const { classifier, store } = setup([cand]);
    const d = await classifier.evaluate(cand.id);
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("suspect_duplicate");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("High_Score 但 Conflict 模糊 → escalated（conflict_ambiguous）", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const ambiguous: ConflictFreeResult = { conflictFree: false, ambiguous: true, reason: "fuzzy" };
    const { classifier, store } = setup([cand], { cf: ambiguous });
    const d = await classifier.evaluate(cand.id, { highScore: true });
    expect(d.outcome).toBe("escalated");
    expect(d.escalationTrigger).toBe("conflict_ambiguous");
    expect(store.enqueued.has(cand.id)).toBe(true);
  });

  it("安全 / 脱敏边界存疑 → escalated（safety_boundary）", async () => {
    const c1 = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const s1 = setup([c1]);
    const d1 = await s1.classifier.evaluate(c1.id, { safety: "boundary" });
    expect(d1.outcome).toBe("escalated");
    expect(d1.escalationTrigger).toBe("safety_boundary");
    expect(s1.store.enqueued.has(c1.id)).toBe(true);

    const c2 = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const s2 = setup([c2]);
    const d2 = await s2.classifier.evaluate(c2.id, { sanitize: "boundary" });
    expect(d2.outcome).toBe("escalated");
    expect(s2.store.enqueued.has(c2.id)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// (b) 人工终态最高优先、自动门不推翻
// ═══════════════════════════════════════════════════════════════════

describe("(b) 人工终态最高优先，自动门不推翻（10.7）", () => {
  it("同一技能：自动门本会拒绝（安全失败），但人工 approved 胜出并物化", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const { classifier, store, repo } = setup([cand], { humanVerdicts: { [cand.id]: { decision: "approved", reviewed_by: "admin-1" } } });
    const d = await classifier.evaluate(cand.id, { safety: "fail" });
    expect(d.outcome).toBe("human_approved");
    expect(d.skill).toBeDefined();
    expect(repo.promoteCalls).toEqual([cand.id]);
    // 人工终态不重复进人工队列。
    expect(store.enqueued.size).toBe(0);
  });

  it("同一技能：自动门本会晋升（双门满足），但人工 rejected 胜出、不晋升", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand], { humanVerdicts: { [cand.id]: { decision: "rejected", reviewed_by: "admin-1" } } });
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("human_rejected");
    expect(repo.promoteCalls).toHaveLength(0);
    expect((await store.getCandidate(cand.id))?.status).toBe("rejected");
    expect(store.enqueued.size).toBe(0);
  });

  it("人工 approved 终态对升级条件也优先：即便安全边界存疑也不再升级人工队列", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setup([cand], { humanVerdicts: { [cand.id]: { decision: "approved", reviewed_by: "admin-1" } } });
    const d = await classifier.evaluate(cand.id, { safety: "boundary" });
    expect(d.outcome).toBe("human_approved");
    expect(repo.promoteCalls).toEqual([cand.id]);
    expect(store.enqueued.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// (c) 未触发升级的绝大多数候选由自动门直接晋升/拒绝、不进人工队列
// ═══════════════════════════════════════════════════════════════════

describe("(c) 自动门为主：绝大多数候选不进人工队列（10.4）", () => {
  it("一批正常候选全部经自动门晋升/拒绝，人工队列为空", async () => {
    const promote = Array.from({ length: 8 }, () => mkCandidate({ status: "proven", contributor_reuse_success: N_HARD }));
    const reject = Array.from({ length: 5 }, () => mkCandidate({ status: "proven" }));
    const { classifier, store } = setup([...promote, ...reject]);

    let promoted = 0;
    let rejected = 0;
    for (const c of promote) {
      const d = await classifier.evaluate(c.id, { safety: "pass", sanitize: "pass" });
      if (d.outcome === "promoted") promoted++;
    }
    for (const c of reject) {
      const d = await classifier.evaluate(c.id, { safety: "fail" });
      if (d.outcome === "rejected") rejected++;
    }
    expect(promoted).toBe(8);
    expect(rejected).toBe(5);
    // 绝大多数（此处全部）走自动门，人工队列为空。
    expect(store.enqueued.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// admin 鉴权拒绝：非管理员调用人工审核入口被拒、不执行审核动作（10.10）
// ═══════════════════════════════════════════════════════════════════

describe("admin 鉴权拒绝（10.10）", () => {
  const ORIG = process.env.WENLU_ADMIN_USER_IDS;
  afterEach(() => {
    process.env.WENLU_ADMIN_USER_IDS = ORIG;
  });

  function mockRes() {
    const res: { statusCode?: number; body?: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    return res;
  }

  it("管理员（命中名单）放行，进入审核动作", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1,admin-2";
    const next = vi.fn();
    const res = mockRes();
    requireAdmin({ user: { userId: "admin-2" } } as never, res as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("非管理员的已登录用户 → 403，不放行（不执行审核动作）", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1";
    const next = vi.fn();
    const res = mockRes();
    requireAdmin({ user: { userId: "normal-user" } } as never, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("未登录（无身份）→ 401，不放行", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1";
    const next = vi.fn();
    const res = mockRes();
    requireAdmin({} as never, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
