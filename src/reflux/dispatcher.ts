/**
 * 技能反哺（Skill Reflux）· Dispatcher（检索分发 + 渐进加载 + 降级，dispatcher.ts）
 * ------------------------------------------------------------------
 * 定位：管线分发阶段（design.md「Components and Interfaces · Dispatcher」），对应
 * 检索分发 T2/T4/T5 的核心读路径。冷启动 T1（`onboard`/`topUpOnConnector`）归任务 13，
 * 本模块只实现 `retrieve` / `expand` / `inherit`（骨架）三件事。
 *
 * 三件事（Req 11 / Req 15）：
 *  - `retrieve`（12.1/12.2/12.3）：先 category+tags 筛（**复用 `skillRepo.search`**，仅 active、
 *    渐进加载默认只返 Skill_Summary）→ 交注入的 LLM 挑 top-k（`TopKPicker` 依赖注入便于 mock）；
 *    LLM 挑选失败/超时即**降级**为按 `quality_score` 降序确定性取 top-k，不阻塞（Req 11.8）；
 *    再做**平台过滤/标注**：可执行技能按继承方连接器平台过滤，有该平台 `connector-verified`
 *    变体的直接分发；仅平台中立意图的附 `render_hint_template[os]` 渲染提示 + 标「未在你平台验证」
 *    （Req 11.7 / 15.5/15.6/15.7/15.9/15.10/15.13）。
 *  - `expand`（12.1）：渐进加载第二段——**复用 `skillRepo.get`** 展开完整 `exec_steps`/script。
 *  - `inherit`（骨架）：**复用 `capability-pool.inheritSkills`**（幂等：同 (user, skill) 只继承一次）。
 *
 * 重渲染闭环接口预留（Req 15.5–15.7/15.11/15.12）：`settleRenderedVariant` 提供
 * 「重渲染 → 安全预审 → 连接器试跑 → 通过才沉淀新变体」的编排骨架，**实际验证调用任务 8 的
 * `Verifier`**（注入），安全预审与连接器执行均由 `Verifier.verifyExecutable` 内核完成，
 * 验证失败不沉淀（Req 15.12）。
 *
 * 依赖注入：LLM 挑选器（`TopKPicker`）、渲染提示模板读取（`RenderHintProvider`）、继承函数
 * （`inheritFn`）、验证器（`Verifier`）、变体落库（`persistVariant`）全部可注入，便于 mock
 * （单测脱离真实 PG / 真实 LLM / 真实连接器）。
 *
 * _Requirements: 11.1, 11.2, 11.4, 11.7, 11.8, 15.5, 15.6, 15.7, 15.9, 15.10, 15.11, 15.12, 15.13_
 */

import { inheritSkills as defaultInheritSkills } from "../capability-pool/repo.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { SkillRepo } from "./skillRepo.js";
import type { Verifier } from "./verifier.js";
import type {
  Skill,
  SkillSummary,
  SkillPlatform,
  VariantOS,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// 检索入参 / 出参
// ─────────────────────────────────────────────────────────────────

/** 检索分发请求（T2 场景注入 / T4 救援 / T5 查库共用）。 */
export interface RetrieveReq {
  /** 发起检索的继承方 userId。 */
  userId: string;
  /** 平台中立的检索意图（goal/场景描述），供 LLM 精选；缺省时纯走确定性排序。 */
  query?: string;
  /** 分类过滤（对应 skill.category）。 */
  category?: string;
  /** 标签过滤（命中任一即匹配，OR 语义）。 */
  tags?: string[];
  /** 继承方连接器平台：可执行技能据此过滤/标注；soft/any 不受限。 */
  platform?: SkillPlatform;
  /** 最终返回上限（LLM/确定性挑选后的 top-k）；缺省取 deps.defaultTopK。 */
  topK?: number;
  /** 先按 category+tags 取的候选上限（再交 LLM 精选）；缺省 50。 */
  searchLimit?: number;
}

/** 平台分发状态（可执行技能针对继承方平台的可用性判定）。 */
export type PlatformStatus =
  /** 与平台无关（soft / os_scope=any / platform 含 any）：直接可用。 */
  | "platform_agnostic"
  /** 该平台存在 connector-verified 变体：直接分发。 */
  | "verified"
  /** 仅平台中立意图、该平台无已验证变体：附渲染提示 + 标「未在你平台验证」。 */
  | "needs_render";

/**
 * 检索分发的单条结果：在渐进加载默认视图 `SkillSummary` 之上，附平台分发标注。
 * **不含 `exec_steps`/script**（保持 Req 11.4 渐进加载：完整内容须经 `expand`），
 * 仅追加平台可用性元数据，用于继承方据此直发或重渲染。
 */
export interface RetrievedSkill {
  /** 渐进加载默认视图（不含完整执行体）。 */
  summary: SkillSummary;
  /** 平台分发状态。 */
  platform_status: PlatformStatus;
  /** 是否可在继承方平台直接分发（verified / platform_agnostic 为 true）。 */
  dispatchable: boolean;
  /** 是否标「未在你平台验证」（needs_render 为 true）。 */
  unverified_on_platform: boolean;
  /** needs_render 时附带的目标平台渲染提示模板（render_hint_template[os]）。 */
  render_hint?: string;
  /** 命中的目标平台（可执行技能；platform_agnostic 时为 undefined）。 */
  os?: VariantOS;
}

/** `inherit` 结果（骨架）。 */
export interface InheritResult {
  /** 实际继承到的技能 id 列表。 */
  inherited: string[];
  /** 继承数量。 */
  count: number;
}

/** `settleRenderedVariant` 结果（重渲染闭环接口预留）。 */
export interface SettleVariantResult {
  /** 是否已沉淀为该平台的新 connector-verified 变体。 */
  sedimented: boolean;
  /** 落定的验证状态。 */
  status: "connector-verified" | "unverified";
  /** 是否被安全预审拦截（未在连接器执行）。 */
  safetyBlocked: boolean;
  /** 人类可读结论。 */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入抽象（LLM 挑选 / 渲染提示 / 继承 / 变体落库）
// ─────────────────────────────────────────────────────────────────

/**
 * LLM top-k 挑选器（依赖注入点，便于 mock，Req 11.1）。
 * 输入候选摘要，返回按相关性排序的技能 id 子集；**挑选失败/超时即抛错**，由 Dispatcher
 * 降级为确定性排序（Req 11.8）。
 */
export interface TopKPicker {
  pick(input: { query?: string; candidates: SkillSummary[]; topK: number }): Promise<string[]>;
}

/**
 * 渲染提示模板读取（依赖注入点，便于 mock，Req 15.13）。
 * 取目标平台的 `render_hint_template[os]`；无模板时返回 null/undefined（不影响主流程）。
 */
export interface RenderHintProvider {
  get(os: VariantOS): Promise<string | null | undefined>;
}

/** 继承函数签名（默认复用 `capability-pool.inheritSkills`，幂等）。 */
export type InheritFn = (
  userId: string,
  skillIds?: string[],
) => Promise<Array<{ id: string }>>;

/** 重渲染变体落库入参（接口预留；默认 PG 实现）。 */
export interface PersistVariantInput {
  skillId: string;
  os: VariantOS;
  command: string;
  verifiedBy: string;
}

// ─────────────────────────────────────────────────────────────────
// 安全预审黑名单（与 verifier.ts / capability-pool 等价，仅用于 needs_render 提示前置说明）
// ─────────────────────────────────────────────────────────────────

// 说明：`settleRenderedVariant` 的安全预审与连接器执行统一由注入的 `Verifier.verifyExecutable`
// 内核完成（其内部已含 DANGEROUS_PATTERNS 预审），此处不重复实现，避免两套黑名单漂移。

// ─────────────────────────────────────────────────────────────────
// Dispatcher 依赖与接口
// ─────────────────────────────────────────────────────────────────

/** Dispatcher 依赖（repo 必填；其余可选，缺省走 PG / 默认配置 / 确定性挑选）。 */
export interface DispatcherDeps {
  /** 技能数据访问层：复用 `search`（category+tags 筛）/ `get`（渐进加载展开）。 */
  repo: SkillRepo;
  /** LLM top-k 挑选器；未注入 → 纯按 quality_score 降序确定性挑选（无 LLM）。 */
  picker?: TopKPicker;
  /** 渲染提示模板读取；缺省 `createPgRenderHintProvider()`（真实 PG）。 */
  renderHint?: RenderHintProvider;
  /** 继承函数；缺省复用 `capability-pool.inheritSkills`（幂等）。 */
  inheritFn?: InheritFn;
  /** 验证器（`settleRenderedVariant` 必需，复用任务 8 的 Verifier）。 */
  verifier?: Verifier;
  /** 重渲染变体落库；缺省 `createPgVariantPersister()`（真实 PG）。 */
  persistVariant?: (input: PersistVariantInput) => Promise<void>;
  /** 反哺配置（取超时等）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
  /** top-k 默认值（req.topK 未给时使用）；默认 5。 */
  defaultTopK?: number;
  /** LLM 挑选超时（毫秒）；默认 config.T4T5_Timeout_ms（5s）。 */
  pickTimeoutMs?: number;
}

/** Dispatcher 对外接口（对齐 design.md；onboard/topUpOnConnector 归任务 13）。 */
export interface Dispatcher {
  /** 检索分发：category+tags 筛 → LLM top-k（失败降级）→ 平台过滤/标注，仅返 Skill_Summary。 */
  retrieve(req: RetrieveReq): Promise<RetrievedSkill[]>;
  /** 渐进加载第二段：展开完整 exec_steps/script（复用 skillRepo.get），不存在返回 null。 */
  expand(skillId: string, userId: string): Promise<Skill | null>;
  /** 继承（骨架）：复用 capability-pool.inheritSkills，幂等。 */
  inherit(userId: string, skillIds?: string[]): Promise<InheritResult>;
  /**
   * 重渲染闭环（接口预留）：对待重渲染的命令先经安全预审 + 连接器试跑（由注入的 Verifier 完成），
   * 通过才沉淀为该平台新 connector-verified 变体；失败/被拦截不沉淀（Req 15.5–15.7/15.11/15.12）。
   */
  settleRenderedVariant(input: {
    skillId: string;
    os: VariantOS;
    command: string;
    verifyCmd?: string;
    timeoutMs?: number;
  }): Promise<SettleVariantResult>;
}

// ─────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────

/** 给一个 Promise 套超时；超时则 reject（用于 LLM 挑选不阻塞主链，Req 11.8）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pick 超时(${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 把请求平台收窄为 VariantOS（any/缺省 → undefined，表示不做平台过滤）。 */
function toVariantOS(platform?: SkillPlatform): VariantOS | undefined {
  if (!platform || platform === "any") return undefined;
  return platform;
}

// ─────────────────────────────────────────────────────────────────
// Dispatcher 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建 Dispatcher 实例。
 * @param deps 依赖（repo 必填）；不传可选项则走 PG / 默认配置 / 确定性挑选。
 */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const repo = deps.repo;
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const defaultTopK = deps.defaultTopK ?? 5;
  const pickTimeoutMs = deps.pickTimeoutMs ?? config.T4T5_Timeout_ms;
  const inheritFn = deps.inheritFn ?? (defaultInheritSkills as InheritFn);
  const renderHint = deps.renderHint ?? createPgRenderHintProvider();
  const persistVariant = deps.persistVariant ?? createPgVariantPersister();

  /**
   * top-k 挑选（Req 11.1 + 11.8 降级）：
   *  - 有 LLM 挑选器：套超时调用，成功取交集（保序）；返回空/异常/超时 → 降级。
   *  - 无 LLM 挑选器或降级：按 quality_score 降序确定性取 top-k，不阻塞。
   */
  async function selectTopK(summaries: SkillSummary[], req: RetrieveReq): Promise<SkillSummary[]> {
    const topK = Math.max(1, Math.floor(req.topK ?? defaultTopK));
    const deterministic = (): SkillSummary[] =>
      [...summaries].sort((a, b) => b.quality_score - a.quality_score).slice(0, topK);

    if (!deps.picker || summaries.length === 0) return deterministic();

    try {
      const ids = await withTimeout(
        deps.picker.pick({ query: req.query, candidates: summaries, topK }),
        pickTimeoutMs,
      );
      const byId = new Map(summaries.map((s) => [s.id, s]));
      const picked = ids
        .map((id) => byId.get(id))
        .filter((s): s is SkillSummary => !!s)
        .slice(0, topK);
      // LLM 返回空集（无可用挑选）→ 降级确定性，避免空手而归。
      return picked.length > 0 ? picked : deterministic();
    } catch {
      // 挑选失败/超时 → 降级确定性 top-k，不阻塞（Req 11.8）。
      return deterministic();
    }
  }

  /**
   * 平台过滤/标注（Req 11.7 / 15.9/15.10）：
   *  - 无平台过滤（os 为空）/ soft / os_scope=any / platform 含 any → platform_agnostic 直发；
   *  - 该平台有 connector-verified 变体 → verified 直发；
   *  - 否则（仅平台中立意图）→ needs_render：附 render_hint_template[os] + 标「未在你平台验证」。
   */
  async function annotatePlatform(
    summary: SkillSummary,
    os: VariantOS | undefined,
  ): Promise<RetrievedSkill> {
    // 复用 skillRepo.get 取完整技能以读 kind/os_scope/variants（用于平台判定，结果仍只返摘要）。
    const skill = os ? await repo.get(summary.id) : null;

    if (!os || !skill || skill.kind === "soft" || skill.os_scope === "any" || skill.platform.includes("any")) {
      return {
        summary: { ...summary, platform_verified: undefined },
        platform_status: "platform_agnostic",
        dispatchable: true,
        unverified_on_platform: false,
      };
    }

    const hasVerifiedVariant = (skill.variants ?? []).some(
      (v) => v.os === os && v.verify_status === "connector-verified",
    );

    if (hasVerifiedVariant) {
      return {
        summary: { ...summary, platform_verified: true },
        platform_status: "verified",
        dispatchable: true,
        unverified_on_platform: false,
        os,
      };
    }

    // 仅平台中立意图：附渲染提示 + 标「未在你平台验证」（Req 15.7/15.10/15.13）。
    const hint = (await renderHint.get(os)) ?? undefined;
    return {
      summary: { ...summary, platform_verified: false },
      platform_status: "needs_render",
      dispatchable: true,
      unverified_on_platform: true,
      render_hint: hint,
      os,
    };
  }

  return {
    async retrieve(req: RetrieveReq): Promise<RetrievedSkill[]> {
      // 1) category+tags 筛（复用 skillRepo.search，仅 active、渐进加载默认只返 Skill_Summary，
      //    并在 SQL 侧按平台预过滤可执行技能）。
      const summaries = await repo.search({
        category: req.category,
        tags: req.tags,
        platform: req.platform,
        limit: req.searchLimit ?? 50,
      });

      // 2) LLM 挑 top-k（失败/超时降级为确定性 quality_score 降序，Req 11.8）。
      const selected = await selectTopK(summaries, req);

      // 3) 平台过滤/标注（可执行技能按继承方平台分流；soft/any 直发，Req 11.7/15.9）。
      const os = toVariantOS(req.platform);
      const annotated: RetrievedSkill[] = [];
      for (const s of selected) {
        annotated.push(await annotatePlatform(s, os));
      }
      return annotated;
    },

    expand(skillId: string, _userId: string): Promise<Skill | null> {
      // 渐进加载第二段：复用 skillRepo.get 展开完整 exec_steps/script（含变体）。
      // userId 预留（后续可做 user_skill.enabled 过滤 / 个性化），当前仅按 id 展开。
      return repo.get(skillId);
    },

    async inherit(userId: string, skillIds?: string[]): Promise<InheritResult> {
      // 复用 capability-pool.inheritSkills：幂等（同 (user, skill) 只继承一次）。
      const rows = await inheritFn(userId, skillIds);
      return { inherited: rows.map((r) => r.id), count: rows.length };
    },

    async settleRenderedVariant(input): Promise<SettleVariantResult> {
      const verifier = deps.verifier;
      if (!verifier) {
        throw new Error("settleRenderedVariant 需要注入 verifier（任务 8 的 Verifier）");
      }
      // 安全预审 + 连接器试跑由 Verifier.verifyExecutable 内核完成（viaConnector=true）。
      // 不传 skillId：先裁定，通过后再由本方法显式沉淀新变体（失败不沉淀，Req 15.12）。
      const result = await verifier.verifyExecutable({
        command: input.command,
        os: input.os,
        verifyCmd: input.verifyCmd,
        viaConnector: true,
        timeoutMs: input.timeoutMs,
      });

      if (result.safetyBlocked) {
        return {
          sedimented: false,
          status: "unverified",
          safetyBlocked: true,
          reason: `安全预审拦截，未在连接器执行: ${result.reason}`,
        };
      }
      if (!result.passed || result.status !== "connector-verified") {
        // 连接器验证未通过 → 不沉淀（Req 15.12）。
        return {
          sedimented: false,
          status: "unverified",
          safetyBlocked: false,
          reason: `连接器验证未通过，不沉淀新变体: ${result.reason}`,
        };
      }

      // 通过 → 沉淀为该平台新 connector-verified 变体（Req 15.6）。
      const verifiedBy = result.verifiedBy ?? "connector";
      await persistVariant({
        skillId: input.skillId,
        os: input.os,
        command: input.command,
        verifiedBy,
      });
      return {
        sedimented: true,
        status: "connector-verified",
        safetyBlocked: false,
        reason: `已沉淀 ${input.os} 平台新 connector-verified 变体（by ${verifiedBy}）`,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 实现（render_hint_template 读取 / 重渲染变体落库）
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的渲染提示模板读取器（读 `render_hint_template` 表，任务 17 初始化其内容）。
 * 表/行缺失时返回 null（不影响主流程，分发仍可标「未在你平台验证」）。
 */
export function createPgRenderHintProvider(): RenderHintProvider {
  return {
    async get(os: VariantOS): Promise<string | null | undefined> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ template: string }>(
        `SELECT template FROM render_hint_template WHERE os = $1`,
        [os],
      );
      return res.rows[0]?.template ?? null;
    },
  };
}

/**
 * 创建走真实 PG 的重渲染变体落库器：把已 connector-verified 的重渲染命令沉淀为该平台变体
 * （Req 15.6）。`ON CONFLICT (skill_id, os)` 更新为 connector-verified。
 */
export function createPgVariantPersister(): (input: PersistVariantInput) => Promise<void> {
  return async (input: PersistVariantInput): Promise<void> => {
    const { query } = await import("../db/pool.js");
    await query(
      `INSERT INTO skill_platform_variant (skill_id, os, command, verify_status, verified_at, verified_by, fail_streak)
       VALUES ($1, $2, $3, 'connector-verified', now(), $4, 0)
       ON CONFLICT (skill_id, os)
       DO UPDATE SET command = EXCLUDED.command, verify_status = 'connector-verified',
                     verified_at = now(), verified_by = EXCLUDED.verified_by, fail_streak = 0`,
      [input.skillId, input.os, input.command, input.verifiedBy],
    );
  };
}
