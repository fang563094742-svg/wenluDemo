/**
 * Deduplicator 单元测试（Req 6 / 去重·合并，复用 tools/conflictDetector）
 * ------------------------------------------------------------------
 * 聚焦三态决策与复用 conflictDetector 的查重逻辑（不重测 conflictDetector 内核本身）：
 *  - merge / new / suspect_duplicate 三分支（Req 6.1/6.2/6.7）
 *  - 可执行类命令级查重：指纹一致 + conflictDetector 资源冲突 → merge；
 *    指纹一致但资源可并行 → suspect_duplicate（Req 6.4）
 *  - 软性类语义查重：mock LLM 判 duplicate/distinct/ambiguous（Req 6.4）
 *  - 跨用户广度计数：不同用户合并 breadth++、同用户重复贡献不累加（Req 6.3/6.6）
 *  - 分桶规避 O(n²)：单次比对 ≤ Dedup_K（Req 20.5）
 *  - 合并策略 computeMergeStrategy / 指纹 / Jaccard 纯逻辑（Req 6.5）
 *  - Conflict_Free 判定（供 Promotion_Gate 复用）
 *
 * 全程注入内存 store + repo stub + mock LLM，不触达真实 PG。
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 20.5
 */
import { describe, it, expect } from "vitest";
import {
  createDeduplicator,
  commandFingerprint,
  jaccard,
  computeMergeStrategy,
  type DedupStore,
  type DedupSemanticJudge,
  type BucketQuery,
} from "../deduplicator.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { SkillRepo } from "../skillRepo.js";
import type { Skill, SkillCandidate, SkillExecStep } from "../types.js";

// ── 构造器 ──

let skillSeq = 0;
function mkSkill(over: Partial<Skill> = {}): Skill & { _contributors: string[] } {
  const id = over.id ?? `skill_${++skillSeq}`;
  const now = "2024-01-01T00:00:00.000Z";
  const base: Skill = {
    id,
    kind: "executable",
    title: "open app",
    description: "open an application",
    exec_vars: [],
    exec_steps: [],
    taxonomy: { taskType: "generic" },
    category: "automation",
    tags: ["app"],
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
    ...over,
  };
  return { ...base, _contributors: ["u-owner"] };
}

let candSeq = 0;
function mkCandidate(over: Partial<SkillCandidate> = {}, draftOver: Record<string, unknown> = {}): SkillCandidate {
  const id = over.id ?? `cand_${++candSeq}`;
  const now = "2024-02-01T00:00:00.000Z";
  return {
    id,
    kind: "executable",
    draft: {
      title: "open app",
      description: "open an application",
      exec: { vars: [], steps: [] },
      taxonomy: { taskType: "generic" },
      tags: ["app"],
      ...draftOver,
    },
    category: "automation",
    source_role: "executable_seed",
    source_weight: "user_task",
    user_neutral: true,
    status: "seeded",
    contributor_id: "u-contrib",
    contributor_reuse_success: 0,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

// ── 内存夹具：store + repo stub（faithful merge 语义） ──

function makeFixture(opts: {
  candidate: SkillCandidate;
  bucket: Array<Skill & { _contributors: string[] }>;
}) {
  const candidates = new Map<string, SkillCandidate>([[opts.candidate.id, opts.candidate]]);
  const skills = new Map<string, Skill & { _contributors: string[] }>(
    opts.bucket.map((s) => [s.id, s]),
  );
  const mergeCalls: Array<{ candidateId: string; targetSkillId: string }> = [];

  const repo = {
    async merge(candidateId: string, targetSkillId: string): Promise<Skill> {
      mergeCalls.push({ candidateId, targetSkillId });
      const cand = candidates.get(candidateId)!;
      const sk = skills.get(targetSkillId)!;
      // skill_contributor PK 去重：同一 user 只计一次（Req 6.3）。
      if (cand.contributor_id && !sk._contributors.includes(cand.contributor_id)) {
        sk._contributors.push(cand.contributor_id);
      }
      sk.cross_user_breadth = new Set(sk._contributors).size; // Req 6.6
      cand.merged_into = targetSkillId;
      return JSON.parse(JSON.stringify({ ...sk, _contributors: undefined })) as Skill;
    },
  } as unknown as SkillRepo;

  const store: DedupStore = {
    async getCandidate(id) {
      return candidates.get(id) ?? null;
    },
    async findBucket(q: BucketQuery) {
      return [...skills.values()].filter((s) => {
        if (s.status !== "active" || s.kind !== q.kind) return false;
        const catHit = q.category && s.category === q.category;
        const tagHit = q.tags.some((t) => s.tags.includes(t));
        return catHit || tagHit || (!q.category && q.tags.length === 0);
      });
    },
    async markSuspectDuplicate(id) {
      const c = candidates.get(id);
      if (c) c.status = "suspect_duplicate";
    },
  };

  return { candidates, skills, mergeCalls, repo, store };
}

const STEP_OPEN: SkillExecStep[] = [{ op: "open", args: { app: "${app}" } }];
const STEP_READ: SkillExecStep[] = [{ op: "read_file", args: { path: "${p}" } }];

// ─────────────────────────────────────────────────────────────────

describe("纯函数 · commandFingerprint / jaccard", () => {
  it("指纹值/结构无关：args 值占位 → 同结构同指纹", () => {
    const a = commandFingerprint([{ op: "Open", args: { App: "${x}" } }]);
    const b = commandFingerprint([{ op: "open", args: { app: "${x}" } }]);
    expect(a).toBe(b);
  });
  it("不同 op 序列 → 指纹不同", () => {
    expect(commandFingerprint(STEP_OPEN)).not.toBe(commandFingerprint(STEP_READ));
  });
  it("jaccard：相同集合=1，无交集=0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("computeMergeStrategy（Req 6.5）", () => {
  it("主步骤取验证多者、差异入 alternative、最早创建/最新更新", () => {
    const target = mkSkill({
      exec_steps: [{ op: "open", args: {} }, { op: "click", args: {} }],
      provenance: { createdAt: "2024-01-01T00:00:00.000Z", verifiedCount: 5, totalCount: 5 },
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-03-01T00:00:00.000Z",
    });
    const cand = mkCandidate(
      { created_at: "2023-12-01T00:00:00.000Z", updated_at: "2024-02-01T00:00:00.000Z" },
      { exec: { vars: [], steps: [{ op: "open", args: {} }, { op: "screenshot", args: {} }] } },
    );
    const ms = computeMergeStrategy(target, cand);
    // target 验证多 → 主步骤取 target
    expect(ms.main_steps.map((s) => s.op)).toEqual(["open", "click"]);
    // 候选独有的 screenshot 入 alternative
    expect(ms.alternative_steps.map((s) => s.op)).toEqual(["screenshot"]);
    // 最早创建（候选 2023-12）/ 最新更新（target 2024-03）
    expect(ms.created_at).toBe("2023-12-01T00:00:00.000Z");
    expect(ms.updated_at).toBe("2024-03-01T00:00:00.000Z");
  });
});

describe("Deduplicator · 可执行类命令级查重（Req 6.1/6.4）", () => {
  it("指纹一致 + conflictDetector 判定指向同一资源 → merge", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: STEP_OPEN });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("merge");
    expect(res.targetSkillId).toBe(skill.id);
    expect(fx.mergeCalls).toHaveLength(1);
    expect(res.mergeStrategy).toBeDefined();
  });

  it("指纹一致但 conflictDetector 判为可并行（pure-read 无冲突）→ suspect_duplicate", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_READ } });
    const skill = mkSkill({ exec_steps: STEP_READ });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("suspect_duplicate");
    // 标记疑似重复、冻结状态（Req 6.8）
    expect(fx.candidates.get(cand.id)!.status).toBe("suspect_duplicate");
    expect(fx.mergeCalls).toHaveLength(0);
  });

  it("无重复 → new", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: [{ op: "deploy", args: { target: "${t}" } }] });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("new");
    expect(fx.mergeCalls).toHaveLength(0);
  });
});

describe("Deduplicator · 软性类语义查重（mock LLM，Req 6.4）", () => {
  function judge(relation: "duplicate" | "distinct" | "ambiguous"): DedupSemanticJudge {
    return { async compare() { return { relation }; } };
  }
  const softCand = () => mkCandidate({ kind: "soft" }, {});
  const softSkill = () => mkSkill({ kind: "soft" });

  it("LLM 判 duplicate → merge", async () => {
    const cand = softCand();
    const fx = makeFixture({ candidate: cand, bucket: [softSkill()] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store, judge: judge("duplicate") });
    expect((await dedup.dedup(cand.id)).decision).toBe("merge");
  });

  it("LLM 判 distinct → new", async () => {
    const cand = softCand();
    const fx = makeFixture({ candidate: cand, bucket: [softSkill()] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store, judge: judge("distinct") });
    expect((await dedup.dedup(cand.id)).decision).toBe("new");
  });

  it("LLM 判 ambiguous → suspect_duplicate", async () => {
    const cand = softCand();
    const fx = makeFixture({ candidate: cand, bucket: [softSkill()] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store, judge: judge("ambiguous") });
    expect((await dedup.dedup(cand.id)).decision).toBe("suspect_duplicate");
  });
});

describe("Deduplicator · 跨用户广度计数（Req 6.3/6.6）", () => {
  it("不同用户合并 → cross_user_breadth++", async () => {
    const cand = mkCandidate({ contributor_id: "u-new" }, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: STEP_OPEN }); // 既有贡献者 ["u-owner"]
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("merge");
    expect(res.skill!.cross_user_breadth).toBe(2); // u-owner + u-new
  });

  it("同一用户重复贡献 → 广度不累加", async () => {
    const cand = mkCandidate({ contributor_id: "u-owner" }, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: STEP_OPEN }); // 既有贡献者 ["u-owner"]
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("merge");
    expect(res.skill!.cross_user_breadth).toBe(1); // 仍只有 u-owner
  });
});

describe("Deduplicator · 分桶规避 O(n²)（Req 20.5）", () => {
  it("单次比对数受 Dedup_K 封顶", async () => {
    const cand = mkCandidate({ kind: "soft" }, {});
    const bucket = Array.from({ length: 5 }, () => mkSkill({ kind: "soft" }));
    const fx = makeFixture({ candidate: cand, bucket });
    let calls = 0;
    const judge: DedupSemanticJudge = {
      async compare() {
        calls++;
        return { relation: "distinct" };
      },
    };
    const dedup = createDeduplicator({
      repo: fx.repo,
      store: fx.store,
      judge,
      config: { ...DEFAULT_REFLUX_CONFIG, Dedup_K: 2 },
    });
    const res = await dedup.dedup(cand.id);
    expect(res.decision).toBe("new");
    expect(res.comparedCount).toBe(2); // 仅比对前 K=2 个，未做全库两两比对
    expect(calls).toBe(2);
  });
});

describe("Deduplicator · isConflictFree（Promotion_Gate 复用）", () => {
  it("无重复 → conflictFree=true", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: [{ op: "deploy", args: {} }] });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const r = await dedup.isConflictFree(cand.id);
    expect(r.conflictFree).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it("命中重复 → conflictFree=false 且只读不改候选状态", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_OPEN } });
    const skill = mkSkill({ exec_steps: STEP_OPEN });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const r = await dedup.isConflictFree(cand.id);
    expect(r.conflictFree).toBe(false);
    expect(r.ambiguous).toBe(false);
    // 只读：不应触发 merge、不改候选状态
    expect(fx.mergeCalls).toHaveLength(0);
    expect(fx.candidates.get(cand.id)!.status).toBe("seeded");
  });

  it("疑似重复 → conflictFree=false 且 ambiguous=true", async () => {
    const cand = mkCandidate({}, { exec: { vars: [], steps: STEP_READ } });
    const skill = mkSkill({ exec_steps: STEP_READ });
    const fx = makeFixture({ candidate: cand, bucket: [skill] });
    const dedup = createDeduplicator({ repo: fx.repo, store: fx.store });
    const r = await dedup.isConflictFree(cand.id);
    expect(r.conflictFree).toBe(false);
    expect(r.ambiguous).toBe(true);
  });
});
