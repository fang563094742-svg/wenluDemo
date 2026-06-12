/**
 * 技能反哺（Skill Reflux）· 集成端到端测试（任务 19.1）
 * ------------------------------------------------------------------
 * 端到端走全链路：采集 → 蒸馏 → 去重 → 验证 → 晋升 → 分发 → 回写。
 *
 * 两部分：
 *  1) 内存全链路集成（始终运行，不连真实 PG / 真实 LLM / 真实连接器）：用各模块的内存实现
 *     / 注入桩组装最小链路，串起 Harvester→Distiller→Deduplicator→Verifier→Classifier→
 *     Dispatcher→Feedback_Writer，分别覆盖 executable 与 soft 两类技能。
 *  2) 临时 PG 端到端（仅本机 PG 可连时运行，连不上自动跳过并注明）：仅应用**本 spec 的增量
 *     迁移 006**（含幂等二次应用，不含 capability-pool 基础表统一），在事务内以原生 SQL 串起
 *     全链路涉及的反哺表，最后 ROLLBACK 不污染真实库。
 *
 * Validates: Requirements 1.4, 全链路
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createHarvester, SYSTEM_USER_LOCAL, type HarvestQueryFn } from "../harvester.js";
import { createDistiller, type DistillStore } from "../distiller.js";
import { createDeduplicator, type DedupStore } from "../deduplicator.js";
import { createVerifier, type ConnectorLike, type ConnectorExecResult, type SoftSkillReviewer } from "../verifier.js";
import { createClassifier, createInMemoryClassifierStore } from "../classifier.js";
import { createDispatcher } from "../dispatcher.js";
import { createFeedbackWriter } from "../feedbackWriter.js";
import { createInMemorySkillRepo, type SkillDraft, type SkillRepo } from "../skillRepo.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { TrajectoryBuffer } from "../trajectoryBuffer.js";
import type { HarvestSignal, SkillCandidate, TrajectoryEvent } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const N_HARD = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_hard; // 3
const N_SOFT = DEFAULT_REFLUX_CONFIG.Promotion_Threshold_N_soft; // 5

// ─────────────────────────────────────────────────────────────────
// 桩：采集（mock query + mock 轨迹缓冲，零 LLM）
// ─────────────────────────────────────────────────────────────────

function memQuery() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query: HarvestQueryFn = async (text, params = []) => {
    calls.push({ sql: text.replace(/\s+/g, " ").trim(), params });
    return { rows: [] };
  };
  return { calls, query };
}
const memTrajectory: TrajectoryBuffer = {
  async recordAction() {},
  async getRecent() { return []; },
  async pruneTrajectory() { return 0; },
};

// ─────────────────────────────────────────────────────────────────
// 桩：蒸馏 DistillStore（吐出给定信号 + 轨迹；候选落入本地数组）
// ─────────────────────────────────────────────────────────────────

function makeDistillStore(
  signals: HarvestSignal[],
  trajByTask: Record<string, TrajectoryEvent[]>,
): DistillStore & { inserted: SkillCandidate[] } {
  const inserted: SkillCandidate[] = [];
  let n = 0;
  return {
    inserted,
    async fetchPendingSignals(limit) { return signals.slice(0, limit); },
    async fetchTrajectory(signal) { return signal.task_id ? (trajByTask[signal.task_id] ?? []) : []; },
    async markSignalStatus() {},
    async insertCandidate(c) {
      const id = `distilled-${++n}`;
      inserted.push({ ...c, id });
      return id;
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 桩：去重 DedupStore（基于真实内存 repo 取候选 / 分桶）
// ─────────────────────────────────────────────────────────────────

function makeDedupStore(repo: SkillRepo): DedupStore & { suspects: string[] } {
  const suspects: string[] = [];
  return {
    suspects,
    async getCandidate(id) { return repo.getCandidate(id); },
    async findBucket(input) {
      const all = await repo.list({ status: "active", kind: input.kind });
      // 同 category 或 tags 重叠才入桶（与 PG 分桶语义一致）。
      return all.filter(
        (s) =>
          (input.category && s.category === input.category) ||
          (input.tags.length > 0 && s.tags.some((t) => input.tags.includes(t))),
      );
    },
    async markSuspectDuplicate(id) { suspects.push(id); },
  };
}

// ─────────────────────────────────────────────────────────────────
// 桩：连接器（验证恒通过）/ 软技能评审器（恒通过）
// ─────────────────────────────────────────────────────────────────

function makePassConnector(): ConnectorLike {
  return {
    async request<T>(_op: "exec", _args: Record<string, unknown>): Promise<T> {
      return { ok: true, stdout: "ok", code: 0 } as ConnectorExecResult as unknown as T;
    },
    isOnline: () => true,
    activeInfo: () => ({ platform: "win", machineLabel: "user-pc" }),
  };
}
const passReviewer: SoftSkillReviewer = { async review() { return { score: 0.95, pass: true }; } };

// 把蒸馏候选 draft 映射为 repo 可物化的 SkillDraft（桥接蒸馏产物 → 数据访问层）。
function toSkillDraft(c: SkillCandidate): SkillDraft {
  const d = c.draft as Record<string, unknown>;
  const exec = (d.exec ?? { vars: [], steps: [] }) as { vars?: string[]; steps?: unknown[] };
  const pv = d.platform_variant as { os: "mac" | "win" | "linux"; command: string } | undefined;
  return {
    kind: c.kind,
    title: String(d.title ?? "skill"),
    description: String(d.description ?? ""),
    applicable_scenario: typeof d.applicable_scenario === "string" ? d.applicable_scenario : undefined,
    exec_vars: Array.isArray(exec.vars) ? (exec.vars as string[]) : [],
    exec_steps: (Array.isArray(exec.steps) ? exec.steps : []) as never,
    taxonomy: (d.taxonomy ?? { taskType: "generic" }) as never,
    category: c.category ?? "general",
    tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
    platform: [(d.platform ?? "any") as "mac" | "win" | "linux" | "any"],
    os_scope: c.kind === "executable" ? "variant" : "any",
    source: "self_learned",
    user_neutral: c.user_neutral ?? true,
    variants: pv ? [{ os: pv.os, command: pv.command }] : [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1) 内存全链路集成
// ═══════════════════════════════════════════════════════════════════

describe("内存全链路集成 · executable（采集→蒸馏→去重→验证→晋升→分发→回写）", () => {
  it("一条可执行技能贯穿全链路并最终被检索分发、回写质量分", async () => {
    const repo = createInMemorySkillRepo();
    const userId = "11111111-1111-1111-1111-111111111111";

    // —— 采集 —— harvester 接受信号（零 LLM，只入队）。
    const q = memQuery();
    const harvester = createHarvester({ query: q.query, trajectory: memTrajectory });
    const signal: HarvestSignal = {
      id: "sig-1",
      signal_role: "executable_seed",
      source_tool: "forge_capability",
      source_weight: "user_task",
      contributor_id: userId,
      payload: { goal: "压缩目录", platform: "win", taskType: "file-ops" },
      task_id: "task-e2e",
      status: "pending",
      enqueued_at: new Date().toISOString(),
    };
    const enqueued = await harvester.enqueue(signal);
    expect(enqueued).toBe(true);
    expect(q.calls.every((c) => /INSERT INTO skill_harvest_queue/i.test(c.sql))).toBe(true);

    // —— 蒸馏 —— 关联轨迹（achieved 步骤）→ distillSkill → 二期扩展候选。
    const traj: TrajectoryEvent[] = [
      { user_id: userId, task_id: "task-e2e", action_name: "exec zip", args_summary: "zip -r out dir", result_summary: "ok", ts: new Date().toISOString() },
    ];
    const distillStore = makeDistillStore([signal], { "task-e2e": traj });
    const distiller = createDistiller({ store: distillStore }); // 无 LLM → 确定性扩展
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    const distilled = report.candidates[0];
    expect(distilled.kind).toBe("executable");

    // 桥接到数据访问层：写入候选（seeded），得到可被下游使用的 repo 候选 id。
    const repoCand = await repo.submit({
      draft: toSkillDraft(distilled),
      source_role: distilled.source_role,
      source_weight: distilled.source_weight,
      contributor_id: userId,
    });

    // —— 去重 —— 库内同桶无技能 → 新候选（new）。
    const dedup = createDeduplicator({ repo, store: makeDedupStore(repo) });
    const dedupResult = await dedup.dedup(repoCand.id);
    expect(dedupResult.decision).toBe("new");

    // —— 验证 —— 经 mock 连接器跑通 → connector-verified（平台可用唯一依据）。
    const verifier = createVerifier({ connector: makePassConnector(), softReviewer: passReviewer, store: { async markServerVerified() {}, async markConnectorVerified() {}, async recordVariantFailure() { return { failStreak: 0, downgraded: false }; } } });
    const verifyRes = await verifier.verifyExecutable({ command: "node --version", os: "win", viaConnector: true });
    expect(verifyRes.status).toBe("connector-verified");
    expect(verifyRes.passed).toBe(true);

    // —— 晋升 —— proven + 双门（复用≥N）→ 自动门物化 active。
    const classifierStore = createInMemoryClassifierStore({
      candidates: [{ ...repoCand, status: "proven", contributor_reuse_success: N_HARD }],
    });
    const classifier = createClassifier({
      skillRepo: repo,
      deduplicator: dedup,
      verifier,
      store: classifierStore,
      config: DEFAULT_REFLUX_CONFIG,
    });
    const decision = await classifier.evaluate(repoCand.id, { safety: "pass", sanitize: "pass" });
    expect(decision.outcome).toBe("promoted");
    const skillId = decision.skill!.id;
    const promoted = await repo.get(skillId);
    expect(promoted?.status).toBe("active");

    // —— 分发 —— 检索命中（可执行未验证变体 → needs_render 但仍 dispatchable），expand 展开、inherit 继承。
    const inheritedRecords: string[] = [];
    const dispatcher = createDispatcher({
      repo,
      renderHint: { async get() { return "win 渲染提示"; } },
      inheritFn: async (_u, ids) => { (ids ?? []).forEach((i) => inheritedRecords.push(i)); return (ids ?? []).map((id) => ({ id })); },
    });
    const found = await dispatcher.retrieve({ userId, category: promoted!.category, platform: "win" });
    expect(found.map((r) => r.summary.id)).toContain(skillId);
    const full = await dispatcher.expand(skillId, userId);
    expect(full?.id).toBe(skillId);
    const inherit = await dispatcher.inherit(userId, [skillId]);
    expect(inherit.inherited).toContain(skillId);

    // —— 回写 —— 复用成功回写质量分（use_count/success_rate 更新）。
    const feedback = createFeedbackWriter({
      skillRepo: repo,
      recordSkillUsage: async (_u, sId, success) => { await repo.recordUsage(sId, success); },
    });
    await feedback.recordReuse({ userId, skillId, success: true });
    const afterReuse = await repo.get(skillId);
    expect(afterReuse!.quality.use_count).toBe(1);
    expect(afterReuse!.quality.success_count).toBe(1);
    expect(afterReuse!.quality.success_rate).toBeCloseTo(1.0);
  });
});

describe("内存全链路集成 · soft（采集→蒸馏→去重→软评审验证→晋升→分发→回写）", () => {
  it("一条软技能贯穿全链路并被平台无关地检索分发、回写质量分", async () => {
    const repo = createInMemorySkillRepo();
    const userId = "22222222-2222-2222-2222-222222222222";

    // —— 采集 ——
    const q = memQuery();
    const harvester = createHarvester({ query: q.query, trajectory: memTrajectory });
    const signal: HarvestSignal = {
      id: "sig-soft",
      signal_role: "soft_seed",
      source_tool: "add_rule",
      source_weight: "user_task",
      contributor_id: userId,
      payload: { goal: "提交前先跑测试", taskType: "habit" },
      status: "pending",
      enqueued_at: new Date().toISOString(),
    };
    expect(await harvester.enqueue(signal)).toBe(true);

    // —— 蒸馏 —— soft 无需轨迹（合成最小 spec）。
    const distillStore = makeDistillStore([signal], {});
    const distiller = createDistiller({ store: distillStore });
    const report = await distiller.distillPendingBatch(10);
    expect(report.candidates).toHaveLength(1);
    const distilled = report.candidates[0];
    expect(distilled.kind).toBe("soft");

    const repoCand = await repo.submit({
      draft: toSkillDraft(distilled),
      source_role: distilled.source_role,
      source_weight: distilled.source_weight,
      contributor_id: userId,
    });

    // —— 去重 ——
    const dedup = createDeduplicator({ repo, store: makeDedupStore(repo) });
    expect((await dedup.dedup(repoCand.id)).decision).toBe("new");

    // —— 验证（软评审）+ 晋升 —— 软性类经 LLM 评审点亮 proven，再走 High_Score 分支晋升。
    const verifier = createVerifier({ softReviewer: passReviewer });
    const classifierStore = createInMemoryClassifierStore({
      candidates: [{ ...repoCand, kind: "soft", status: "seeded", contributor_reuse_success: 0 }],
    });
    const classifier = createClassifier({ skillRepo: repo, deduplicator: dedup, verifier, store: classifierStore });
    const lit = await classifier.reviewSoftCandidate(repoCand.id);
    expect(lit.status).toBe("proven");
    const decision = await classifier.evaluate(repoCand.id, { safety: "pass", sanitize: "pass", highScore: true });
    expect(decision.outcome).toBe("promoted");
    const skillId = decision.skill!.id;

    // —— 分发 —— 软技能平台无关，对任意平台直发。
    const dispatcher = createDispatcher({
      repo,
      renderHint: { async get() { return null; } },
      inheritFn: async (_u, ids) => (ids ?? []).map((id) => ({ id })),
    });
    const found = await dispatcher.retrieve({ userId, category: (await repo.get(skillId))!.category, platform: "win" });
    const hit = found.find((r) => r.summary.id === skillId);
    expect(hit).toBeDefined();
    expect(hit!.platform_status).toBe("platform_agnostic");
    expect(hit!.dispatchable).toBe(true);

    // —— 回写 ——
    const feedback = createFeedbackWriter({ skillRepo: repo, recordSkillUsage: async (_u, sId, s) => { await repo.recordUsage(sId, s); } });
    await feedback.recordReuse({ userId, skillId, success: true });
    expect((await repo.get(skillId))!.quality.use_count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2) 临时 PG 端到端（仅本机 PG 可连时运行；仅跑本 spec 增量迁移 006）
// ═══════════════════════════════════════════════════════════════════

async function tryConnect(): Promise<pg.Client | null> {
  const client = new pg.Client({
    host: process.env.WENLU_DB_HOST ?? "127.0.0.1",
    port: parseInt(process.env.WENLU_DB_PORT ?? "5432", 10),
    database: process.env.WENLU_DB_NAME ?? "wenlu",
    user: process.env.WENLU_DB_USER ?? "postgres",
    password: process.env.WENLU_DB_PASSWORD ?? "Wenlu@Pg2026",
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    try { await client.end(); } catch { /* ignore */ }
    return null;
  }
}

describe("临时 PG 端到端（需本机 PG，连不上自动跳过）", () => {
  it("仅跑增量迁移 006（含幂等二次应用），原生 SQL 串起全链路反哺表后 ROLLBACK", async () => {
    const client = await tryConnect();
    if (!client) {
      console.warn("[skip] 未连上本机 PG，跳过 19.1 临时 PG 端到端（内存全链路已覆盖）");
      return;
    }
    const migrationSql = await readFile(resolve(__dirname, "../../db/migrations/006_skill_reflux.sql"), "utf-8");
    const USER = "00000000-0000-0000-0000-0000000000a1";
    const USER2 = "00000000-0000-0000-0000-0000000000a2";
    try {
      await client.query("BEGIN");
      await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // 仅跑本 spec 增量迁移 006 —— 两次应用验证幂等（Req 1.4）。
      await client.query(migrationSql);
      await client.query(migrationSql);

      // —— 采集 —— 入队一条 truth_gate 信号。
      await client.query(
        `INSERT INTO skill_harvest_queue (signal_role, source_tool, source_weight, contributor_id, payload, task_id)
         VALUES ('executable_seed','forge_capability','user_task',$1,'{"goal":"压缩目录"}'::jsonb,'task-pg')`,
        [USER],
      );

      // —— 蒸馏 —— 落一个候选（seeded）。
      const cand = await client.query(
        `INSERT INTO skill_candidate (kind, draft, category, source_role, source_weight, user_neutral, status, contributor_id, contributor_reuse_success)
         VALUES ('executable','{"title":"压缩目录"}'::jsonb,'file-ops','executable_seed','user_task',true,'proven',$1,3)
         RETURNING id`,
        [USER],
      );
      const candId = cand.rows[0].id as string;

      // —— 晋升 —— 物化为 active 公共技能。
      const skill = await client.query(
        `INSERT INTO skill (kind, title, description, category, tags, platform, os_scope, status, provenance)
         VALUES ('executable','压缩目录','把目录压缩为 zip','file-ops', ARRAY['zip'], ARRAY['win'], 'variant', 'active',
                 '{"createdAt":"2024-01-01T00:00:00Z","verifiedCount":0,"totalCount":0}'::jsonb)
         RETURNING id`,
      );
      const skillId = skill.rows[0].id as string;
      await client.query(`UPDATE skill_candidate SET merged_into = $1 WHERE id = $2`, [skillId, candId]);

      // —— 验证 —— 落一个 connector-verified 变体（平台可用唯一依据）。
      await client.query(
        `INSERT INTO skill_platform_variant (skill_id, os, command, verify_status, verified_by)
         VALUES ($1,'win',$2,'connector-verified','user-pc')`,
        [skillId, "Compress-Archive ${dir} ${out}"],
      );

      // —— 跨用户广度 —— 两名贡献者（PK 去重）。
      await client.query(`INSERT INTO skill_contributor (skill_id, user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [skillId, USER, USER2]);
      await client.query(`UPDATE skill SET cross_user_breadth = (SELECT count(DISTINCT user_id) FROM skill_contributor WHERE skill_id=$1) WHERE id=$1`, [skillId]);

      // —— 分发 / 继承 —— 写 user_skill；并记一条调用事件。
      await client.query(`INSERT INTO user_skill (user_id, skill_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [USER2, skillId]);
      await client.query(
        `INSERT INTO skill_invocation_event (user_id, skill_id, command_fingerprint, task_id, platform, outcome)
         VALUES ($1,$2,'compress:win','task-pg','win','success')`,
        [USER2, skillId],
      );

      // —— 回写 —— 质量分更新。
      await client.query(
        `UPDATE skill SET use_count = use_count + 1, success_count = success_count + 1,
           success_rate = (success_count + 1)::real / (use_count + 1)::real WHERE id = $1`,
        [skillId],
      );

      // —— 检索断言 —— active 技能可被检出，广度=2、connector-verified 变体存在、回写生效。
      const got = await client.query(
        `SELECT s.status, s.cross_user_breadth, s.use_count, s.success_count,
                (SELECT count(*) FROM skill_platform_variant v WHERE v.skill_id = s.id AND v.verify_status='connector-verified') AS verified_variants,
                (SELECT count(*) FROM user_skill us WHERE us.skill_id = s.id) AS inherited
           FROM skill s WHERE s.id = $1 AND s.status = 'active'`,
        [skillId],
      );
      expect(got.rows).toHaveLength(1);
      expect(got.rows[0].cross_user_breadth).toBe(2);
      expect(Number(got.rows[0].verified_variants)).toBe(1);
      expect(Number(got.rows[0].inherited)).toBe(1);
      expect(got.rows[0].use_count).toBe(1);
      expect(got.rows[0].success_count).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      try { await client.end(); } catch { /* ignore */ }
    }
  });
});
