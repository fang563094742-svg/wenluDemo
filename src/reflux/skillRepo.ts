/**
 * 技能反哺（Skill Reflux）· SkillRepo 数据访问层（skillRepo.ts）
 * ------------------------------------------------------------------
 * 对应 design.md「Data Models」中的 `skill` / `skill_platform_variant` /
 * `skill_candidate` / `skill_contributor` 表族（建表由任务 2 的增量迁移
 * 006_skill_reflux.sql 负责，本模块只写数据访问，不重复建表）。
 *
 * 职责（Req 1.3 持久化 / 11.3 检索分发 / 12.1 质量分回写）：
 *  - 候选 → 公共技能的物化管线数据原语：`submit`（写候选）/ `promote`（候选物化为
 *    active 公共技能）/ `merge`（候选去重合并进既有技能）。
 *  - 公共技能读路径：`get`（含变体/贡献广度）/ `list`（按状态·分类·kind 过滤）/
 *    `search`（category+tags 筛选返回 Skill_Summary，仅 active，渐进加载默认视图）。
 *  - 质量分回写：`recordUsage`（与 provenance 同一事实的两种视图统一更新）。
 *  - 状态与贡献：`setStatus`（active/retired，retired 单向不可逆）/ `contributors`。
 *
 * 技能模型对齐 `src/reflux/types.ts` 的 `Skill` / `SkillCandidate`，并与
 * `skill-flywheel` 的 `SkillSpec`（值/结构分离 `exec.vars`/`exec.steps`、`platform`、
 * `taxonomy`、`provenance`）为同一权威表示。
 *
 * 平台值归一（Req 1.2/1.4）：读路径凡读到旧平台值 `win32`/`darwin` 一律经
 * `src/db/platformNormalize.ts` 归一为 `win`/`mac`，与迁移侧双重保证。
 *
 * 两套实现：
 *  - `createPgSkillRepo`：PG 实现，走 `src/db/pool.ts` 的 `query`/`transaction`，
 *    A1（全量 PG）已就绪可直连真实库。
 *  - `createInMemorySkillRepo`：内存实现，供纯单元测试（不连真实 PG）。
 *
 * _Requirements: 1.3, 11.3, 12.1_
 */

import { query as defaultQuery, transaction as defaultTransaction } from "../db/pool.js";
import {
  normalizePlatformList,
  normalizeVariantOs,
  type NormalizedPlatform,
} from "../db/platformNormalize.js";
import type {
  Skill,
  SkillCandidate,
  SkillSummary,
  SkillExecStep,
  SkillTaxonomy,
  SkillPlatform,
  SkillKind,
  SkillSource,
  OSScope,
  SkillStatus,
  SignalRole,
  SourceWeight,
  VariantOS,
  PlatformVariant,
  TrajectoryRef,
} from "./types.js";

// ── 输入 / 过滤类型 ───────────────────────────────────────────────────────────

/** 蒸馏后用于物化技能的草稿（与 SkillSpec 字段对齐，存入 skill_candidate.draft）。 */
export interface SkillDraft {
  kind: SkillKind;
  title: string;
  description: string;
  applicable_scenario?: string;
  /** 值/结构分离执行体：占位变量列表（对齐 SkillSpec.exec.vars）。 */
  exec_vars: string[];
  /** 值/结构分离执行体：仅保留结构的步骤（对齐 SkillSpec.exec.steps）。 */
  exec_steps: SkillExecStep[];
  taxonomy: SkillTaxonomy;
  category: string;
  tags: string[];
  /** 顶层平台契约，取值 mac/win/linux/any。 */
  platform: SkillPlatform[];
  os_scope: OSScope;
  source: SkillSource;
  user_neutral: boolean;
  /** 可执行技能的各平台变体坯子（soft 技能为空）。 */
  variants?: Array<{ os: VariantOS; command: string }>;
}

/** 提交候选入参（写 skill_candidate，状态 seeded）。 */
export interface SkillSubmitInput {
  draft: SkillDraft;
  source_role: SignalRole;
  source_weight: SourceWeight;
  /** 贡献者 userId（迁移期 System_User 固定为 local UUID）。 */
  contributor_id?: string;
  linked_prediction_id?: string;
  linked_verifiable_id?: string;
  trajectory_ref?: TrajectoryRef;
}

/** `list` 过滤条件（全部可选；不传即不过滤该维度）。 */
export interface SkillListFilter {
  status?: SkillStatus;
  category?: string;
  kind?: SkillKind;
  is_starter?: boolean;
}

/** `search` 检索条件（category + tags 筛选，仅返回 active）。 */
export interface SkillSearchQuery {
  category?: string;
  /** 标签：命中任一即视为匹配（OR 语义）。 */
  tags?: string[];
  /** 继承方平台：可执行技能按此过滤（soft/any 不受限）。 */
  platform?: SkillPlatform;
  /** 返回上限（默认 20）。 */
  limit?: number;
}

/** 技能贡献者条目（skill_contributor 行视图）。 */
export interface SkillContributor {
  skill_id: string;
  user_id: string;
  original_title?: string;
  contributed_at: string;
}

// ── SkillRepo 接口 ───────────────────────────────────────────────────────────

/** 技能数据访问层接口（PG 实现与内存实现共用契约）。 */
export interface SkillRepo {
  /** 提交一个候选到管线（写 skill_candidate，状态 seeded），返回候选。 */
  submit(input: SkillSubmitInput): Promise<SkillCandidate>;
  /** 取候选（含 draft 等），不存在返回 null。 */
  getCandidate(candidateId: string): Promise<SkillCandidate | null>;
  /**
   * 把候选物化为 active 公共技能：依候选 draft 写 `skill`(active, version=1)、
   * 初始化 provenance/质量分、落各平台变体、写首个贡献者；候选 merged_into 指向新技能。
   */
  promote(candidateId: string): Promise<Skill>;
  /**
   * 去重合并：把候选并入既有技能（写贡献者、刷新 cross_user_breadth、
   * 候选 merged_into 指向目标技能），返回合并后的目标技能。
   */
  merge(candidateId: string, targetSkillId: string): Promise<Skill>;
  /** 取单个公共技能（含变体与跨用户广度），不存在返回 null。 */
  get(skillId: string): Promise<Skill | null>;
  /** 列出公共技能（按 status/category/kind/is_starter 过滤）。 */
  list(filter?: SkillListFilter): Promise<Skill[]>;
  /** 检索：category+tags 筛选，仅 active，返回渐进加载默认视图 Skill_Summary。 */
  search(query: SkillSearchQuery): Promise<SkillSummary[]>;
  /** 质量分回写：use_count/success_count/success_rate 与 provenance 同步更新。 */
  recordUsage(skillId: string, success: boolean): Promise<void>;
  /** 设状态：active/retired；retired 单向，不可由 retired 改回 active。 */
  setStatus(skillId: string, status: SkillStatus): Promise<void>;
  /** 列出技能贡献者。 */
  contributors(skillId: string): Promise<SkillContributor[]>;
}

// ── 公共工具：行 → 领域对象映射 ───────────────────────────────────────────────

/** provenance JSONB 缺省骨架（对齐 SkillSpec.provenance）。 */
interface Provenance {
  createdAt: string;
  verifiedCount: number;
  totalCount: number;
}

function normalizeProvenance(raw: unknown, fallbackCreatedAt: string): Provenance {
  const p = (raw ?? {}) as Partial<Provenance>;
  return {
    createdAt: typeof p.createdAt === "string" ? p.createdAt : fallbackCreatedAt,
    verifiedCount: typeof p.verifiedCount === "number" ? p.verifiedCount : 0,
    totalCount: typeof p.totalCount === "number" ? p.totalCount : 0,
  };
}

function toIso(ts: Date | string | null | undefined): string {
  if (ts == null) return "";
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

function toIsoOpt(ts: Date | string | null | undefined): string | undefined {
  if (ts == null) return undefined;
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

/** 计算成功率：totalCount 为 0 时定义为 0。 */
function rate(success: number, total: number): number {
  return total > 0 ? success / total : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PG 实现
// ─────────────────────────────────────────────────────────────────────────────

/** PG 实现可注入的依赖（默认走 `src/db/pool.ts`）。便于单测注入桩。 */
export interface PgSkillRepoDeps {
  query?: typeof defaultQuery;
  transaction?: typeof defaultTransaction;
}

interface SkillRow {
  id: string;
  kind: SkillKind;
  title: string;
  description: string;
  applicable_scenario: string | null;
  exec_vars: string[] | null;
  exec_steps: SkillExecStep[] | null;
  taxonomy: SkillTaxonomy | null;
  category: string;
  tags: string[] | null;
  platform: string[] | null;
  os_scope: string;
  source: SkillSource;
  user_neutral: boolean;
  is_starter: boolean;
  status: SkillStatus;
  version: number;
  provenance: unknown;
  use_count: number;
  success_count: number;
  success_rate: number;
  cross_user_breadth: number;
  silent_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  retired_at: Date | string | null;
  [key: string]: unknown;
}

interface VariantRow {
  skill_id: string;
  os: string;
  command: string;
  verify_status: PlatformVariant["verify_status"];
  verified_at: Date | string | null;
  verified_by: string | null;
  fail_streak: number;
  [key: string]: unknown;
}

interface CandidateRow {
  id: string;
  kind: SkillKind;
  draft: Record<string, unknown>;
  category: string | null;
  source_role: SignalRole;
  source_weight: SourceWeight;
  user_neutral: boolean | null;
  status: SkillCandidate["status"];
  contributor_id: string | null;
  linked_prediction_id: string | null;
  linked_verifiable_id: string | null;
  trajectory_ref: TrajectoryRef | null;
  contributor_reuse_success: number;
  merged_into: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
}

function mapVariant(row: VariantRow): PlatformVariant {
  // 读路径平台归一：os 旧值 win32/darwin → win/mac；非法值兜底丢弃由调用方处理。
  const os = (normalizeVariantOs(row.os) ?? "linux") as VariantOS;
  return {
    skill_id: row.skill_id,
    os,
    command: row.command,
    verify_status: row.verify_status,
    verified_at: toIsoOpt(row.verified_at),
    verified_by: row.verified_by ?? undefined,
    fail_streak: row.fail_streak ?? 0,
  };
}

function mapSkill(row: SkillRow, variants: PlatformVariant[]): Skill {
  const createdAt = toIso(row.created_at);
  // 读路径平台归一：platform[] 中的旧值统一为 mac/win/linux/any。
  const platform = normalizePlatformList(row.platform) as SkillPlatform[];
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    applicable_scenario: row.applicable_scenario ?? undefined,
    exec_vars: row.exec_vars ?? [],
    exec_steps: row.exec_steps ?? [],
    taxonomy: row.taxonomy ?? ({ taskType: "generic" } as SkillTaxonomy),
    category: row.category,
    tags: row.tags ?? [],
    platform,
    os_scope: (row.os_scope as OSScope) ?? "any",
    source: row.source,
    user_neutral: row.user_neutral,
    is_starter: row.is_starter,
    status: row.status,
    version: row.version,
    provenance: normalizeProvenance(row.provenance, createdAt),
    quality: {
      use_count: row.use_count,
      success_count: row.success_count,
      success_rate: row.success_rate,
      silent_count: row.silent_count,
    },
    cross_user_breadth: row.cross_user_breadth,
    variants,
    created_at: createdAt,
    updated_at: toIso(row.updated_at),
    retired_at: toIsoOpt(row.retired_at),
  };
}

function mapCandidate(row: CandidateRow): SkillCandidate {
  return {
    id: row.id,
    kind: row.kind,
    draft: row.draft ?? {},
    category: row.category ?? undefined,
    source_role: row.source_role,
    source_weight: row.source_weight,
    user_neutral: row.user_neutral ?? undefined,
    status: row.status,
    contributor_id: row.contributor_id ?? undefined,
    linked_prediction_id: row.linked_prediction_id ?? undefined,
    linked_verifiable_id: row.linked_verifiable_id ?? undefined,
    trajectory_ref: row.trajectory_ref ?? undefined,
    contributor_reuse_success: row.contributor_reuse_success ?? 0,
    merged_into: row.merged_into ?? undefined,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** 把 Skill 收窄为渐进加载默认视图 Skill_Summary（不含 exec_steps/script）。 */
function toSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    name: s.title,
    description: s.description,
    applicable_scenario: s.applicable_scenario,
    category: s.category,
    tags: s.tags,
    // quality_score：success_rate 与 use_count 的组合度量，这里取 success_rate 作为主分。
    quality_score: s.quality.success_rate,
    platform_variant_count: s.variants?.length ?? 0,
    platform_verified: (s.variants ?? []).some((v) => v.verify_status === "connector-verified"),
  };
}

/**
 * 创建 PG 实现的 SkillRepo。
 * @param deps 可选依赖（query/transaction），默认走 `src/db/pool.ts`。
 */
export function createPgSkillRepo(deps: PgSkillRepoDeps = {}): SkillRepo {
  const query = deps.query ?? defaultQuery;
  const transaction = deps.transaction ?? defaultTransaction;

  /** 取技能 + 其变体（拼装为完整 Skill）。 */
  async function getInternal(skillId: string): Promise<Skill | null> {
    const skillRes = await query<SkillRow>(`SELECT * FROM skill WHERE id = $1`, [skillId]);
    if (skillRes.rows.length === 0) return null;
    const variantRes = await query<VariantRow>(
      `SELECT * FROM skill_platform_variant WHERE skill_id = $1 ORDER BY os`,
      [skillId],
    );
    return mapSkill(skillRes.rows[0], variantRes.rows.map(mapVariant));
  }

  return {
    async submit(input: SkillSubmitInput): Promise<SkillCandidate> {
      const d = input.draft;
      const res = await query<CandidateRow>(
        `INSERT INTO skill_candidate
           (kind, draft, category, source_role, source_weight, user_neutral,
            status, contributor_id, linked_prediction_id, linked_verifiable_id, trajectory_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'seeded', $7, $8, $9, $10)
         RETURNING *`,
        [
          d.kind,
          JSON.stringify(d),
          d.category ?? null,
          input.source_role,
          input.source_weight,
          d.user_neutral ?? null,
          input.contributor_id ?? null,
          input.linked_prediction_id ?? null,
          input.linked_verifiable_id ?? null,
          input.trajectory_ref ? JSON.stringify(input.trajectory_ref) : null,
        ],
      );
      return mapCandidate(res.rows[0]);
    },

    async getCandidate(candidateId: string): Promise<SkillCandidate | null> {
      const res = await query<CandidateRow>(`SELECT * FROM skill_candidate WHERE id = $1`, [
        candidateId,
      ]);
      return res.rows.length === 0 ? null : mapCandidate(res.rows[0]);
    },

    async promote(candidateId: string): Promise<Skill> {
      return transaction(async (client) => {
        const candRes = await client.query(`SELECT * FROM skill_candidate WHERE id = $1`, [
          candidateId,
        ]);
        if (candRes.rows.length === 0) {
          throw new Error(`promote 失败：候选不存在 candidateId=${candidateId}`);
        }
        const cand = mapCandidate(candRes.rows[0] as CandidateRow);
        const draft = cand.draft as unknown as SkillDraft;
        const createdAt = new Date().toISOString();
        const provenance: Provenance = { createdAt, verifiedCount: 0, totalCount: 0 };
        const platform = normalizePlatformList(draft.platform) as SkillPlatform[];

        // 物化为 active 公共技能（version=1，质量分清零，provenance 初始化）。
        const skillRes = await client.query(
          `INSERT INTO skill
             (kind, title, description, applicable_scenario, exec_vars, exec_steps,
              taxonomy, category, tags, platform, os_scope, source, user_neutral,
              status, version, provenance, use_count, success_count, success_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',1,$14,0,0,0.0)
           RETURNING id`,
          [
            draft.kind,
            draft.title,
            draft.description,
            draft.applicable_scenario ?? null,
            draft.exec_vars ?? [],
            JSON.stringify(draft.exec_steps ?? []),
            JSON.stringify(draft.taxonomy ?? { taskType: "generic" }),
            draft.category ?? "general",
            draft.tags ?? [],
            platform,
            draft.os_scope ?? "any",
            draft.source ?? "self_learned",
            draft.user_neutral ?? true,
            JSON.stringify(provenance),
          ],
        );
        const skillId = skillRes.rows[0].id as string;

        // 落各平台变体（仅可执行技能；os 经读路径归一，非法值跳过）。
        for (const v of draft.variants ?? []) {
          const os = normalizeVariantOs(v.os);
          if (!os) continue;
          await client.query(
            `INSERT INTO skill_platform_variant (skill_id, os, command)
             VALUES ($1, $2, $3)
             ON CONFLICT (skill_id, os) DO NOTHING`,
            [skillId, os, v.command],
          );
        }

        // 写首个贡献者并刷新跨用户广度。
        if (cand.contributor_id) {
          await client.query(
            `INSERT INTO skill_contributor (skill_id, user_id, original_title)
             VALUES ($1, $2, $3)
             ON CONFLICT (skill_id, user_id) DO NOTHING`,
            [skillId, cand.contributor_id, draft.title],
          );
        }
        await client.query(
          `UPDATE skill SET cross_user_breadth =
             (SELECT count(DISTINCT user_id) FROM skill_contributor WHERE skill_id = $1)
           WHERE id = $1`,
          [skillId],
        );

        // 候选 merged_into 指向新技能（标记已物化）。
        await client.query(
          `UPDATE skill_candidate SET merged_into = $1, updated_at = now() WHERE id = $2`,
          [skillId, candidateId],
        );

        const built = await getInternal2(client, skillId);
        if (!built) throw new Error(`promote 失败：物化后无法读回技能 skillId=${skillId}`);
        return built;
      });
    },

    async merge(candidateId: string, targetSkillId: string): Promise<Skill> {
      return transaction(async (client) => {
        const candRes = await client.query(`SELECT * FROM skill_candidate WHERE id = $1`, [
          candidateId,
        ]);
        if (candRes.rows.length === 0) {
          throw new Error(`merge 失败：候选不存在 candidateId=${candidateId}`);
        }
        const targetRes = await client.query(`SELECT id, title FROM skill WHERE id = $1`, [
          targetSkillId,
        ]);
        if (targetRes.rows.length === 0) {
          throw new Error(`merge 失败：目标技能不存在 targetSkillId=${targetSkillId}`);
        }
        const cand = mapCandidate(candRes.rows[0] as CandidateRow);
        const draft = cand.draft as unknown as SkillDraft;

        // 跨用户合并：把候选贡献者并入目标技能（PK 去重），刷新 cross_user_breadth。
        if (cand.contributor_id) {
          await client.query(
            `INSERT INTO skill_contributor (skill_id, user_id, original_title)
             VALUES ($1, $2, $3)
             ON CONFLICT (skill_id, user_id) DO NOTHING`,
            [targetSkillId, cand.contributor_id, draft?.title ?? null],
          );
        }
        await client.query(
          `UPDATE skill SET cross_user_breadth =
             (SELECT count(DISTINCT user_id) FROM skill_contributor WHERE skill_id = $1),
             updated_at = now()
           WHERE id = $1`,
          [targetSkillId],
        );

        // 候选 merged_into 指向目标技能（标记已合并）。
        await client.query(
          `UPDATE skill_candidate SET merged_into = $1, updated_at = now() WHERE id = $2`,
          [targetSkillId, candidateId],
        );

        const built = await getInternal2(client, targetSkillId);
        if (!built) throw new Error(`merge 失败：合并后无法读回技能 skillId=${targetSkillId}`);
        return built;
      });
    },

    get(skillId: string): Promise<Skill | null> {
      return getInternal(skillId);
    },

    async list(filter: SkillListFilter = {}): Promise<Skill[]> {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (filter.status) {
        params.push(filter.status);
        conds.push(`status = $${params.length}`);
      }
      if (filter.category) {
        params.push(filter.category);
        conds.push(`category = $${params.length}`);
      }
      if (filter.kind) {
        params.push(filter.kind);
        conds.push(`kind = $${params.length}`);
      }
      if (filter.is_starter !== undefined) {
        params.push(filter.is_starter);
        conds.push(`is_starter = $${params.length}`);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const skillRes = await query<SkillRow>(
        `SELECT * FROM skill ${where} ORDER BY created_at DESC`,
        params,
      );
      if (skillRes.rows.length === 0) return [];
      const ids = skillRes.rows.map((r) => r.id);
      const variantRes = await query<VariantRow>(
        `SELECT * FROM skill_platform_variant WHERE skill_id = ANY($1) ORDER BY os`,
        [ids],
      );
      const bySkill = new Map<string, PlatformVariant[]>();
      for (const vr of variantRes.rows) {
        const v = mapVariant(vr);
        const arr = bySkill.get(vr.skill_id) ?? [];
        arr.push(v);
        bySkill.set(vr.skill_id, arr);
      }
      return skillRes.rows.map((r) => mapSkill(r, bySkill.get(r.id) ?? []));
    },

    async search(q: SkillSearchQuery): Promise<SkillSummary[]> {
      const conds: string[] = [`status = 'active'`];
      const params: unknown[] = [];
      if (q.category) {
        params.push(q.category);
        conds.push(`category = $${params.length}`);
      }
      if (q.tags && q.tags.length > 0) {
        params.push(q.tags);
        conds.push(`tags && $${params.length}`); // 数组重叠：命中任一标签
      }
      const limit = Math.max(1, Math.floor(q.limit ?? 20));
      params.push(limit);
      const limitIdx = params.length;
      const skillRes = await query<SkillRow>(
        `SELECT * FROM skill WHERE ${conds.join(" AND ")}
         ORDER BY success_rate DESC, use_count DESC, created_at DESC
         LIMIT $${limitIdx}`,
        params,
      );
      if (skillRes.rows.length === 0) return [];
      const ids = skillRes.rows.map((r) => r.id);
      const variantRes = await query<VariantRow>(
        `SELECT * FROM skill_platform_variant WHERE skill_id = ANY($1)`,
        [ids],
      );
      const bySkill = new Map<string, PlatformVariant[]>();
      for (const vr of variantRes.rows) {
        const v = mapVariant(vr);
        const arr = bySkill.get(vr.skill_id) ?? [];
        arr.push(v);
        bySkill.set(vr.skill_id, arr);
      }
      const wantPlatform: NormalizedPlatform | undefined = q.platform
        ? (normalizePlatformList([q.platform])[0] as NormalizedPlatform)
        : undefined;
      const skills = skillRes.rows.map((r) => mapSkill(r, bySkill.get(r.id) ?? []));
      const filtered = skills.filter((s) => {
        // 平台过滤：soft / os_scope=any / 顶层 platform 含 any 不受限；
        // 可执行技能需在请求平台上存在变体（或顶层 platform 声明含该平台）。
        if (!wantPlatform || wantPlatform === "any") return true;
        if (s.os_scope === "any") return true;
        if (s.platform.includes("any") || s.platform.includes(wantPlatform)) return true;
        return (s.variants ?? []).some((v) => v.os === wantPlatform);
      });
      return filtered.map(toSummary);
    },

    async recordUsage(skillId: string, success: boolean): Promise<void> {
      // 质量分与 provenance 同步更新（同一事实两视图）：
      //  use_count = totalCount += 1；success_count = verifiedCount += (success?1:0)；
      //  success_rate = success_count/use_count。
      await query(
        `UPDATE skill SET
           use_count = use_count + 1,
           success_count = success_count + $2,
           success_rate = (success_count + $2)::real / (use_count + 1)::real,
           provenance = jsonb_set(
             jsonb_set(
               COALESCE(provenance, '{}'::jsonb),
               '{totalCount}', to_jsonb((COALESCE((provenance->>'totalCount')::int, 0) + 1))
             ),
             '{verifiedCount}', to_jsonb((COALESCE((provenance->>'verifiedCount')::int, 0) + $2))
           ),
           updated_at = now()
         WHERE id = $1`,
        [skillId, success ? 1 : 0],
      );
    },

    async setStatus(skillId: string, status: SkillStatus): Promise<void> {
      if (status === "active") {
        // retired 单向：retired 的技能不可改回 active（WHERE 排除 retired，不抛错幂等）。
        await query(
          `UPDATE skill SET status = 'active', updated_at = now()
           WHERE id = $1 AND status <> 'retired'`,
          [skillId],
        );
      } else {
        await query(
          `UPDATE skill SET status = 'retired', retired_at = now(), updated_at = now()
           WHERE id = $1`,
          [skillId],
        );
      }
    },

    async contributors(skillId: string): Promise<SkillContributor[]> {
      const res = await query<{
        skill_id: string;
        user_id: string;
        original_title: string | null;
        contributed_at: Date | string;
      }>(
        `SELECT skill_id, user_id, original_title, contributed_at
           FROM skill_contributor WHERE skill_id = $1 ORDER BY contributed_at ASC`,
        [skillId],
      );
      return res.rows.map((r) => ({
        skill_id: r.skill_id,
        user_id: r.user_id,
        original_title: r.original_title ?? undefined,
        contributed_at: toIso(r.contributed_at),
      }));
    },
  };

  /** 在给定事务 client 上读回技能 + 变体（供 promote/merge 事务内复用）。 */
  async function getInternal2(
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    skillId: string,
  ): Promise<Skill | null> {
    const skillRes = await client.query(`SELECT * FROM skill WHERE id = $1`, [skillId]);
    if (skillRes.rows.length === 0) return null;
    const variantRes = await client.query(
      `SELECT * FROM skill_platform_variant WHERE skill_id = $1 ORDER BY os`,
      [skillId],
    );
    return mapSkill(
      skillRes.rows[0] as SkillRow,
      (variantRes.rows as VariantRow[]).map(mapVariant),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内存实现（纯单元测试用，不连真实 PG）
// ─────────────────────────────────────────────────────────────────────────────

/** 内存实现的内部技能态（含变体/贡献者，对齐 Skill 结构）。 */
interface MemSkill {
  skill: Skill;
  contributors: SkillContributor[];
}

/**
 * 创建内存实现的 SkillRepo（与 PG 实现同契约，行为对齐）。
 * 仅供纯单元测试：用 Map 持久化，自增 id，不做 RLS / 平台 CHECK（平台归一仍生效）。
 */
export function createInMemorySkillRepo(): SkillRepo {
  const candidates = new Map<string, SkillCandidate>();
  const skills = new Map<string, MemSkill>();
  let candSeq = 0;
  let skillSeq = 0;

  const nextCandId = () => `cand-${++candSeq}`;
  const nextSkillId = () => `skill-${++skillSeq}`;

  function refreshBreadth(skillId: string): void {
    const ms = skills.get(skillId);
    if (!ms) return;
    const uniq = new Set(ms.contributors.map((c) => c.user_id));
    ms.skill.cross_user_breadth = uniq.size;
  }

  function cloneSkill(ms: MemSkill): Skill {
    // 深拷贝返回，避免外部修改污染内存态。
    return JSON.parse(JSON.stringify(ms.skill)) as Skill;
  }

  return {
    async submit(input: SkillSubmitInput): Promise<SkillCandidate> {
      const d = input.draft;
      const now = new Date().toISOString();
      const cand: SkillCandidate = {
        id: nextCandId(),
        kind: d.kind,
        draft: JSON.parse(JSON.stringify(d)) as Record<string, unknown>,
        category: d.category,
        source_role: input.source_role,
        source_weight: input.source_weight,
        user_neutral: d.user_neutral,
        status: "seeded",
        contributor_id: input.contributor_id,
        linked_prediction_id: input.linked_prediction_id,
        linked_verifiable_id: input.linked_verifiable_id,
        trajectory_ref: input.trajectory_ref,
        contributor_reuse_success: 0,
        created_at: now,
        updated_at: now,
      };
      candidates.set(cand.id, cand);
      return JSON.parse(JSON.stringify(cand)) as SkillCandidate;
    },

    async getCandidate(candidateId: string): Promise<SkillCandidate | null> {
      const c = candidates.get(candidateId);
      return c ? (JSON.parse(JSON.stringify(c)) as SkillCandidate) : null;
    },

    async promote(candidateId: string): Promise<Skill> {
      const cand = candidates.get(candidateId);
      if (!cand) throw new Error(`promote 失败：候选不存在 candidateId=${candidateId}`);
      const draft = cand.draft as unknown as SkillDraft;
      const now = new Date().toISOString();
      const skillId = nextSkillId();
      const platform = normalizePlatformList(draft.platform) as SkillPlatform[];
      const variants: PlatformVariant[] = [];
      for (const v of draft.variants ?? []) {
        const os = normalizeVariantOs(v.os);
        if (!os) continue;
        variants.push({
          skill_id: skillId,
          os: os as VariantOS,
          command: v.command,
          verify_status: "unverified",
          fail_streak: 0,
        });
      }
      const skill: Skill = {
        id: skillId,
        kind: draft.kind,
        title: draft.title,
        description: draft.description,
        applicable_scenario: draft.applicable_scenario,
        exec_vars: draft.exec_vars ?? [],
        exec_steps: draft.exec_steps ?? [],
        taxonomy: draft.taxonomy ?? ({ taskType: "generic" } as SkillTaxonomy),
        category: draft.category ?? "general",
        tags: draft.tags ?? [],
        platform,
        os_scope: draft.os_scope ?? "any",
        source: draft.source ?? "self_learned",
        user_neutral: draft.user_neutral ?? true,
        is_starter: false,
        status: "active",
        version: 1,
        provenance: { createdAt: now, verifiedCount: 0, totalCount: 0 },
        quality: { use_count: 0, success_count: 0, success_rate: 0, silent_count: 0 },
        cross_user_breadth: 0,
        variants,
        created_at: now,
        updated_at: now,
      };
      const ms: MemSkill = { skill, contributors: [] };
      if (cand.contributor_id) {
        ms.contributors.push({
          skill_id: skillId,
          user_id: cand.contributor_id,
          original_title: draft.title,
          contributed_at: now,
        });
      }
      skills.set(skillId, ms);
      refreshBreadth(skillId);
      cand.merged_into = skillId;
      cand.updated_at = now;
      return cloneSkill(ms);
    },

    async merge(candidateId: string, targetSkillId: string): Promise<Skill> {
      const cand = candidates.get(candidateId);
      if (!cand) throw new Error(`merge 失败：候选不存在 candidateId=${candidateId}`);
      const ms = skills.get(targetSkillId);
      if (!ms) throw new Error(`merge 失败：目标技能不存在 targetSkillId=${targetSkillId}`);
      const draft = cand.draft as unknown as SkillDraft;
      const now = new Date().toISOString();
      if (cand.contributor_id) {
        const exists = ms.contributors.some((c) => c.user_id === cand.contributor_id);
        if (!exists) {
          ms.contributors.push({
            skill_id: targetSkillId,
            user_id: cand.contributor_id,
            original_title: draft?.title,
            contributed_at: now,
          });
        }
      }
      refreshBreadth(targetSkillId);
      ms.skill.updated_at = now;
      cand.merged_into = targetSkillId;
      cand.updated_at = now;
      return cloneSkill(ms);
    },

    async get(skillId: string): Promise<Skill | null> {
      const ms = skills.get(skillId);
      return ms ? cloneSkill(ms) : null;
    },

    async list(filter: SkillListFilter = {}): Promise<Skill[]> {
      let arr = [...skills.values()].map((ms) => ms.skill);
      if (filter.status) arr = arr.filter((s) => s.status === filter.status);
      if (filter.category) arr = arr.filter((s) => s.category === filter.category);
      if (filter.kind) arr = arr.filter((s) => s.kind === filter.kind);
      if (filter.is_starter !== undefined) arr = arr.filter((s) => s.is_starter === filter.is_starter);
      // created_at DESC
      arr = [...arr].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      return arr.map((s) => JSON.parse(JSON.stringify(s)) as Skill);
    },

    async search(q: SkillSearchQuery): Promise<SkillSummary[]> {
      let arr = [...skills.values()].map((ms) => ms.skill).filter((s) => s.status === "active");
      if (q.category) arr = arr.filter((s) => s.category === q.category);
      if (q.tags && q.tags.length > 0) {
        const want = new Set(q.tags);
        arr = arr.filter((s) => s.tags.some((t) => want.has(t)));
      }
      const wantPlatform: NormalizedPlatform | undefined = q.platform
        ? (normalizePlatformList([q.platform])[0] as NormalizedPlatform)
        : undefined;
      arr = arr.filter((s) => {
        if (!wantPlatform || wantPlatform === "any") return true;
        if (s.os_scope === "any") return true;
        if (s.platform.includes("any") || s.platform.includes(wantPlatform)) return true;
        return (s.variants ?? []).some((v) => v.os === wantPlatform);
      });
      // success_rate DESC, use_count DESC, created_at DESC
      arr = [...arr].sort(
        (a, b) =>
          b.quality.success_rate - a.quality.success_rate ||
          b.quality.use_count - a.quality.use_count ||
          (a.created_at < b.created_at ? 1 : -1),
      );
      const limit = Math.max(1, Math.floor(q.limit ?? 20));
      return arr.slice(0, limit).map(toSummary);
    },

    async recordUsage(skillId: string, success: boolean): Promise<void> {
      const ms = skills.get(skillId);
      if (!ms) return;
      const s = ms.skill;
      s.quality.use_count += 1;
      if (success) s.quality.success_count += 1;
      s.quality.success_rate = rate(s.quality.success_count, s.quality.use_count);
      // provenance 与质量分同步（同一事实两视图）。
      const prov = s.provenance as Provenance;
      prov.totalCount = s.quality.use_count;
      prov.verifiedCount = s.quality.success_count;
      s.updated_at = new Date().toISOString();
    },

    async setStatus(skillId: string, status: SkillStatus): Promise<void> {
      const ms = skills.get(skillId);
      if (!ms) return;
      const s = ms.skill;
      if (status === "active") {
        // retired 单向：retired 的技能不可改回 active。
        if (s.status === "retired") return;
        s.status = "active";
      } else {
        s.status = "retired";
        s.retired_at = new Date().toISOString();
      }
      s.updated_at = new Date().toISOString();
    },

    async contributors(skillId: string): Promise<SkillContributor[]> {
      const ms = skills.get(skillId);
      if (!ms) return [];
      return ms.contributors
        .slice()
        .sort((a, b) => (a.contributed_at < b.contributed_at ? -1 : 1))
        .map((c) => ({ ...c }));
    },
  };
}
