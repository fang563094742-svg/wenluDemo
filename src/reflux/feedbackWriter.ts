/**
 * 技能反哺（Skill Reflux）· Feedback_Writer（回写 / 静默 / 淘汰，feedbackWriter.ts）
 * ------------------------------------------------------------------
 * 定位：管线最末端的反馈闭环（design.md「Components and Interfaces · Feedback_Writer」）。
 * 把"继承复用"的真实成败回写到技能质量分，让「越用越强」由现实证据驱动，并对长期静默、
 * 持续低分的技能做降分与淘汰，形成优胜劣汰。
 *
 * 复用 / 整合既有内核（不另起一套）：
 *  - **质量分回写**：复用任务 3 扩展进 `capability-pool/repo.ts` 的 `recordSkillUsage`
 *    （更新 `skill.use_count/success_count/success_rate/provenance` 与 `user_skill.last_used_at`），
 *    本模块不重复写 SQL（Req 12.1）。
 *  - **晋升评估**：复用任务 7 的 `Classifier`——贡献方自身复用成功经
 *    `classifier.recordReuseSuccess` 累加，达 Promotion_Threshold_N 点亮 proven 后再经
 *    `classifier.evaluate` 触发 Req 9/10 定义的双门晋升评估（Req 12.2）。
 *  - **淘汰置状态**：复用任务 3 的 `skillRepo.setStatus(id, "retired")`（retired 单向、
 *    不物理删除、已继承者仍可用，Req 10.7/10.8/12.3）。
 *
 * 三类职责：
 *  1) 回写（Req 12.1/12.2）：`recordReuse` 回写质量分；带候选时达 N 触发晋升评估。
 *  2) 静默继承扫描（Req 12.4/12.5）：`scanSilentInheritance` 扫描 `user_skill` 中
 *     `acquired_at` 超 `T_silent` 且 `last_used_at` 为空者，`silent_count++` 并按衰减因子降
 *     质量分，且不计为一次成功复用；静默计数纳入淘汰判定。
 *  3) 淘汰扫描（Req 10.7/10.8/12.3）：`scanEliminations` 对连续 `Elimination_Window` 内
 *     `success_rate < Elimination_Threshold` 且 `use_count ≥ Min_Sample`（或长期静默、
 *     use_count 持续为 0 而 silent_count 达 Min_Sample）的 active 技能置 retired。
 *
 * 依赖注入：`recordSkillUsage` / `skillRepo` / `classifier` / `store` 全部可注入，便于纯
 * 单元测试脱离真实 PG / 真实 LLM / 真实宪法。
 *
 * _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 10.7, 10.8_
 */

import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { SkillRepo } from "./skillRepo.js";
import type { Classifier, ClassifyDecision, PromotionContext, TransitionResult } from "./classifier.js";

// ─────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────

/**
 * 静默继承的默认质量分衰减因子（Req 12.4）。每记一次 Silent_Inheritance，按此因子
 * 下调技能 success_rate（`success_rate *= factor`）；取值 (0,1)，越小衰减越快。
 * 设计未单列该参数，故以常量给出默认值，可经 `FeedbackWriterDeps.silentDecayFactor` 覆盖。
 */
export const DEFAULT_SILENT_DECAY_FACTOR = 0.9;

// ─────────────────────────────────────────────────────────────────
// 回写 / 扫描的入参与结果类型
// ─────────────────────────────────────────────────────────────────

/** `recordSkillUsage` 的最小契约（默认走 `capability-pool/repo.ts`，可注入桩）。 */
export type RecordSkillUsageFn = (
  userId: string,
  skillId: string,
  success: boolean,
) => Promise<void>;

/** 复用回写入参（Req 12.1/12.2）。 */
export interface RecordReuseInput {
  /** 复用方（继承方）userId。 */
  userId: string;
  /** 被复用的公共技能 id。 */
  skillId: string;
  /** 本次复用是否成功。 */
  success: boolean;
  /**
   * 关联候选 id（可选）：当本次复用对应一个尚未 active 的候选（贡献方自身复用，Req 9.11）时，
   * 成功会经 `classifier.recordReuseSuccess` 累加复用计数；达 Promotion_Threshold_N 点亮
   * proven 后再触发 `classifier.evaluate` 晋升评估（Req 12.2）。
   */
  candidateId?: string;
  /** 晋升评估上下文（传给 `classifier.evaluate`，仅在触发晋升评估时使用）。 */
  promotionContext?: PromotionContext;
}

/** 复用回写结果。 */
export interface RecordReuseResult {
  /** 质量分回写是否已执行（恒为 true，仅作显式标记）。 */
  recorded: true;
  /** 候选复用计数累加 / 点亮结果（仅当带 candidateId 且成功时返回）。 */
  reuseTransition?: TransitionResult;
  /** 晋升评估结果（仅当复用累加点亮 proven、触发 evaluate 时返回）。 */
  promotion?: ClassifyDecision;
}

/** 一条静默继承记录（user_skill 行视图：仅取扫描所需列）。 */
export interface SilentInheritanceRow {
  user_id: string;
  skill_id: string;
}

/** 静默继承扫描结果（Req 12.4/12.5）。 */
export interface SilentScanResult {
  /** 命中的静默继承条数（Silent_Inheritance 数）。 */
  scanned: number;
  /** 被降分的技能 id（去重，每个技能按其名下静默继承条数累加 silent_count）。 */
  penalizedSkillIds: string[];
}

/** 淘汰扫描结果（Req 10.7/10.8/12.3）。 */
export interface EliminationScanResult {
  /** 本次被置为 retired 的技能 id 列表。 */
  retiredSkillIds: string[];
}

// ─────────────────────────────────────────────────────────────────
// 数据访问抽象（静默 / 淘汰扫描所需，recordSkillUsage 未覆盖的部分）
// ─────────────────────────────────────────────────────────────────

/** `findEliminationCandidates` 的查询入参。 */
export interface EliminationQuery {
  /** 窗口起点 ISO：技能 created_at ≤ 此值才视为"连续 Elimination_Window 内"被观察够久。 */
  windowStartIso: string;
  /** 淘汰成功率阈值（success_rate 低于此值计入淘汰）。 */
  elimThreshold: number;
  /** 触发淘汰所需最小样本（use_count ≥ 此值；静默路径用作 silent_count 阈值）。 */
  minSample: number;
}

/**
 * Feedback_Writer 数据访问抽象（静默扫描 / 淘汰候选查询 / 静默降分）。
 * 默认实现走真实 PG（`createPgFeedbackWriterStore`）；单测注入内存实现
 * （`createInMemoryFeedbackWriterStore`）。质量分回写本身复用 `recordSkillUsage`，不在此。
 */
export interface FeedbackWriterStore {
  /**
   * 查静默继承（Req 12.4）：`user_skill` 中 `last_used_at IS NULL` 且
   * `acquired_at <= silentBeforeIso`（即继承已超 T_silent 仍从未被调用）的记录。
   */
  findSilentInheritances(silentBeforeIso: string): Promise<SilentInheritanceRow[]>;
  /**
   * 静默降分（Req 12.4/12.5）：对技能 `silent_count += silentDelta`，并按衰减因子下调
   * `success_rate`（`success_rate *= decayFactor`）。不改 use_count（静默不计为成功复用）。
   */
  applySilentPenalty(skillId: string, silentDelta: number, decayFactor: number): Promise<void>;
  /**
   * 查淘汰候选（Req 12.3/12.5）：active 且观察够久（created_at ≤ windowStart）的技能中，
   * 满足 (use_count ≥ Min_Sample ∧ success_rate < Elimination_Threshold)
   * 或（长期静默：use_count = 0 ∧ silent_count ≥ Min_Sample）之一者。
   */
  findEliminationCandidates(q: EliminationQuery): Promise<string[]>;
}

/** Feedback_Writer 依赖（skillRepo 必填；其余可选）。 */
export interface FeedbackWriterDeps {
  /** 技能数据访问层：淘汰经 `setStatus(id, "retired")`（任务 3，retired 单向）。 */
  skillRepo: Pick<SkillRepo, "setStatus">;
  /**
   * 质量分回写函数；默认 `capability-pool/repo.ts` 的 `recordSkillUsage`
   * （懒加载，避免纯单测拉起 DB 模块）。单测注入桩。
   */
  recordSkillUsage?: RecordSkillUsageFn;
  /**
   * 晋升评估器（Req 12.2）：贡献方自身复用累加 + 达 N 触发双门评估。
   * 不注入则 `recordReuse` 仅回写质量分、不触发晋升评估。
   */
  classifier?: Pick<Classifier, "recordReuseSuccess" | "evaluate">;
  /** 静默 / 淘汰扫描数据访问层；默认 `createPgFeedbackWriterStore()`。 */
  store?: FeedbackWriterStore;
  /** 反哺配置（取 T_silent / Elimination_* / Min_Sample）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
  /** 静默降分衰减因子；默认 DEFAULT_SILENT_DECAY_FACTOR（0.9）。 */
  silentDecayFactor?: number;
}

// ─────────────────────────────────────────────────────────────────
// Feedback_Writer 对外接口
// ─────────────────────────────────────────────────────────────────

/** Feedback_Writer 对外接口（对齐 design.md「Components and Interfaces · Feedback_Writer」）。 */
export interface FeedbackWriter {
  /**
   * 回写复用成败（Req 12.1）：经 `recordSkillUsage` 更新 `skill` 质量字段与
   * `user_skill.last_used_at`；带 candidateId 且成功时，达 Promotion_Threshold_N 触发晋升
   * 评估（Req 12.2）。
   */
  recordReuse(input: RecordReuseInput): Promise<RecordReuseResult>;
  /**
   * 静默继承扫描（Req 12.4/12.5）：扫描超 T_silent 仍未被调用的继承，按技能聚合
   * silent_count++ 并按衰减因子降质量分；静默计数纳入淘汰判定（见 `scanEliminations`）。
   * @param now 当前时刻毫秒（默认 `Date.now()`，便于测试注入）。
   */
  scanSilentInheritance(now?: number): Promise<SilentScanResult>;
  /**
   * 淘汰扫描（Req 10.7/10.8/12.3）：对满足淘汰条件的 active 技能置 retired（单向、不物删、
   * 已继承者仍可用、不再分发/不进 Starter）。
   * @param now 当前时刻毫秒（默认 `Date.now()`，便于测试注入）。
   */
  scanEliminations(now?: number): Promise<EliminationScanResult>;
}

// ─────────────────────────────────────────────────────────────────
// Feedback_Writer 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建 Feedback_Writer 实例。
 * @param deps 依赖（skillRepo 必填）；recordSkillUsage/classifier/store/config/silentDecayFactor 可选。
 */
export function createFeedbackWriter(deps: FeedbackWriterDeps): FeedbackWriter {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const skillRepo = deps.skillRepo;
  const classifier = deps.classifier;
  const store = deps.store ?? createPgFeedbackWriterStore();
  const decayFactor = deps.silentDecayFactor ?? DEFAULT_SILENT_DECAY_FACTOR;

  /** 取质量分回写函数（注入优先；否则懒加载 capability-pool 的 recordSkillUsage）。 */
  async function getRecordSkillUsage(): Promise<RecordSkillUsageFn> {
    if (deps.recordSkillUsage) return deps.recordSkillUsage;
    const mod = await import("../capability-pool/repo.js");
    return mod.recordSkillUsage;
  }

  return {
    async recordReuse(input: RecordReuseInput): Promise<RecordReuseResult> {
      // 1) 质量分回写（Req 12.1）：复用既有 recordSkillUsage（同步更新 skill 质量 + user_skill.last_used_at）。
      const recordSkillUsage = await getRecordSkillUsage();
      await recordSkillUsage(input.userId, input.skillId, input.success);

      const result: RecordReuseResult = { recorded: true };

      // 2) 达 N 触发晋升评估（Req 12.2）：仅当带候选、复用成功、且注入了 classifier。
      if (input.success && input.candidateId && classifier) {
        const transition = await classifier.recordReuseSuccess(input.candidateId);
        result.reuseTransition = transition;
        // 累加点亮 proven 后，触发 Req 9/10 定义的双门晋升评估。
        if (transition.changed && transition.status === "proven") {
          result.promotion = await classifier.evaluate(input.candidateId, input.promotionContext);
        }
      }

      return result;
    },

    async scanSilentInheritance(now: number = Date.now()): Promise<SilentScanResult> {
      // 继承超 T_silent 仍从未被调用 → Silent_Inheritance（Req 12.4）。
      const silentBeforeIso = new Date(now - config.T_silent_ms).toISOString();
      const rows = await store.findSilentInheritances(silentBeforeIso);

      // 按技能聚合静默条数（同一技能名下多条静默继承一并累加 silent_count）。
      const countBySkill = new Map<string, number>();
      for (const r of rows) {
        countBySkill.set(r.skill_id, (countBySkill.get(r.skill_id) ?? 0) + 1);
      }

      const penalizedSkillIds: string[] = [];
      for (const [skillId, delta] of countBySkill) {
        // silent_count += delta，success_rate *= decayFactor（不计为成功复用，不动 use_count）。
        await store.applySilentPenalty(skillId, delta, decayFactor);
        penalizedSkillIds.push(skillId);
      }

      return { scanned: rows.length, penalizedSkillIds };
    },

    async scanEliminations(now: number = Date.now()): Promise<EliminationScanResult> {
      const windowStartIso = new Date(now - config.Elimination_Window_ms).toISOString();
      const ids = await store.findEliminationCandidates({
        windowStartIso,
        elimThreshold: config.Elimination_Threshold,
        minSample: config.Min_Sample,
      });

      const retiredSkillIds: string[] = [];
      for (const id of ids) {
        // active → retired（单向、不物删；skillRepo.setStatus 内部置 retired_at，Req 10.7/12.3）。
        await skillRepo.setStatus(id, "retired");
        retiredSkillIds.push(id);
      }

      return { retiredSkillIds };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 内存数据访问实现（纯单元测试用，不连真实 PG）
// ─────────────────────────────────────────────────────────────────

/** 内存技能态（仅取静默 / 淘汰判定所需列）。 */
export interface MemFeedbackSkill {
  id: string;
  status: "active" | "retired";
  use_count: number;
  success_rate: number;
  silent_count: number;
  /** ISO 时间串。 */
  created_at: string;
}

/** 内存继承态（仅取静默判定所需列）。 */
export interface MemFeedbackInheritance {
  user_id: string;
  skill_id: string;
  /** ISO 时间串。 */
  acquired_at: string;
  /** ISO 时间串；null/undefined 表示从未被调用。 */
  last_used_at?: string | null;
}

/** 内存 Feedback_Writer 句柄（额外暴露内部态便于测试断言）。 */
export interface InMemoryFeedbackWriterStore extends FeedbackWriterStore {
  /** skill_id → 内存技能态（断言 silent_count / success_rate 变化用）。 */
  readonly skills: Map<string, MemFeedbackSkill>;
}

/** 内存 Feedback_Writer store 初始化数据。 */
export interface InMemoryFeedbackWriterStoreInit {
  skills?: MemFeedbackSkill[];
  inheritances?: MemFeedbackInheritance[];
}

/**
 * 创建内存 FeedbackWriterStore（与 PG 实现同契约，行为对齐）。仅供纯单元测试。
 */
export function createInMemoryFeedbackWriterStore(
  init: InMemoryFeedbackWriterStoreInit = {},
): InMemoryFeedbackWriterStore {
  const skills = new Map<string, MemFeedbackSkill>();
  for (const s of init.skills ?? []) skills.set(s.id, { ...s });
  const inheritances: MemFeedbackInheritance[] = (init.inheritances ?? []).map((i) => ({ ...i }));

  return {
    skills,

    async findSilentInheritances(silentBeforeIso: string): Promise<SilentInheritanceRow[]> {
      return inheritances
        .filter((i) => (i.last_used_at == null) && i.acquired_at <= silentBeforeIso)
        .map((i) => ({ user_id: i.user_id, skill_id: i.skill_id }));
    },

    async applySilentPenalty(
      skillId: string,
      silentDelta: number,
      decayFactor: number,
    ): Promise<void> {
      const s = skills.get(skillId);
      if (!s) return;
      s.silent_count += silentDelta;
      s.success_rate = s.success_rate * decayFactor;
    },

    async findEliminationCandidates(q: EliminationQuery): Promise<string[]> {
      const out: string[] = [];
      for (const s of skills.values()) {
        if (s.status !== "active") continue;
        if (s.created_at > q.windowStartIso) continue; // 观察未够久
        const rateBranch = s.use_count >= q.minSample && s.success_rate < q.elimThreshold;
        const silentBranch = s.use_count === 0 && s.silent_count >= q.minSample;
        if (rateBranch || silentBranch) out.push(s.id);
      }
      return out;
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 FeedbackWriterStore。`user_skill` / `skill`（006 迁移新增、无 RLS）
 * 走系统级 `query`（懒加载 `db/pool.js`，避免纯单测拉起 DB 模块）。
 */
export function createPgFeedbackWriterStore(): FeedbackWriterStore {
  return {
    async findSilentInheritances(silentBeforeIso: string): Promise<SilentInheritanceRow[]> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ user_id: string; skill_id: string }>(
        `SELECT user_id::text AS user_id, skill_id::text AS skill_id
           FROM user_skill
          WHERE last_used_at IS NULL AND acquired_at <= $1`,
        [silentBeforeIso],
      );
      return res.rows.map((r) => ({ user_id: r.user_id, skill_id: r.skill_id }));
    },

    async applySilentPenalty(
      skillId: string,
      silentDelta: number,
      decayFactor: number,
    ): Promise<void> {
      const { query } = await import("../db/pool.js");
      // silent_count 累加；success_rate 按衰减因子下调（不动 use_count，静默不计为成功复用）。
      await query(
        `UPDATE skill
            SET silent_count = silent_count + $2,
                success_rate = success_rate * $3,
                updated_at = now()
          WHERE id = $1`,
        [skillId, silentDelta, decayFactor],
      );
    },

    async findEliminationCandidates(q: EliminationQuery): Promise<string[]> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ id: string }>(
        `SELECT id::text AS id FROM skill
          WHERE status = 'active'
            AND created_at <= $1
            AND (
                  (use_count >= $3 AND success_rate < $2)
               OR (use_count = 0 AND silent_count >= $3)
            )`,
        [q.windowStartIso, q.elimThreshold, q.minSample],
      );
      return res.rows.map((r) => r.id);
    },
  };
}
