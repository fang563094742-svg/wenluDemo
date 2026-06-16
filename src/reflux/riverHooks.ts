/**
 * 技能反哺（Skill Reflux）· riverMain 非侵入 hook 聚合入口（riverHooks.ts）
 * ------------------------------------------------------------------
 * 定位：任务 11「riverMain 非侵入 hook 接入」的封装层。把 Harvester / Distiller /
 * Dispatcher 的**默认实例**与**便捷调用**收拢在此，让 `riverMain.ts` 的接入点只剩
 * 一行调用，最大限度降低对 6800+ 行核心主循环的侵入（A4）。
 *
 * 设计约束（A4 非侵入 + 失败绝不破坏主链）：
 *  - 本文件**所有对外便捷函数**都自带 try/catch 吞错，绝不向上抛异常；失败仅 `console.warn`
 *    记日志，返回安全默认值（void / 空数组 / 空串），保证 `riverMain` 的接入点是纯追加式、
 *    失败时主链行为完全不变。
 *  - 采集路径零 LLM（Req 20.2）：`recordAction`/`recordInvocation`/`enqueue*`/`stashTrajectory`
 *    全部只做廉价入队/落库，重活留给 `distillPendingBatch`（consolidate 周期 + 兜底定时器）。
 *  - 检索（T2/T4/T5）做**本地超时围栏**（默认 1.5s）+ 降级空串，绝不阻塞呼吸/对话主循环；
 *    完整的 T4/T5 异步语义见任务 14，本文件只提供供 riverMain 调用的软提示 hook。
 *
 * 归属（A3 per-user）：贡献者 `contributor_id` 由 riverMain 传入（per-user `UserSession.userId`），
 * 迁移期 System_User 固定为 `SYSTEM_USER_LOCAL`（UUID 全零）。来源权重 `source_weight` 同样由
 * 调用方按"用户在场=user_task / 自主呼吸=autonomous"判定后传入。
 *
 * _Requirements: 2.1, 20.1, 20.4, 20.7, A4_
 */

import {
  createHarvester,
  SYSTEM_USER_LOCAL,
  type Harvester,
  type HarvestContext,
  type LogEntry,
} from "./harvester.js";
import { createDistiller, type Distiller, type DistillReport } from "./distiller.js";
import {
  createDispatcher,
  type Dispatcher,
  type RetrieveReq,
  type RetrievedSkill,
} from "./dispatcher.js";
import {
  createActiveReuse,
  type ActiveReuse,
  type ReuseOptions,
  type ReuseResult,
} from "./activeReuse.js";
import { createPgSkillRepo } from "./skillRepo.js";
import {
  createOnboarding,
  createPgOnboardingStore,
  type Onboarding,
  type OnboardResult,
  type TopUpResult,
} from "./onboarding.js";
import { resolveRefluxConfig, type RefluxConfig } from "./config.js";
import type {
  HarvestSignal,
  InvocationEvent,
  SignalRole,
  SkillPlatform,
  SkillSpec,
  SourceWeight,
  TrajectoryEvent,
  TrajectoryRef,
} from "./types.js";

export { SYSTEM_USER_LOCAL };

// ─────────────────────────────────────────────────────────────────
// 默认实例（绑定真实 PG）：懒初始化，避免 import 期触达 PG（pool 由 main 启动时 bootstrap）
// ─────────────────────────────────────────────────────────────────

let _harvester: Harvester | null = null;
let _distiller: Distiller | null = null;
let _dispatcher: Dispatcher | null = null;
let _activeReuse: ActiveReuse | null = null;
let _onboarding: Onboarding | null = null;
let _config: RefluxConfig | null = null;

function config(): RefluxConfig {
  if (!_config) _config = resolveRefluxConfig();
  return _config;
}

/** 默认 Harvester（零 LLM 采集）。 */
export function harvester(): Harvester {
  if (!_harvester) _harvester = createHarvester();
  return _harvester;
}

/** 默认 Distiller（蒸馏，复用 skill-flywheel.distillSkill）。 */
export function distiller(): Distiller {
  if (!_distiller) _distiller = createDistiller({ config: config() });
  return _distiller;
}

/** 默认 Dispatcher（检索分发，走真实 PG SkillRepo；无 LLM 挑选器 → 确定性降级）。 */
export function dispatcher(): Dispatcher {
  if (!_dispatcher) _dispatcher = createDispatcher({ repo: createPgSkillRepo(), config: config() });
  return _dispatcher;
}

/**
 * 默认 ActiveReuse（主动复用触发：T4 救援 + T5 查库）。绑定默认 Dispatcher 与反哺配置，
 * 超时上限取 `config.T4T5_Timeout_ms`（默认 5s，Req 19.9）。
 */
export function activeReuse(): ActiveReuse {
  if (!_activeReuse) _activeReuse = createActiveReuse({ dispatcher: dispatcher(), config: config() });
  return _activeReuse;
}

/** 默认 Onboarding: 新用户冷启动继承 starter skills (反哺下载半边). */
export function onboarding(): Onboarding {
  if (!_onboarding) {
    _onboarding = createOnboarding({
      repo: createPgSkillRepo(),
      store: createPgOnboardingStore(),
      config: config(),
    });
  }
  return _onboarding;
}

/**
 * 新用户冷启动继承入口 (auth 在注册成功 / 首登后调用).
 * 失败仅 console.warn, 不影响注册主链 (Req 17.10).
 */
export async function hookOnboard(
  userId: string,
  platform?: SkillPlatform,
): Promise<OnboardResult | null> {
  try {
    return await onboarding().onboard(userId, platform);
  } catch (e) {
    swallow(`hookOnboard userId=${userId.slice(0, 8)}`, e);
    return null;
  }
}

/**
 * 连接器上线后补继承入口 (riverMain 收到连接器上线事件后调用).
 * 失败仅 console.warn, 不影响连接器主链.
 */
export async function hookTopUpOnConnector(
  userId: string,
  platform: SkillPlatform,
): Promise<TopUpResult | null> {
  try {
    return await onboarding().topUpOnConnector(userId, platform);
  } catch (e) {
    swallow(`hookTopUpOnConnector userId=${userId.slice(0, 8)} platform=${platform}`, e);
    return null;
  }
}

/** 统一吞错日志（不向上抛，保证主链不被破坏，A4）。 */
function swallow(where: string, err: unknown): void {
  console.warn(
    `[reflux/riverHooks] ${where} 失败（已吞错不影响主链）：`,
    err instanceof Error ? err.message : String(err),
  );
}

/** 归属上下文（由 riverMain 传入）。 */
export interface HookAttribution {
  /** 贡献者 userId（per-user；迁移期可用 SYSTEM_USER_LOCAL）。 */
  contributor_id?: string;
  /** 来源权重（user_task 优先 / autonomous 降权）。 */
  source_weight?: SourceWeight;
  /** 任务线 id（轨迹关联用）。 */
  task_id?: string;
}

/** 把归属上下文补全为 Harvester 所需的 HarvestContext（缺省落 SYSTEM_USER_LOCAL / autonomous）。 */
function toCtx(attr: HookAttribution = {}): HarvestContext {
  return {
    contributor_id: attr.contributor_id || SYSTEM_USER_LOCAL,
    source_weight: attr.source_weight ?? "autonomous",
    task_id: attr.task_id,
  };
}

// ─────────────────────────────────────────────────────────────────
// 采集 hook（executeTool 入口 / 工具分支末尾；全部 try/catch 吞错）
// ─────────────────────────────────────────────────────────────────

/** executeTool 入口：维护轨迹环形缓冲（Req 3.2）。失败吞错。 */
export async function recordAction(ev: TrajectoryEvent): Promise<void> {
  try {
    await harvester().recordAction(ev);
  } catch (err) {
    swallow("recordAction", err);
  }
}

/** 命令指纹命中已知技能/命令时：记一条调用事件（反向点亮 + 静默检测，Req 2.9）。失败吞错。 */
export async function recordInvocation(ev: InvocationEvent): Promise<void> {
  try {
    await harvester().recordInvocation(ev);
  } catch (err) {
    swallow("recordInvocation", err);
  }
}

/** forge_capability / master_tool 成功后：可执行坯子入队（executable_seed）。失败吞错。 */
export async function enqueueExecutableSeed(input: {
  source_tool: string;
  payload: Record<string, unknown>;
  attr?: HookAttribution;
  linked_prediction_id?: string;
  linked_verifiable_id?: string;
}): Promise<void> {
  try {
    const ctx = toCtx(input.attr);
    const sig: HarvestSignal = {
      signal_role: "executable_seed",
      source_tool: input.source_tool,
      source_weight: ctx.source_weight,
      contributor_id: ctx.contributor_id,
      payload: input.payload,
      linked_prediction_id: input.linked_prediction_id,
      linked_verifiable_id: input.linked_verifiable_id,
      task_id: ctx.task_id,
    };
    await harvester().enqueue(sig);
  } catch (err) {
    swallow("enqueueExecutableSeed", err);
  }
}

/** add_rule / runConsolidation 概念等：软技能坯子入队（soft_seed）。失败吞错。 */
export async function enqueueSoftSeed(input: {
  source_tool: string;
  payload: Record<string, unknown>;
  attr?: HookAttribution;
}): Promise<void> {
  try {
    const ctx = toCtx(input.attr);
    const sig: HarvestSignal = {
      signal_role: "soft_seed",
      source_tool: input.source_tool,
      source_weight: ctx.source_weight,
      contributor_id: ctx.contributor_id,
      payload: input.payload,
      task_id: ctx.task_id,
    };
    await harvester().enqueue(sig);
  } catch (err) {
    swallow("enqueueSoftSeed", err);
  }
}

/** verify_task passed：truth_gate 信号入队（带 linked_verifiable_id + 证据/轨迹引用）。失败吞错。 */
export async function onVerifyPassed(
  verifiableId: string,
  evidence: string,
  trajectory: TrajectoryRef,
  attr?: HookAttribution,
): Promise<void> {
  try {
    await harvester().onVerifyPassed(verifiableId, evidence, trajectory, toCtx(attr));
  } catch (err) {
    swallow("onVerifyPassed", err);
  }
}

/** settle_prediction 结算：hit 入队为 truth_gate；miss 不入队为成功信号（Req 2.6）。失败吞错。 */
export async function onPredictionSettled(
  predictionId: string,
  result: "hit" | "miss",
  outcome: string,
  attr?: HookAttribution,
): Promise<void> {
  try {
    await harvester().onPredictionSettled(predictionId, result, outcome, toCtx(attr));
  } catch (err) {
    swallow("onPredictionSettled", err);
  }
}

/** finish_task done / blocked / failed：仅把 cur.log 作为轨迹原料落库，不入队为成功信号。失败吞错。 */
export async function stashTrajectory(
  taskId: string,
  log: LogEntry[],
  goal: string,
  result: string,
  attr?: HookAttribution,
): Promise<void> {
  try {
    await harvester().stashTrajectory(taskId, log, goal, result, toCtx(attr));
  } catch (err) {
    swallow("stashTrajectory", err);
  }
}

// ─────────────────────────────────────────────────────────────────
// 补一路采集源：local skillKB 已蒸馏技能（一期 distillSkill 产出 SkillSpec）入队
// ─────────────────────────────────────────────────────────────────

/** 进程内已入队的 local skillKB 技能 id（避免每轮 consolidate 重复入队）。 */
const _enqueuedLocalSkillIds = new Set<string>();

/**
 * 把一期 `skill-flywheel` 已蒸馏入库的本地技能（`mind.skillKB.skills`，即 `SkillSpec[]`）
 * 作为二期云反哺的采集源入队，复用一期成果、避免重复蒸馏（design「Harvester 采集映射」表
 * local skillKB 行）。按 kind 归类：有可执行步骤（`exec.steps` 非空）→ executable_seed，
 * 否则 → soft_seed。进程内按 skill id 去重，仅入队一次。失败吞错。
 *
 * 说明：这里把已蒸馏 `SkillSpec` 原样放进 payload，供后续蒸馏/去重阶段直接消费（不再从原始
 * 轨迹重蒸馏）；payload 仅含可泛化的方法/步骤（一期产出已过 `scanResidualPrivacy` 去隐私），
 * 不含对具体主人的理解，仍受 Harvester 的 Entry_Gate 隐私闸兜底。
 *
 * @returns 本次实际新入队的技能数。
 */
export async function harvestLocalSkillKB(
  skills: SkillSpec[] | undefined,
  attr?: HookAttribution,
): Promise<number> {
  try {
    if (!Array.isArray(skills) || skills.length === 0) return 0;
    const ctx = toCtx(attr);
    let enqueued = 0;
    for (const spec of skills) {
      if (!spec || !spec.id) continue;
      if (_enqueuedLocalSkillIds.has(spec.id)) continue; // 进程内去重，避免重复入队
      const hasExec = (spec.exec?.steps?.length ?? 0) > 0;
      const role: SignalRole = hasExec ? "executable_seed" : "soft_seed";
      const sig: HarvestSignal = {
        signal_role: role,
        source_tool: "local_skill_kb", // 标记来源为一期本地技能库（避免重复蒸馏的复用标识）
        source_weight: ctx.source_weight,
        contributor_id: ctx.contributor_id,
        payload: {
          // 复用一期成果：携带已蒸馏 SkillSpec，供后续阶段直接消费。
          goal: spec.when?.taskPattern ?? spec.name,
          title: spec.name,
          description: spec.when?.taskPattern ?? spec.name,
          platform: spec.platform?.[0],
          taxonomy: spec.taxonomy,
          skill_spec: spec,
          reused_from: "skill-flywheel.distillSkill",
        },
      };
      const ok = await harvester().enqueue(sig);
      // 无论入队成功与否都登记，避免反复对同一技能尝试（被隐私闸拒绝的也不必重试）。
      _enqueuedLocalSkillIds.add(spec.id);
      if (ok) enqueued++;
    }
    return enqueued;
  } catch (err) {
    swallow("harvestLocalSkillKB", err);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// 蒸馏（runConsolidation 末尾 + 兜底定时器）
// ─────────────────────────────────────────────────────────────────

let _lastDistillAt = Date.now();
let _fallbackTimer: ReturnType<typeof setInterval> | null = null;

/** 在 runConsolidation 末尾搭车批量蒸馏（Req 20.4/20.7）。失败吞错，返回 null。 */
export async function distillPendingBatch(): Promise<DistillReport | null> {
  try {
    const report = await distiller().distillPendingBatch();
    _lastDistillAt = Date.now();
    return report;
  } catch (err) {
    swallow("distillPendingBatch", err);
    _lastDistillAt = Date.now(); // 即便失败也推进时间戳，避免兜底定时器抖动式重试
    return null;
  }
}

/**
 * 启动蒸馏兜底定时器（design ADR-1）：距上次蒸馏超过 `DISTILL_MAX_INTERVAL` 即补跑一次，
 * 防止长期无 consolidate 时 pending 信号饿死。定时器 `unref`，不吊住进程退出。幂等（重复调用不重建）。
 */
export function startDistillFallbackTimer(): void {
  try {
    if (_fallbackTimer) return;
    const cfg = config();
    const maxInterval = cfg.DISTILL_MAX_INTERVAL_ms;
    const checkMs = Math.max(60_000, Math.floor(maxInterval / 2)); // 至少 1 分钟检查一次
    _fallbackTimer = setInterval(() => {
      try {
        if (Date.now() - _lastDistillAt > maxInterval) {
          void distillPendingBatch();
        }
      } catch (err) {
        swallow("distillFallbackTimer.tick", err);
      }
    }, checkMs);
    // unref：定时器不阻止进程退出。
    (_fallbackTimer as unknown as { unref?: () => void }).unref?.();
  } catch (err) {
    swallow("startDistillFallbackTimer", err);
  }
}

/** 停止兜底定时器（供测试/优雅关停）。 */
export function stopDistillFallbackTimer(): void {
  try {
    if (_fallbackTimer) {
      clearInterval(_fallbackTimer);
      _fallbackTimer = null;
    }
  } catch (err) {
    swallow("stopDistillFallbackTimer", err);
  }
}

// ─────────────────────────────────────────────────────────────────
// 检索分发（T2 场景注入 / T4 救援 / T5 查库；本地超时围栏 + 降级空串，绝不阻塞主链）
// ─────────────────────────────────────────────────────────────────

/** 给检索套一个本地超时围栏：超时即返回降级值，绝不阻塞主链。 */
function withLocalTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

/** 检索分发（带本地超时围栏）。失败/超时返回空数组，绝不阻塞、绝不抛。 */
export async function retrieve(req: RetrieveReq, timeoutMs = 1500): Promise<RetrievedSkill[]> {
  try {
    return await withLocalTimeout(dispatcher().retrieve(req), timeoutMs, [] as RetrievedSkill[]);
  } catch (err) {
    swallow("retrieve", err);
    return [];
  }
}

/**
 * 把检索结果整形为人可读软提示（供 T2/T4/T5 注入意识流/工具回执）。无命中返回空串。
 * 仅返摘要（渐进加载，Req 11.4），不展开完整 steps/script。
 */
export async function retrieveHint(
  req: RetrieveReq,
  opts: { header?: string; timeoutMs?: number; max?: number } = {},
): Promise<string> {
  try {
    const results = await retrieve(req, opts.timeoutMs ?? 1500);
    if (results.length === 0) return "";
    const max = Math.max(1, opts.max ?? 3);
    const header = opts.header ?? "【技能库可复用】";
    const lines = results.slice(0, max).map((r) => {
      const s = r.summary;
      const flag = r.unverified_on_platform ? "（未在你平台验证）" : "";
      const scene = s.applicable_scenario ? `——${s.applicable_scenario}` : "";
      return `  · ${s.name}${scene}${flag}`;
    });
    return `${header}\n${lines.join("\n")}`;
  } catch (err) {
    swallow("retrieveHint", err);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────
// 主动复用触发（T4 救援 / T5 查库；异步 + 超时(默认 5s) + 迟到仅参考，Req 19.9）
// ─────────────────────────────────────────────────────────────────

/**
 * T4 失败救援检索（Req 19.1–19.4/19.9）：任务 blocked/failed 或 verify_task failed 时调用。
 * 异步检索 + 超时（默认 `config.T4T5_Timeout_ms`=5s），超时视未命中、调用方立即继续；命中返回
 * 候选解法与软提示；迟到结果经 `opts.onLate` 仅作参考、不中断当前执行。失败吞错返回 miss。
 */
export async function rescueRetrieve(
  req: RetrieveReq,
  opts: ReuseOptions = {},
): Promise<ReuseResult> {
  try {
    return await activeReuse().rescueRetrieve(req, opts);
  } catch (err) {
    swallow("rescueRetrieve", err);
    return { outcome: "miss", candidates: [], hint: "", timedOut: false };
  }
}

/**
 * T5 造轮子前查库（Req 19.5–19.7/19.9）：forge_capability/master_tool 新造前调用。
 * 异步检索 + 超时（默认 5s），超时视未命中、立即继续新造；命中提示「优先复用而非新造」（是否复用
 * 由 agent 决策）；迟到结果经 `opts.onLate` 仅作参考。失败吞错返回 miss。
 */
export async function preForgeLookup(
  req: RetrieveReq,
  opts: ReuseOptions = {},
): Promise<ReuseResult> {
  try {
    return await activeReuse().preForgeLookup(req, opts);
  } catch (err) {
    swallow("preForgeLookup", err);
    return { outcome: "miss", candidates: [], hint: "", timedOut: false };
  }
}
