/**
 * 技能反哺（Skill Reflux）· Onboarding 冷启动继承（T1，onboarding.ts）
 * ------------------------------------------------------------------
 * 定位：管线分发阶段 T1 冷启动继承（design.md「冷启动继承流程（T1，含幂等与补继承）」）。
 * 作为**独立接口逻辑** `onboard(userId, platform?)` 暴露，由 auth 模块在用户注册成功 /
 * 首登成功后调用触发（Req 17.10），本模块**不自行监听**登录/注册事件。
 *
 * 核心职责（Req 17 / 18.5）：
 *  - `onboard(userId, platform?)`：经 `onboarding_state` 唯一约束保证对同一用户**最多执行一次**；
 *    并发/重复触发检测到已完成或正在进行时**直接返回既有继承结果**而不重复执行（Req 17.9）。
 *  - Starter_Skill_Set 选取（Req 17.2/17.3/17.4 + 18.5）：当且仅当
 *      (a) status=active ∧ (b) Cross_User_Breadth ≥ `config.Starter_M`
 *      ∧ (c) User_Neutral ∧ (d) 平台匹配
 *    （executable 须存在继承方平台的 connector-verified Platform_Variant；
 *      soft 技能 OS_Scope=any 直接合格）。仅纳入 User_Neutral 技能（Req 18.5）；
 *    **不以"全量 active 或仅高分"为依据**（Req 17.3）；top-N 上限按
 *    Cross_User_Breadth + Quality_Score 综合排序取前 N（`config.Starter_TopN`，Req 17.4）。
 *  - 平台未知先发 soft（status=soft_done，Req 17.5）；连接器首次上线上报平台后
 *    `topUpOnConnector(userId, platform)` 按**触发时刻**的库状态补继承匹配平台的
 *    executable Starter（status=completed，Req 17.6）；补继承失败则保持未完成，
 *    供 Dispatcher 在后续每次检索时重试至成功（Req 17.7）。
 *  - 继承经既有 `capability-pool.inheritSkills` 幂等记录（同 (user, skill) 只继承一次），
 *    支持用户经 `user_skill.enabled` 关闭（Req 17.8）。
 *
 * 依赖注入：技能选取查询（`SkillRepo`）、`onboarding_state` 读写（`OnboardingStore`）、
 * 继承函数（`InheritFn`）、配置（`RefluxConfig`）全部可注入，便于单测脱离真实 PG。
 *
 * _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 18.5_
 */

import { inheritSkills as defaultInheritSkills } from "../capability-pool/repo.js";
import {
  query as defaultQuery,
  transaction as defaultTransaction,
} from "../db/pool.js";
import { normalizeVariantOs } from "../db/platformNormalize.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { SkillRepo } from "./skillRepo.js";
import type { Skill, SkillPlatform, VariantOS } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// onboarding_state 行视图与状态
// ─────────────────────────────────────────────────────────────────

/** 冷启动继承状态（对应 onboarding_state.status）。 */
export type OnboardingStatus = "pending" | "soft_done" | "completed";

/** onboarding_state 行视图。 */
export interface OnboardingStateRow {
  user_id: string;
  status: OnboardingStatus;
  /** 触发时刻已知的连接器平台（未知则为空）。 */
  platform?: VariantOS | null;
  started_at: string;
  completed_at?: string | null;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入抽象：onboarding_state 读写
// ─────────────────────────────────────────────────────────────────

/**
 * 冷启动状态存储（依赖注入点，便于 mock，Req 17.9）。
 * PG 实现经 `onboarding_state` 的 `user_id` 主键唯一约束保证"最多一次"。
 */
export interface OnboardingStore {
  /** 取冷启动状态行；不存在返回 null。 */
  getState(userId: string): Promise<OnboardingStateRow | null>;
  /**
   * 原子地"取或建" pending 行（唯一约束保证最多一次）：
   * 行已存在 → `created=false` 并返回既有行；不存在 → 新建 pending 并 `created=true`。
   */
  ensurePending(
    userId: string,
    platform?: VariantOS | null,
  ): Promise<{ created: boolean; row: OnboardingStateRow }>;
  /** 推进状态（completed 时写 completed_at）；platform 非空则一并回填。 */
  markStatus(
    userId: string,
    status: OnboardingStatus,
    platform?: VariantOS | null,
  ): Promise<OnboardingStateRow>;
  /** 列出该用户已继承（user_skill）的技能 id（用于并发/重复返回既有结果，Req 17.9）。 */
  listInheritedSkillIds(userId: string): Promise<string[]>;
}

/** 继承函数签名（默认复用 `capability-pool.inheritSkills`，幂等）。 */
export type InheritFn = (
  userId: string,
  skillIds?: string[],
) => Promise<Array<{ id: string }>>;

// ─────────────────────────────────────────────────────────────────
// 对外结果
// ─────────────────────────────────────────────────────────────────

/** `onboard` 结果。 */
export interface OnboardResult {
  userId: string;
  /** 冷启动继承当前状态（soft_done：仅软技能；completed：含平台 executable）。 */
  status: OnboardingStatus;
  /** 本次实际继承到的技能 id（重复/并发时为既有继承结果）。 */
  inherited: string[];
  /** 本次选中的 Starter_Skill_Set 技能 id（重复/并发时为空）。 */
  starterSkillIds: string[];
  /** 是否为并发/重复触发命中既有状态、未重复执行（Req 17.9）。 */
  alreadyOnboarded: boolean;
  /** 触发时刻已知的连接器平台。 */
  platform?: VariantOS;
}

/** `topUpOnConnector` 结果。 */
export interface TopUpResult {
  userId: string;
  status: OnboardingStatus;
  /** 本次补继承到的（executable）Starter 技能 id。 */
  inherited: string[];
  /** 是否已完成补继承（status=completed）。 */
  completed: boolean;
  /** 补继承针对的平台（平台仍未知/不限时为空）。 */
  platform?: VariantOS;
}

// ─────────────────────────────────────────────────────────────────
// Onboarding 依赖与接口
// ─────────────────────────────────────────────────────────────────

/** Onboarding 依赖（repo + store 必填；其余可选，缺省走 PG / 默认配置）。 */
export interface OnboardingDeps {
  /** 技能数据访问层：经 `list({status:'active'})` 取 active 公共技能做 Starter 选取。 */
  repo: SkillRepo;
  /** 冷启动状态存储；缺省 `createPgOnboardingStore()`（真实 PG）。 */
  store?: OnboardingStore;
  /** 继承函数；缺省复用 `capability-pool.inheritSkills`（幂等）。 */
  inheritFn?: InheritFn;
  /** 反哺配置（取 Starter_M / Starter_TopN）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
}

/** Onboarding 对外接口（对齐 design.md Dispatcher 的 T1 部分）。 */
export interface Onboarding {
  /**
   * 冷启动继承（T1，独立接口）：经唯一约束保证最多一次；并发/重复返回既有结果。
   * 平台已知 → 选 Starter（含 executable）→ 继承 → completed；
   * 平台未知 → 仅继承 soft Starter → soft_done（executable 延后到 `topUpOnConnector`）。
   */
  onboard(userId: string, platform?: SkillPlatform): Promise<OnboardResult>;
  /**
   * 连接器上线上报平台后的补继承（Req 17.6/17.7）：按触发时刻库状态补继承匹配平台的
   * executable Starter，成功则置 completed；已 completed 幂等跳过；失败保持未完成供后续重试。
   */
  topUpOnConnector(userId: string, platform: SkillPlatform): Promise<TopUpResult>;
}

// ─────────────────────────────────────────────────────────────────
// 内部工具：Starter_Skill_Set 选取
// ─────────────────────────────────────────────────────────────────

/** 把 SkillPlatform 收窄为具体 VariantOS（any/缺省 → undefined，表示平台未知/不限）。 */
function toVariantOS(platform?: SkillPlatform): VariantOS | undefined {
  if (!platform || platform === "any") return undefined;
  // 经读路径归一（win32→win / darwin→mac），非法值返回 undefined。
  return (normalizeVariantOs(platform) ?? undefined) as VariantOS | undefined;
}

/**
 * Starter_Skill_Set 综合排序分（Req 17.4）：Cross_User_Breadth 为主、Quality_Score 为辅。
 * 取 `cross_user_breadth + success_rate`——广度为整数主导排序，质量分（0~1）在同广度内细分，
 * 是"按 Cross_User_Breadth 与 Quality_Score 综合排序"的确定性度量。
 */
function starterScore(s: Skill): number {
  return s.cross_user_breadth + s.quality.success_rate;
}

/**
 * 判定一个技能是否满足 Starter_Skill_Set 准入（Req 17.2 + 18.5）。
 * @param includeExecutable 平台已知（true）才纳入 executable；平台未知（false）仅纳入 soft（Req 17.5）。
 */
function isStarterEligible(
  s: Skill,
  platform: VariantOS | undefined,
  M: number,
  includeExecutable: boolean,
): boolean {
  // (a) 状态 active。
  if (s.status !== "active") return false;
  // (b) 通用、日常高频：Cross_User_Breadth ≥ M。
  if (s.cross_user_breadth < M) return false;
  // (c) User_Neutral（Req 18.5：仅纳入用户中立技能）。
  if (!s.user_neutral) return false;
  // (d) 平台匹配。
  if (s.kind === "soft" || s.os_scope === "any") return true; // soft / OS_Scope=any 直接合格
  // executable：平台未知时延后（Req 17.5）；平台已知时须存在该平台 connector-verified 变体。
  if (!includeExecutable || !platform) return false;
  return (s.variants ?? []).some(
    (v) => v.os === platform && v.verify_status === "connector-verified",
  );
}

/**
 * 选取 Starter_Skill_Set（Req 17.2/17.3/17.4 + 18.5）：
 * 过滤合格集 → 按综合分降序（同分按 id 稳定排序）→ 取前 `topN`。
 */
export function selectStarterSkills(
  skills: Skill[],
  platform: VariantOS | undefined,
  config: RefluxConfig,
  includeExecutable: boolean,
): Skill[] {
  const eligible = skills.filter((s) =>
    isStarterEligible(s, platform, config.Starter_M, includeExecutable),
  );
  eligible.sort((a, b) => {
    const diff = starterScore(b) - starterScore(a);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // 稳定确定性兜底排序
  });
  const topN = Math.max(0, Math.floor(config.Starter_TopN));
  return eligible.slice(0, topN);
}

// ─────────────────────────────────────────────────────────────────
// Onboarding 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建 Onboarding 实例。
 * @param deps 依赖（repo + store 必填）；不传可选项则走 PG / 默认配置 / capability-pool 继承。
 */
export function createOnboarding(deps: OnboardingDeps): Onboarding {
  const repo = deps.repo;
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const store = deps.store ?? createPgOnboardingStore();
  const inheritFn = deps.inheritFn ?? (defaultInheritSkills as InheritFn);

  return {
    async onboard(userId: string, platform?: SkillPlatform): Promise<OnboardResult> {
      const platformOS = toVariantOS(platform);

      // 1) 唯一约束保证最多一次（Req 17.9）：原子"取或建" pending 行。
      const { created, row } = await store.ensurePending(userId, platformOS ?? null);
      if (!created) {
        // 并发/重复触发：检测到已完成或正在进行 → 直接返回既有继承结果，不重复执行。
        const inherited = await store.listInheritedSkillIds(userId);
        return {
          userId,
          status: row.status,
          inherited,
          starterSkillIds: [],
          alreadyOnboarded: true,
          platform: row.platform ?? undefined,
        };
      }

      // 2) 选取 Starter_Skill_Set：平台已知才纳入 executable（Req 17.5）。
      const includeExecutable = !!platformOS;
      const active = await repo.list({ status: "active" });
      const starter = selectStarterSkills(active, platformOS, config, includeExecutable);
      const starterIds = starter.map((s) => s.id);

      // 3) 经既有 inheritSkills 幂等继承（Req 17.8）。
      const inheritedRows = await inheritFn(userId, starterIds);
      const inherited = inheritedRows.map((r) => r.id);

      // 4) 推进状态：平台已知 → completed；平台未知（仅软技能）→ soft_done（Req 17.5）。
      const status: OnboardingStatus = includeExecutable ? "completed" : "soft_done";
      await store.markStatus(userId, status, platformOS ?? null);

      return {
        userId,
        status,
        inherited,
        starterSkillIds: starterIds,
        alreadyOnboarded: false,
        platform: platformOS,
      };
    },

    async topUpOnConnector(userId: string, platform: SkillPlatform): Promise<TopUpResult> {
      const platformOS = toVariantOS(platform);
      const state = await store.getState(userId);

      // 平台仍未知（any/非法）→ 无可补继承的 executable，保持现状。
      if (!platformOS) {
        return {
          userId,
          status: state?.status ?? "pending",
          inherited: [],
          completed: state?.status === "completed",
          platform: undefined,
        };
      }

      // 已完成 → 幂等跳过（Req 17.6 触发时刻库状态已固化）。
      if (state && state.status === "completed") {
        return {
          userId,
          status: "completed",
          inherited: [],
          completed: true,
          platform: platformOS,
        };
      }

      // 按"触发时刻"库状态补继承匹配平台的 executable Starter（Req 17.6）。
      const active = await repo.list({ status: "active" });
      const starter = selectStarterSkills(active, platformOS, config, true);
      const execIds = starter.filter((s) => s.kind === "executable").map((s) => s.id);

      // inheritSkills 幂等：软技能即便重复传入也只继承一次（Req 17.8）。
      // 若继承失败抛错，状态保持未完成（soft_done/pending），供后续每次检索重试（Req 17.7）。
      const inheritedRows = await inheritFn(userId, execIds);
      const inherited = inheritedRows.map((r) => r.id);

      // 补继承成功 → 置 completed 并记录平台。
      await store.markStatus(userId, "completed", platformOS);
      return {
        userId,
        status: "completed",
        inherited,
        completed: true,
        platform: platformOS,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 实现：onboarding_state 读写
// ─────────────────────────────────────────────────────────────────

/** PG OnboardingStore 可注入依赖（默认走 `src/db/pool.ts`）。便于单测注入桩。 */
export interface PgOnboardingStoreDeps {
  query?: typeof defaultQuery;
  transaction?: typeof defaultTransaction;
}

interface OnboardingStateDbRow {
  user_id: string;
  status: OnboardingStatus;
  platform: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  [key: string]: unknown;
}

function toIso(ts: Date | string | null | undefined): string {
  if (ts == null) return "";
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

function mapStateRow(row: OnboardingStateDbRow): OnboardingStateRow {
  return {
    user_id: row.user_id,
    status: row.status,
    // 读路径平台归一（win32→win / darwin→mac）；非法/空值置 null。
    platform: row.platform ? ((normalizeVariantOs(row.platform) ?? null) as VariantOS | null) : null,
    started_at: toIso(row.started_at),
    completed_at: row.completed_at ? toIso(row.completed_at) : null,
  };
}

/**
 * 创建走真实 PG 的 OnboardingStore（读写 `onboarding_state` 表，建表见迁移 006）。
 * `user_id` 主键唯一约束保证对同一用户"最多一次"（Req 17.9）。
 */
export function createPgOnboardingStore(deps: PgOnboardingStoreDeps = {}): OnboardingStore {
  const query = deps.query ?? defaultQuery;

  return {
    async getState(userId: string): Promise<OnboardingStateRow | null> {
      const res = await query<OnboardingStateDbRow>(
        `SELECT * FROM onboarding_state WHERE user_id = $1`,
        [userId],
      );
      return res.rows.length === 0 ? null : mapStateRow(res.rows[0]);
    },

    async ensurePending(
      userId: string,
      platform?: VariantOS | null,
    ): Promise<{ created: boolean; row: OnboardingStateRow }> {
      // 唯一约束保证最多一次：ON CONFLICT DO NOTHING——并发只有一方插入成功（Req 17.9）。
      const ins = await query<OnboardingStateDbRow>(
        `INSERT INTO onboarding_state (user_id, platform, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (user_id) DO NOTHING
         RETURNING *`,
        [userId, platform ?? null],
      );
      if (ins.rows.length > 0) {
        return { created: true, row: mapStateRow(ins.rows[0]) };
      }
      // 行已存在（并发或重复触发）→ 读回既有行。
      const ex = await query<OnboardingStateDbRow>(
        `SELECT * FROM onboarding_state WHERE user_id = $1`,
        [userId],
      );
      return { created: false, row: mapStateRow(ex.rows[0]) };
    },

    async markStatus(
      userId: string,
      status: OnboardingStatus,
      platform?: VariantOS | null,
    ): Promise<OnboardingStateRow> {
      const res = await query<OnboardingStateDbRow>(
        `UPDATE onboarding_state
            SET status = $2,
                platform = COALESCE($3, platform),
                completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END
          WHERE user_id = $1
        RETURNING *`,
        [userId, status, platform ?? null],
      );
      return mapStateRow(res.rows[0]);
    },

    async listInheritedSkillIds(userId: string): Promise<string[]> {
      const res = await query<{ skill_id: string }>(
        `SELECT skill_id FROM user_skill WHERE user_id = $1`,
        [userId],
      );
      return res.rows.map((r) => r.skill_id);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 内存实现（纯单元测试用，不连真实 PG）
// ─────────────────────────────────────────────────────────────────

/**
 * 创建内存实现的 OnboardingStore（与 PG 实现同契约）。
 * 仅供纯单元测试：用 Map 持久化 onboarding_state 与 user_skill 继承集。
 */
export function createInMemoryOnboardingStore(): OnboardingStore & {
  /** 测试便捷：注入既有继承关系（模拟 inheritSkills 落库结果）。 */
  __setInherited(userId: string, skillIds: string[]): void;
} {
  const states = new Map<string, OnboardingStateRow>();
  const inherited = new Map<string, Set<string>>();

  return {
    async getState(userId: string): Promise<OnboardingStateRow | null> {
      const r = states.get(userId);
      return r ? { ...r } : null;
    },

    async ensurePending(
      userId: string,
      platform?: VariantOS | null,
    ): Promise<{ created: boolean; row: OnboardingStateRow }> {
      const existing = states.get(userId);
      if (existing) return { created: false, row: { ...existing } };
      const row: OnboardingStateRow = {
        user_id: userId,
        status: "pending",
        platform: platform ?? null,
        started_at: new Date().toISOString(),
        completed_at: null,
      };
      states.set(userId, row);
      return { created: true, row: { ...row } };
    },

    async markStatus(
      userId: string,
      status: OnboardingStatus,
      platform?: VariantOS | null,
    ): Promise<OnboardingStateRow> {
      const existing = states.get(userId) ?? {
        user_id: userId,
        status: "pending" as OnboardingStatus,
        platform: platform ?? null,
        started_at: new Date().toISOString(),
        completed_at: null,
      };
      const next: OnboardingStateRow = {
        ...existing,
        status,
        platform: platform ?? existing.platform ?? null,
        completed_at:
          status === "completed" ? new Date().toISOString() : existing.completed_at ?? null,
      };
      states.set(userId, next);
      return { ...next };
    },

    async listInheritedSkillIds(userId: string): Promise<string[]> {
      return [...(inherited.get(userId) ?? new Set<string>())];
    },

    __setInherited(userId: string, skillIds: string[]): void {
      inherited.set(userId, new Set(skillIds));
    },
  };
}
