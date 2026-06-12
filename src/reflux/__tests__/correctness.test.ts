/**
 * 技能反哺（Skill Reflux）· 正确性不变量断言测试（任务 19.4）
 * ------------------------------------------------------------------
 * 把 design.md「Correctness Properties」的 8 条不变量逐条写成断言测试。
 * 全程用各模块内存实现 + 注入桩组装最小链路，独立可跑（不连真实 PG / 真实 LLM /
 * 真实连接器 / 真实宪法）。
 *
 * - Property 1 晋升不可绕过（Validates: Requirements 16.3, 16.4, 10.2, 10.5）
 * - Property 2 隐私零泄漏（Validates: Requirements 2.7, 5.1, 5.2）
 * - Property 3 懂人隔离（Validates: Requirements 18.1, 18.2, 18.3）
 * - Property 4 跨用户广度真实（Validates: Requirements 6.6, 17.2）
 * - Property 5 平台可用性只认连接器（Validates: Requirements 8.2, 8.3, 15.8）
 * - Property 6 retired 单向且不再分发（Validates: Requirements 10.7, 10.8, 12.3）
 * - Property 7 采集零 LLM 且不阻塞主链（Validates: Requirements 20.1, 20.2）
 * - Property 8 finish_task done 非成功（Validates: Requirements 2.6, 16.5）
 */

import { describe, expect, it, vi } from "vitest";

import {
  createClassifier,
  createInMemoryClassifierStore,
  type ClassifierDeps,
} from "../classifier.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import { createInMemorySkillRepo, type SkillDraft, type SkillRepo } from "../skillRepo.js";
import { sanitizeCandidate } from "../sanitizer.js";
import { createHarvester, isPrivacySignal, SYSTEM_USER_LOCAL, type HarvestQueryFn } from "../harvester.js";
import { createDispatcher } from "../dispatcher.js";
import type { ConflictFreeResult, Deduplicator } from "../deduplicator.js";
import type { SoftReviewResult, Verifier } from "../verifier.js";
import type {
  Skill,
  SkillCandidate,
  SkillSummary,
  PlatformVariant,
  VerifyStatus,
  VariantOS,
} from "../types.js";
import type { SkillSpec } from "../../skill-flywheel/index.js";
import type { TrajectoryBuffer } from "../trajectoryBuffer.js";

// ─────────────────────────────────────────────────────────────────
// 共用构造器 / 桩
// ─────────────────────────────────────────────────────────────────

const N_HARD = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_hard; // 3
const NOW = "2024-01-01T00:00:00.000Z";

let candSeq = 0;
function mkCandidate(over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: over.id ?? `cand-${++candSeq}`,
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
    created_at: NOW,
    updated_at: NOW,
  };
}

/** 记录 promote 调用的 skillRepo 桩（仅实现 classifier 用到的 promote/get）。 */
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

function mkSkill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    kind: over.kind ?? "executable",
    title: over.title ?? "open app",
    description: over.description ?? "open an application",
    exec_vars: [],
    exec_steps: [],
    taxonomy: { taskType: "generic" },
    category: over.category ?? "automation",
    tags: over.tags ?? [],
    platform: over.platform ?? ["any"],
    os_scope: over.os_scope ?? "variant",
    source: "self_learned",
    user_neutral: true,
    is_starter: false,
    status: over.status ?? "active",
    version: 1,
    provenance: { createdAt: NOW, verifiedCount: 0, totalCount: 0 },
    quality: { use_count: 0, success_count: 0, success_rate: over.quality?.success_rate ?? 0, silent_count: 0 },
    cross_user_breadth: over.cross_user_breadth ?? 1,
    variants: over.variants ?? [],
    created_at: NOW,
    updated_at: NOW,
  };
}

const CONFLICT_FREE: ConflictFreeResult = { conflictFree: true, ambiguous: false, reason: "no conflict" };

function makeDedupStub(result: ConflictFreeResult = CONFLICT_FREE): Pick<Deduplicator, "isConflictFree"> {
  return { async isConflictFree(): Promise<ConflictFreeResult> { return result; } };
}

function makeVerifierStub(pass = true): Pick<Verifier, "reviewSoft"> {
  return { async reviewSoft(): Promise<SoftReviewResult> { return { score: pass ? 0.9 : 0.1, pass }; } };
}

function setupClassifier(
  candidates: SkillCandidate[],
  opts: { cf?: ConflictFreeResult; onPromoteToKb?: ClassifierDeps["onPromoteToKb"]; humanVerdicts?: Record<string, { decision: "approved" | "rejected"; reviewed_by: string }> } = {},
) {
  const store = createInMemoryClassifierStore({ candidates, humanVerdicts: opts.humanVerdicts });
  const repo = makeSkillRepoStub();
  const classifier = createClassifier({
    skillRepo: repo,
    deduplicator: makeDedupStub(opts.cf),
    verifier: makeVerifierStub(true),
    store,
    onPromoteToKb: opts.onPromoteToKb,
    config: DEFAULT_REFLUX_CONFIG,
  });
  return { classifier, store, repo };
}

function execDraft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    kind: "executable",
    title: "压缩为 zip",
    description: "将目录压缩为 zip",
    exec_vars: ["dir", "out"],
    exec_steps: [{ op: "exec", args: { command: "zip -r ${out} ${dir}" } } as never],
    taxonomy: { taskType: "file-ops" } as never,
    category: "file",
    tags: ["zip"],
    platform: ["win"],
    os_scope: "variant",
    source: "self_learned",
    user_neutral: true,
    variants: [{ os: "win", command: "Compress-Archive ${dir} ${out}" }],
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Property 1: 晋升不可绕过（系统自动门为主、人工终态优先不被推翻）
// Validates: Requirements 16.3, 16.4, 10.2, 10.5
// ═══════════════════════════════════════════════════════════════════

describe("Property 1: 晋升不可绕过", () => {
  it("未 proven 的候选无论如何都无法进入 active（Promotion_Gate 首项）", async () => {
    const cand = mkCandidate({ status: "seeded", contributor_reuse_success: N_HARD });
    const { classifier, repo } = setupClassifier([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass", highScore: true });
    expect(d.outcome).toBe("pending");
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("缺任一合取项即不晋升：安全失败→拒绝、脱敏失败→拒绝、双门第二项缺失→pending（16.4）", async () => {
    // 安全失败
    {
      const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
      const { classifier, repo } = setupClassifier([cand]);
      const d = await classifier.evaluate(cand.id, { safety: "fail" });
      expect(d.outcome).toBe("rejected");
      expect(repo.promoteCalls).toHaveLength(0);
    }
    // 脱敏失败
    {
      const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
      const { classifier, repo } = setupClassifier([cand]);
      const d = await classifier.evaluate(cand.id, { sanitize: "fail" });
      expect(d.outcome).toBe("rejected");
      expect(repo.promoteCalls).toHaveLength(0);
    }
    // proven 但复用<N 且非 High_Score（双门第二合取项缺失）
    {
      const cand = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
      const { classifier, repo } = setupClassifier([cand]);
      const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass", highScore: false });
      expect(d.outcome).toBe("pending");
      expect(repo.promoteCalls).toHaveLength(0);
    }
  });

  it("四项齐备（proven∧安全∧脱敏∧复用≥N）才由自动门晋升 active（10.2）", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, repo } = setupClassifier([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass" });
    expect(d.outcome).toBe("promoted");
    expect(repo.promoteCalls).toEqual([cand.id]);
  });

  it("系统判不准（如安全边界）置 pending_review 不自动晋升/拒绝（10.5）", async () => {
    const cand = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const { classifier, store, repo } = setupClassifier([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "boundary" });
    expect(d.outcome).toBe("escalated");
    expect(store.enqueued.has(cand.id)).toBe(true);
    expect(repo.promoteCalls).toHaveLength(0);
  });

  it("人工终态最高优先：自动门不推翻 human approved / rejected（10.7 — Property 1 边界）", async () => {
    // 人工 rejected：即便双门满足也不被晋升。
    const c1 = mkCandidate({ status: "proven", contributor_reuse_success: N_HARD });
    const s1 = setupClassifier([c1], { humanVerdicts: { [c1.id]: { decision: "rejected", reviewed_by: "admin" } } });
    const d1 = await s1.classifier.evaluate(c1.id, { safety: "pass", sanitize: "pass" });
    expect(d1.outcome).toBe("human_rejected");
    expect(s1.repo.promoteCalls).toHaveLength(0);

    // 人工 approved：即便安全失败也不被自动门推翻。
    const c2 = mkCandidate({ status: "proven", contributor_reuse_success: 0 });
    const s2 = setupClassifier([c2], { humanVerdicts: { [c2.id]: { decision: "approved", reviewed_by: "admin" } } });
    const d2 = await s2.classifier.evaluate(c2.id, { safety: "fail" });
    expect(d2.outcome).toBe("human_approved");
    expect(s2.repo.promoteCalls).toEqual([c2.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 2: 隐私零泄漏
// Validates: Requirements 2.7, 5.1, 5.2
// ═══════════════════════════════════════════════════════════════════

describe("Property 2: 隐私零泄漏", () => {
  const cleanSpec: SkillSpec = {
    id: "s1",
    name: "压缩目录",
    when: { taskPattern: "把 ${dir} 压缩为 ${out}", preconditions: [] },
    exec: { vars: ["dir", "out"], steps: [{ op: "exec", args: { a1: "${dir}" } }] },
    done: "完成",
    verify: { kind: "exit-code", spec: "" },
    platform: ["win"],
    platformLocked: true,
    taxonomy: { taskType: "file-ops" },
    provenance: { createdAt: NOW, verifiedCount: 1, totalCount: 1 },
  };

  it("来自 understand_user/userModel/个人 beliefs 的草稿字段被整字段剔除（5.1/5.3）", () => {
    const res = sanitizeCandidate({
      skill: cleanSpec,
      draft: {
        title: "压缩目录",
        understand_user: { 主人偏好: "深色主题" },
        userModel: { 性格: "急躁" },
        owner_belief: "主人不喜欢被打断",
        method: "通用压缩方法",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.understand_user).toBeUndefined();
      expect(res.draft.userModel).toBeUndefined();
      expect(res.draft.owner_belief).toBeUndefined();
      expect(res.draft.method).toBe("通用压缩方法"); // 可泛化方法保留
      expect(res.audit.removed_fields).toEqual(
        expect.arrayContaining(["understand_user", "userModel", "owner_belief"]),
      );
    }
  });

  it("scanResidualPrivacy 判 clean=false → 拒绝候选、不进去重（5.2）", () => {
    const leakySpec: SkillSpec = {
      ...cleanSpec,
      // exec 残留具体隐私值（未占位化的绝对家目录路径）→ scanResidualPrivacy 不 clean。
      exec: { vars: [], steps: [{ op: "open", args: { a1: "/Users/zhangsan/secret.txt" } }] },
    };
    const res = sanitizeCandidate({ skill: leakySpec, draft: { title: "open" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.audit.scan.clean).toBe(false);
  });

  it("采集 Entry_Gate：隐私来源信号永不入队（2.7）", () => {
    expect(isPrivacySignal({ signal_role: "soft_seed", source_tool: "understand_user", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} })).toBe(true);
    expect(isPrivacySignal({ signal_role: "soft_seed", source_tool: "userModel", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} })).toBe(true);
    expect(isPrivacySignal({ signal_role: "soft_seed", source_tool: "consolidate", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: { owner_belief: "x" } })).toBe(true);
    // 可泛化中立信号不误伤
    expect(isPrivacySignal({ signal_role: "soft_seed", source_tool: "add_rule", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: { rule: "提交前先跑测试" } })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 3: 懂人隔离
// Validates: Requirements 18.1, 18.2, 18.3
// ═══════════════════════════════════════════════════════════════════

describe("Property 3: 懂人隔离", () => {
  it("技能/候选/继承数据模型不含 beliefs/userModel 字段（继承是能力，不写对用户的判断）", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit({
      draft: execDraft(),
      source_role: "executable_seed",
      source_weight: "user_task",
      contributor_id: "user-a",
    });
    const skill = await repo.promote(cand.id);

    const forbidden = ["beliefs", "belief", "userModel", "persona", "owner_belief"];
    const skillKeys = Object.keys(skill);
    const candKeys = Object.keys(cand);
    for (const f of forbidden) {
      expect(skillKeys).not.toContain(f);
      expect(candKeys).not.toContain(f);
    }
  });

  it("sanitizer 是懂人隔离的执行点：剔除一切对具体主人的理解后才进入候选（18.2/18.3）", () => {
    const spec: SkillSpec = {
      id: "s1", name: "n", when: { taskPattern: "p", preconditions: [] },
      exec: { vars: [], steps: [{ op: "noop", args: {} }] }, done: "d",
      verify: { kind: "exit-code", spec: "" }, platform: ["any"], platformLocked: false,
      taxonomy: { taskType: "generic" }, provenance: { createdAt: NOW, verifiedCount: 1, totalCount: 1 },
    };
    const res = sanitizeCandidate({
      skill: spec,
      draft: { title: "n", persona: { 主人: "急性子" }, beliefs: ["主人讨厌等待"], steps: "通用步骤" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.persona).toBeUndefined();
      expect(res.draft.beliefs).toBeUndefined();
      expect(res.draft.steps).toBe("通用步骤");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 4: 跨用户广度真实
// Validates: Requirements 6.6, 17.2
// ═══════════════════════════════════════════════════════════════════

describe("Property 4: 跨用户广度真实", () => {
  it("cross_user_breadth 恒等于 skill_contributor 中不同 user_id 数", async () => {
    const repo = createInMemorySkillRepo();
    const c1 = await repo.submit({ draft: execDraft(), source_role: "executable_seed", source_weight: "user_task", contributor_id: "user-a" });
    const skill = await repo.promote(c1.id);
    expect(skill.cross_user_breadth).toBe(1);

    // 新用户合并 → 广度 +1。
    const c2 = await repo.submit({ draft: execDraft(), source_role: "executable_seed", source_weight: "user_task", contributor_id: "user-b" });
    const m1 = await repo.merge(c2.id, skill.id);
    expect(m1.cross_user_breadth).toBe(2);

    // 同一用户重复贡献不增加广度（PK 去重）。
    const c3 = await repo.submit({ draft: execDraft(), source_role: "executable_seed", source_weight: "user_task", contributor_id: "user-b" });
    const m2 = await repo.merge(c3.id, skill.id);
    expect(m2.cross_user_breadth).toBe(2);

    // 不变量：广度 == 去重后贡献者数。
    const contribs = await repo.contributors(skill.id);
    const distinct = new Set(contribs.map((c) => c.user_id)).size;
    const got = await repo.get(skill.id);
    expect(got!.cross_user_breadth).toBe(distinct);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 5: 平台可用性只认连接器
// Validates: Requirements 8.2, 8.3, 15.8
// ═══════════════════════════════════════════════════════════════════

describe("Property 5: 平台可用性只认连接器", () => {
  function mkVariant(os: VariantOS, status: VerifyStatus): PlatformVariant {
    return { skill_id: "s1", os, command: "do ${x}", verify_status: status, fail_streak: 0 };
  }

  function dispatcherForSkill(skill: Skill) {
    const summary: SkillSummary = {
      id: skill.id, name: skill.title, description: skill.description,
      category: skill.category, tags: skill.tags, quality_score: 0.9, platform_variant_count: (skill.variants ?? []).length,
    };
    const repo = {
      async search(): Promise<SkillSummary[]> { return [summary]; },
      async get(id: string): Promise<Skill | null> { return id === skill.id ? skill : null; },
    } as unknown as SkillRepo;
    return createDispatcher({ repo, renderHint: { async get() { return "win 渲染提示"; } } });
  }

  it("仅 connector-verified 变体才判为该平台可用（verified、可直发）", async () => {
    const skill = mkSkill("s1", { kind: "executable", os_scope: "variant", platform: ["win"], variants: [mkVariant("win", "connector-verified")] });
    const res = await dispatcherForSkill(skill).retrieve({ userId: "u", platform: "win" });
    expect(res).toHaveLength(1);
    expect(res[0].platform_status).toBe("verified");
    expect(res[0].dispatchable).toBe(true);
    expect(res[0].unverified_on_platform).toBe(false);
  });

  it("server-verified 永不充当平台可用判据（仍标 needs_render / 未在你平台验证）", async () => {
    const skill = mkSkill("s1", { kind: "executable", os_scope: "variant", platform: ["win"], variants: [mkVariant("win", "server-verified")] });
    const res = await dispatcherForSkill(skill).retrieve({ userId: "u", platform: "win" });
    expect(res[0].platform_status).toBe("needs_render");
    expect(res[0].unverified_on_platform).toBe(true);
    expect(res[0].summary.platform_verified).toBe(false);
  });

  it("unverified 变体同样不充当平台可用判据（needs_render）", async () => {
    const skill = mkSkill("s1", { kind: "executable", os_scope: "variant", platform: ["win"], variants: [mkVariant("win", "unverified")] });
    const res = await dispatcherForSkill(skill).retrieve({ userId: "u", platform: "win" });
    expect(res[0].platform_status).toBe("needs_render");
    expect(res[0].unverified_on_platform).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 6: retired 单向且不再分发
// Validates: Requirements 10.7, 10.8, 12.3
// ═══════════════════════════════════════════════════════════════════

describe("Property 6: retired 单向且不再分发", () => {
  it("retired 后不可改回 active、不再被检索，但数据不物删（已继承者仍可用）", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit({ draft: execDraft({ tags: ["zip"] }), source_role: "executable_seed", source_weight: "user_task", contributor_id: "user-a" });
    const skill = await repo.promote(cand.id);

    // active 时可检索。
    const before = await repo.search({ tags: ["zip"] });
    expect(before.map((s) => s.id)).toContain(skill.id);

    await repo.setStatus(skill.id, "retired");

    // 不再被检索分发（12.3）。
    const after = await repo.search({ tags: ["zip"] });
    expect(after.map((s) => s.id)).not.toContain(skill.id);

    // 数据不物删：get 仍可读回（已继承者仍可用，10.8）。
    const got = await repo.get(skill.id);
    expect(got).not.toBeNull();
    expect(got!.status).toBe("retired");
    expect(got!.retired_at).toBeTruthy();

    // 单向：尝试改回 active 无效（10.7）。
    await repo.setStatus(skill.id, "active");
    const still = await repo.get(skill.id);
    expect(still!.status).toBe("retired");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 7: 采集零 LLM 且不阻塞主链
// Validates: Requirements 20.1, 20.2
// ═══════════════════════════════════════════════════════════════════

describe("Property 7: 采集零 LLM 且不阻塞主链", () => {
  function memQuery(opts: { fail?: boolean } = {}) {
    const calls: Array<{ sql: string }> = [];
    const query: HarvestQueryFn = async (text) => {
      if (opts.fail) throw new Error("模拟 DB 故障");
      calls.push({ sql: text.replace(/\s+/g, " ").trim() });
      return { rows: [] };
    };
    return { calls, query };
  }
  function memTrajectory(opts: { fail?: boolean } = {}): TrajectoryBuffer {
    return {
      async recordAction() { if (opts.fail) throw new Error("轨迹写故障"); },
      async getRecent() { return []; },
      async pruneTrajectory() { return 0; },
    };
  }

  it("采集全路径副作用仅为 DB 写 / 轨迹写，无任何 LLM provider 介入（20.2）", async () => {
    const q = memQuery();
    const h = createHarvester({ query: q.query, trajectory: memTrajectory() });
    await h.enqueue({ signal_role: "soft_seed", source_tool: "add_rule", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} });
    await h.onVerifyPassed("v1", "e", { task_id: "t1" }, { contributor_id: SYSTEM_USER_LOCAL, source_weight: "user_task" });
    await h.recordInvocation({ user_id: SYSTEM_USER_LOCAL, command_fingerprint: "fp", outcome: "success" });
    // 写库 SQL 只触达 skill_harvest_queue / skill_invocation_event（夹具无 LLM 能力）。
    expect(q.calls.every((c) => /INSERT INTO (skill_harvest_queue|skill_invocation_event)/i.test(c.sql))).toBe(true);
  });

  it("任何 hook 异常都被吞掉、不向上抛（不阻塞主链，20.1/A4）", async () => {
    const onError = vi.fn();
    const hDbFail = createHarvester({ query: memQuery({ fail: true }).query, trajectory: memTrajectory(), onError });
    const ok = await hDbFail.enqueue({ signal_role: "soft_seed", source_tool: "add_rule", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} });
    expect(ok).toBe(false);
    await expect(hDbFail.recordInvocation({ user_id: SYSTEM_USER_LOCAL, command_fingerprint: "fp", outcome: "pending" })).resolves.toBeUndefined();

    const hTrajFail = createHarvester({ query: memQuery().query, trajectory: memTrajectory({ fail: true }), onError });
    await expect(hTrajFail.recordAction({ user_id: SYSTEM_USER_LOCAL, action_name: "x" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 8: finish_task done 非成功
// Validates: Requirements 2.6, 16.5
// ═══════════════════════════════════════════════════════════════════

describe("Property 8: finish_task done 非成功", () => {
  it("stashTrajectory（finish_task done）仅落轨迹、绝不入队为成功信号（2.6）", async () => {
    const calls: Array<{ sql: string }> = [];
    const query: HarvestQueryFn = async (text) => { calls.push({ sql: text.replace(/\s+/g, " ").trim() }); return { rows: [] }; };
    const actions: unknown[] = [];
    const trajectory: TrajectoryBuffer = {
      async recordAction(ev) { actions.push(ev); },
      async getRecent() { return []; },
      async pruneTrajectory() { return 0; },
    };
    const h = createHarvester({ query, trajectory });
    await h.stashTrajectory("task-done", [{ action_name: "run", args_summary: "x", result_summary: "done" }], "目标", "done", {
      contributor_id: SYSTEM_USER_LOCAL, source_weight: "user_task",
    });
    // 不入队任何 skill_harvest_queue 成功信号。
    expect(calls.some((c) => /INSERT INTO skill_harvest_queue/i.test(c.sql))).toBe(false);
    // 仅落轨迹。
    expect(actions.length).toBeGreaterThan(0);
  });

  it("done 充当的非 proven 候选无法通过 Promotion_Gate（done 不单独满足 proven，16.5）", async () => {
    // 用 seeded 候选表示「仅有 finish_task done、未经真值闸点亮 proven」的情形。
    const cand = mkCandidate({ status: "seeded", contributor_reuse_success: N_HARD });
    const { classifier, repo } = setupClassifier([cand]);
    const d = await classifier.evaluate(cand.id, { safety: "pass", sanitize: "pass", highScore: true });
    expect(d.outcome).toBe("pending");
    expect(repo.promoteCalls).toHaveLength(0);
  });
});
