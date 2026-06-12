/**
 * 技能反哺（Skill Reflux）· 成功度量（metrics.ts）
 * ------------------------------------------------------------------
 * 定位：反哺管线的"效果观测仪表盘"（design.md「Components and Interfaces」之外的
 * 非功能度量，对应 Requirement 13）。回答"反哺出的技能是否真的让问路越用越强"。
 *
 * 四类度量（Req 13.1 / 13.2 / 13.3 / 13.4）：
 *  1) 单技能复用度量（Req 13.1）：每个 Public_Skill 被复用的次数与复用后的成功率。
 *     数据源 = `skill` 表的质量分（`use_count`/`success_count`，由 Feedback_Writer 经
 *     `recordSkillUsage` 回写，见任务 15 / Req 12.1），成功率在此由 success/total 现算，
 *     与 `skill.success_rate` 同一事实。
 *  2) 反哺整体汇总（Req 13.2）：被复用技能数（use_count>0 的技能数）、总复用次数
 *     （Σ use_count）、平均复用成功率（被复用技能的 success_rate 均值）。
 *  3) 反哺前后对比（Req 13.3）：某技能"反哺前"（其贡献方候选自身使用，
 *     `skill_invocation_event.candidate_id` 关联到 `merged_into = 该技能` 的候选）与
 *     "反哺后"（`skill_invocation_event.skill_id = 该技能` 的公共继承方复用）的成功率对比；
 *     任一侧无数据则该侧成功率明确标注 N/A（以 `null` 表示），对比差值随之 N/A。
 *  4) 继承未使用比例（Req 13.4）：继承已超 `T_silent` 仍从未被调用（`user_skill.last_used_at`
 *     为空且 `acquired_at` 超过 T_silent 窗口）的继承占"已过 T_silent 观察窗"继承的比例，
 *     用于评估 Starter_Skill_Set 与冷启动继承的有效性。
 *
 * 依赖注入：所有 DB 访问经 `MetricsStore` 注入，PG 实现（`createPgMetricsStore`，对
 * `skill`/`skill_candidate`/`skill_invocation_event`/`user_skill` 做聚合查询）与内存实现
 * （`createInMemoryMetricsStore`，供纯单元测试）共用同一契约、行为对齐。
 *
 * _Requirements: 13.1, 13.2, 13.3, 13.4, 12.4_
 */

import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";

// ─────────────────────────────────────────────────────────────────
// 公共度量结果类型
// ─────────────────────────────────────────────────────────────────

/**
 * 单技能复用度量（Req 13.1）。
 * `success_rate` 在 `use_count = 0`（从未被复用）时定义为 0。
 */
export interface SkillReuseMetric {
  skill_id: string;
  /** 被复用次数（= skill.use_count = provenance.totalCount）。 */
  use_count: number;
  /** 复用成功次数（= skill.success_count = provenance.verifiedCount）。 */
  success_count: number;
  /** 复用后成功率 = success_count / use_count；use_count=0 时为 0。 */
  success_rate: number;
}

/** 反哺整体汇总度量（Req 13.2）。 */
export interface OverallSummary {
  /** 被复用技能数：use_count>0 的技能数量。 */
  reused_skill_count: number;
  /** 总复用次数：Σ use_count（全库技能，含已 retired 的曾被复用技能）。 */
  total_reuse_count: number;
  /** 平均复用成功率：对"被复用技能"（use_count>0）的 success_rate 取算术平均；无则 0。 */
  average_success_rate: number;
}

/**
 * 反哺前后成功率对比度量（Req 13.3）。
 * `before` / `after` 成功率在对应侧无使用数据时为 `null`（明确标注 N/A）；
 * `delta` 仅当前后两侧均可得时为数值，否则为 `null`（N/A）。
 */
export interface BeforeAfterComparison {
  skill_id: string;
  /** 反哺前（贡献方候选自身使用）总次数（仅计 success/fail，pending 不计）。 */
  before_total: number;
  /** 反哺前成功率；before_total=0 时为 null（N/A）。 */
  before_success_rate: number | null;
  /** 反哺后（公共继承方复用）总次数（仅计 success/fail）。 */
  after_total: number;
  /** 反哺后成功率；after_total=0 时为 null（N/A）。 */
  after_success_rate: number | null;
  /** 后 − 前 成功率差；任一侧 N/A 则为 null（N/A）。 */
  delta: number | null;
  /** 是否前后两侧数据齐备（可给出有意义对比）。 */
  available: boolean;
}

/** 继承未使用比例度量（Req 13.4）。 */
export interface SilentInheritanceRatio {
  /** 已过 T_silent 观察窗的继承数（acquired_at 超过 T_silent）。 */
  eligible_count: number;
  /** 其中从未被调用（last_used_at 为空）的继承数。 */
  silent_count: number;
  /** 未使用比例 = silent_count / eligible_count；eligible_count=0 时为 0。 */
  ratio: number;
}

// ─────────────────────────────────────────────────────────────────
// 数据访问抽象（聚合查询）
// ─────────────────────────────────────────────────────────────────

/** 单技能质量分原始计数（Req 13.1）。 */
export interface SkillQualityCounts {
  use_count: number;
  success_count: number;
}

/** 反哺前后两侧的原始计数（Req 13.3）。 */
export interface BeforeAfterCounts {
  before_total: number;
  before_success: number;
  after_total: number;
  after_success: number;
}

/** 继承未使用的原始计数（Req 13.4）。 */
export interface SilentCounts {
  eligible_count: number;
  silent_count: number;
}

/**
 * 度量数据访问抽象。默认实现走真实 PG（`createPgMetricsStore`）；
 * 单测注入内存实现（`createInMemoryMetricsStore`）。
 * 仅做"取原始计数"，成功率 / 比例 / N/A 等派生逻辑统一在 `SkillMetrics` 内计算，便于单测。
 */
export interface MetricsStore {
  /** 取单技能质量分计数（Req 13.1）；技能不存在返回 null。 */
  getSkillQuality(skillId: string): Promise<SkillQualityCounts | null>;
  /** 取全库技能质量分计数列表（Req 13.2 汇总用，含 active 与 retired）。 */
  listSkillQualities(): Promise<SkillQualityCounts[]>;
  /**
   * 取某技能反哺前后两侧调用计数（Req 13.3）：
   *  - 反哺前 = `skill_invocation_event.candidate_id` 属于 `merged_into = skillId` 的候选；
   *  - 反哺后 = `skill_invocation_event.skill_id = skillId`；
   * 两侧 total 仅计 outcome ∈ {success, fail}（pending 未结算不计）。
   */
  getBeforeAfterCounts(skillId: string): Promise<BeforeAfterCounts>;
  /**
   * 取继承未使用计数（Req 13.4）：`user_skill` 中
   *  - eligible = `acquired_at <= silentBeforeIso`（已过 T_silent 观察窗）；
   *  - silent   = eligible 且 `last_used_at IS NULL`（从未被调用）。
   */
  getSilentCounts(silentBeforeIso: string): Promise<SilentCounts>;
}

/** SkillMetrics 依赖（store/config 均可选，便于注入桩与单测）。 */
export interface SkillMetricsDeps {
  /** 度量数据访问层；默认 `createPgMetricsStore()`。 */
  store?: MetricsStore;
  /** 反哺配置（取 `T_silent_ms`）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
}

// ─────────────────────────────────────────────────────────────────
// SkillMetrics 对外接口
// ─────────────────────────────────────────────────────────────────

/** 成功度量对外接口（对应 Requirement 13 四条验收准则）。 */
export interface SkillMetrics {
  /** 单技能复用度量（Req 13.1）；技能不存在返回 null。 */
  skillReuseMetric(skillId: string): Promise<SkillReuseMetric | null>;
  /** 反哺整体汇总度量（Req 13.2）。 */
  overallSummary(): Promise<OverallSummary>;
  /** 反哺前后成功率对比度量（Req 13.3）。 */
  beforeAfterComparison(skillId: string): Promise<BeforeAfterComparison>;
  /**
   * 继承未使用比例度量（Req 13.4）。
   * @param now 当前时刻毫秒（默认 `Date.now()`，便于测试注入）。
   */
  silentInheritanceRatio(now?: number): Promise<SilentInheritanceRatio>;
}

// ─────────────────────────────────────────────────────────────────
// 派生计算工具
// ─────────────────────────────────────────────────────────────────

/** 成功率：total 为 0 时定义为 0（用于"被复用次数/成功率"语义）。 */
function rate(success: number, total: number): number {
  return total > 0 ? success / total : 0;
}

/** 成功率（带 N/A）：total 为 0 时返回 null（明确标注无数据）。 */
function rateOrNull(success: number, total: number): number | null {
  return total > 0 ? success / total : null;
}

// ─────────────────────────────────────────────────────────────────
// SkillMetrics 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建成功度量实例。
 * @param deps 依赖（store/config 均可选）。
 */
export function createSkillMetrics(deps: SkillMetricsDeps = {}): SkillMetrics {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const store = deps.store ?? createPgMetricsStore();

  return {
    async skillReuseMetric(skillId: string): Promise<SkillReuseMetric | null> {
      const q = await store.getSkillQuality(skillId);
      if (!q) return null;
      return {
        skill_id: skillId,
        use_count: q.use_count,
        success_count: q.success_count,
        success_rate: rate(q.success_count, q.use_count),
      };
    },

    async overallSummary(): Promise<OverallSummary> {
      const all = await store.listSkillQualities();
      let reusedSkillCount = 0;
      let totalReuseCount = 0;
      let rateSum = 0; // 仅对被复用技能累加 success_rate，求算术平均。
      for (const s of all) {
        totalReuseCount += s.use_count;
        if (s.use_count > 0) {
          reusedSkillCount += 1;
          rateSum += rate(s.success_count, s.use_count);
        }
      }
      return {
        reused_skill_count: reusedSkillCount,
        total_reuse_count: totalReuseCount,
        average_success_rate: reusedSkillCount > 0 ? rateSum / reusedSkillCount : 0,
      };
    },

    async beforeAfterComparison(skillId: string): Promise<BeforeAfterComparison> {
      const c = await store.getBeforeAfterCounts(skillId);
      const beforeRate = rateOrNull(c.before_success, c.before_total);
      const afterRate = rateOrNull(c.after_success, c.after_total);
      const available = beforeRate !== null && afterRate !== null;
      return {
        skill_id: skillId,
        before_total: c.before_total,
        before_success_rate: beforeRate,
        after_total: c.after_total,
        after_success_rate: afterRate,
        delta: available ? (afterRate as number) - (beforeRate as number) : null,
        available,
      };
    },

    async silentInheritanceRatio(now: number = Date.now()): Promise<SilentInheritanceRatio> {
      // 继承已超 T_silent 仍未被调用 → 计入未使用（与 Feedback_Writer 静默判定同口径）。
      const silentBeforeIso = new Date(now - config.T_silent_ms).toISOString();
      const c = await store.getSilentCounts(silentBeforeIso);
      return {
        eligible_count: c.eligible_count,
        silent_count: c.silent_count,
        ratio: c.eligible_count > 0 ? c.silent_count / c.eligible_count : 0,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 内存数据访问实现（纯单元测试用，不连真实 PG）
// ─────────────────────────────────────────────────────────────────

/** 内存技能态（仅取度量所需列）。 */
export interface MemMetricSkill {
  id: string;
  use_count: number;
  success_count: number;
}

/** 内存调用事件（仅取度量所需列）。 */
export interface MemMetricInvocation {
  /** 反哺后复用：指向公共技能。 */
  skill_id?: string | null;
  /** 反哺前复用：指向候选（经 candidate.merged_into 关联到技能）。 */
  candidate_id?: string | null;
  outcome: "pending" | "success" | "fail";
}

/** 内存候选态（仅取 merged_into 关联所需列）。 */
export interface MemMetricCandidate {
  id: string;
  /** 已物化/合并进的公共技能 id（未物化为 null/undefined）。 */
  merged_into?: string | null;
}

/** 内存继承态（仅取静默判定所需列）。 */
export interface MemMetricInheritance {
  user_id: string;
  skill_id: string;
  /** ISO 时间串。 */
  acquired_at: string;
  /** ISO 时间串；null/undefined 表示从未被调用。 */
  last_used_at?: string | null;
}

/** 内存 MetricsStore 初始化数据。 */
export interface InMemoryMetricsStoreInit {
  skills?: MemMetricSkill[];
  invocations?: MemMetricInvocation[];
  candidates?: MemMetricCandidate[];
  inheritances?: MemMetricInheritance[];
}

/**
 * 创建内存 MetricsStore（与 PG 实现同契约，查询语义对齐）。仅供纯单元测试。
 */
export function createInMemoryMetricsStore(init: InMemoryMetricsStoreInit = {}): MetricsStore {
  const skills = (init.skills ?? []).map((s) => ({ ...s }));
  const invocations = (init.invocations ?? []).map((i) => ({ ...i }));
  const candidates = (init.candidates ?? []).map((c) => ({ ...c }));
  const inheritances = (init.inheritances ?? []).map((i) => ({ ...i }));

  /** outcome 是否计入"已结算总次数"（pending 不计）。 */
  const settled = (o: MemMetricInvocation["outcome"]): boolean => o === "success" || o === "fail";

  return {
    async getSkillQuality(skillId: string): Promise<SkillQualityCounts | null> {
      const s = skills.find((x) => x.id === skillId);
      return s ? { use_count: s.use_count, success_count: s.success_count } : null;
    },

    async listSkillQualities(): Promise<SkillQualityCounts[]> {
      return skills.map((s) => ({ use_count: s.use_count, success_count: s.success_count }));
    },

    async getBeforeAfterCounts(skillId: string): Promise<BeforeAfterCounts> {
      // 反哺前：candidate_id 属于 merged_into = skillId 的候选集合。
      const candIds = new Set(
        candidates.filter((c) => c.merged_into === skillId).map((c) => c.id),
      );
      let beforeTotal = 0;
      let beforeSuccess = 0;
      let afterTotal = 0;
      let afterSuccess = 0;
      for (const ev of invocations) {
        if (!settled(ev.outcome)) continue;
        if (ev.skill_id === skillId) {
          afterTotal += 1;
          if (ev.outcome === "success") afterSuccess += 1;
        } else if (ev.candidate_id != null && candIds.has(ev.candidate_id)) {
          beforeTotal += 1;
          if (ev.outcome === "success") beforeSuccess += 1;
        }
      }
      return {
        before_total: beforeTotal,
        before_success: beforeSuccess,
        after_total: afterTotal,
        after_success: afterSuccess,
      };
    },

    async getSilentCounts(silentBeforeIso: string): Promise<SilentCounts> {
      let eligible = 0;
      let silent = 0;
      for (const i of inheritances) {
        if (i.acquired_at <= silentBeforeIso) {
          eligible += 1;
          if (i.last_used_at == null) silent += 1;
        }
      }
      return { eligible_count: eligible, silent_count: silent };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 MetricsStore。`skill`/`skill_candidate`/`skill_invocation_event`/
 * `user_skill`（006 迁移新增、无 RLS）走系统级 `query`（懒加载 `db/pool.js`，避免纯单测
 * 拉起 DB 模块）。全部为只读聚合查询。
 */
export function createPgMetricsStore(): MetricsStore {
  return {
    async getSkillQuality(skillId: string): Promise<SkillQualityCounts | null> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ use_count: number; success_count: number }>(
        `SELECT use_count, success_count FROM skill WHERE id = $1`,
        [skillId],
      );
      if (res.rows.length === 0) return null;
      const r = res.rows[0];
      return { use_count: Number(r.use_count), success_count: Number(r.success_count) };
    },

    async listSkillQualities(): Promise<SkillQualityCounts[]> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ use_count: number; success_count: number }>(
        `SELECT use_count, success_count FROM skill`,
      );
      return res.rows.map((r) => ({
        use_count: Number(r.use_count),
        success_count: Number(r.success_count),
      }));
    },

    async getBeforeAfterCounts(skillId: string): Promise<BeforeAfterCounts> {
      const { query } = await import("../db/pool.js");
      // 反哺后：skill_id = 该技能的已结算调用。
      const afterRes = await query<{ total: string; success: string }>(
        `SELECT
            count(*) FILTER (WHERE outcome IN ('success','fail'))   AS total,
            count(*) FILTER (WHERE outcome = 'success')             AS success
           FROM skill_invocation_event
          WHERE skill_id = $1`,
        [skillId],
      );
      // 反哺前：candidate_id 属于 merged_into = 该技能 的候选集合。
      const beforeRes = await query<{ total: string; success: string }>(
        `SELECT
            count(*) FILTER (WHERE outcome IN ('success','fail'))   AS total,
            count(*) FILTER (WHERE outcome = 'success')             AS success
           FROM skill_invocation_event
          WHERE candidate_id IN (SELECT id FROM skill_candidate WHERE merged_into = $1)`,
        [skillId],
      );
      const a = afterRes.rows[0] ?? { total: "0", success: "0" };
      const b = beforeRes.rows[0] ?? { total: "0", success: "0" };
      return {
        before_total: Number(b.total),
        before_success: Number(b.success),
        after_total: Number(a.total),
        after_success: Number(a.success),
      };
    },

    async getSilentCounts(silentBeforeIso: string): Promise<SilentCounts> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ eligible: string; silent: string }>(
        `SELECT
            count(*) FILTER (WHERE acquired_at <= $1)                              AS eligible,
            count(*) FILTER (WHERE acquired_at <= $1 AND last_used_at IS NULL)     AS silent
           FROM user_skill`,
        [silentBeforeIso],
      );
      const r = res.rows[0] ?? { eligible: "0", silent: "0" };
      return { eligible_count: Number(r.eligible), silent_count: Number(r.silent) };
    },
  };
}
