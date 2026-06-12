/**
 * 技能反哺（Skill Reflux）· 主动复用触发（T4 救援 + T5 查库，activeReuse.ts）
 * ------------------------------------------------------------------
 * 定位：管线分发阶段的「主动拉取」时机（design.md「Components and Interfaces · Dispatcher」
 * 的 T4/T5 异步超时小节，Req 19）。在任务 12 的 `Dispatcher.retrieve`（仅 active、平台过滤、
 * 渐进加载、LLM top-k + 降级）之上，补齐 **T4 救援 / T5 查库** 的「异步执行 + 超时 + 迟到仅参考」
 * 完整语义，供 riverMain 在「任务卡住/失败」「造轮子前」两处非侵入接入。
 *
 * 二者都是系统/agent 在任务内部发起的「拉取」（与对用户的主动推荐 T8 不同），不打扰用户，
 * 因此不受「用户驱动呼吸」约束（requirements Req 19 背景）。
 *
 * 核心语义（Req 19.9，本模块的可独立单测重点）：
 *  - **异步执行 + 超时**：检索以异步方式发起并设置超时上限（默认 `config.T4T5_Timeout_ms`=5s）；
 *  - **超时视未命中、任务立即继续**：IF 检索在超时内未返回 → 视为 `timeout`（按未命中处理），
 *    调用方立即继续原有流程（自行解决 / forge）；
 *  - **迟到仅作参考、不中断当前执行**：检索结果在超时后才到达时，仅经 `onLate` 回调作为后续步骤
 *    参考交回调用方（如追加进任务日志/意识流），**绝不**中断/回滚已经继续的当前执行。
 *
 * 其它约束：
 *  - 仅返 active（Req 19.8）：由注入的 `retrieve`（默认 `Dispatcher.retrieve`）保证只查 active、
 *    且本期不使用向量检索/embedding。
 *  - T4（Req 19.1–19.4）：以 goal + 失败上下文检索；命中作候选解法提供给当前任务线复用，复用结果
 *    按 Req 12 回写质量分（回写发生在技能被真正复用时，由 Feedback_Writer / `recordSkillOutcome`
 *    完成，不在本模块）；未命中不阻塞，任务继续。
 *  - T5（Req 19.5–19.7）：造轮子前以待造能力意图检索；命中则提示「优先复用而非新造」（最终是否复用
 *    由 agent 决策）；若 agent 仍选择新造，沉淀时按 Req 6 由 Deduplicator 查重合并——该去重发生在
 *    既有「采集入队 → 蒸馏 → 去重」管线中（riverMain 已在 forge/master_tool 成功后 enqueue），
 *    本模块不重复实现去重，仅负责「造轮子前查库 + 命中提示」。
 *
 * 依赖注入：检索函数 `retrieve` 可注入（默认绑定 `Dispatcher.retrieve`），超时时钟可注入（`setTimer`/
 * `clearTimer`，默认 `setTimeout`/`clearTimeout`），便于「mock dispatcher + 假超时」做纯单测。
 *
 * _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9_
 */

import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { Dispatcher, RetrieveReq, RetrievedSkill } from "./dispatcher.js";

// ─────────────────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────────────────

/** 主动复用一次触发的结果判定（对齐 Req 19.9 的「命中 / 未命中 / 超时」三态）。 */
export type ReuseOutcome =
  /** 在超时内检索到 ≥1 个匹配技能。 */
  | "hit"
  /** 在超时内检索完成但无匹配（或检索失败被吞错）→ 按未命中处理。 */
  | "miss"
  /** 超时内未返回 → 视为未命中、任务立即继续；真实结果迟到时仅经 onLate 作参考。 */
  | "timeout";

/** 一次主动复用触发（T4/T5 共用）的结果。 */
export interface ReuseResult {
  /** 三态判定。 */
  outcome: ReuseOutcome;
  /** 命中的候选技能（仅 active、渐进加载 Skill_Summary）；miss/timeout 为空数组。 */
  candidates: RetrievedSkill[];
  /** 人可读软提示（供注入意识流/任务日志）；无命中为空串。 */
  hint: string;
  /** 是否超时（= outcome==="timeout"）；调用方据此判定「任务立即继续」。 */
  timedOut: boolean;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入
// ─────────────────────────────────────────────────────────────────

/** 检索函数签名（默认绑定 `Dispatcher.retrieve`；仅返 active，平台过滤 + 渐进加载在其内部完成）。 */
export type RetrieveFn = (req: RetrieveReq) => Promise<RetrievedSkill[]>;

/** 可注入的定时器（便于「假超时」单测）。默认 `setTimeout`/`clearTimeout`。 */
export interface TimerLike {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** 默认定时器实现（unref，不吊住进程退出）。 */
const defaultTimer: TimerLike = {
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as unknown as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** ActiveReuse 依赖。 */
export interface ActiveReuseDeps {
  /** 检索函数；二选一：直接给 `retrieve`，或给 `dispatcher`（取其 `retrieve`）。 */
  retrieve?: RetrieveFn;
  /** Dispatcher（提供 retrieve）；当未直接注入 `retrieve` 时取 `dispatcher.retrieve`。 */
  dispatcher?: Dispatcher;
  /** 反哺配置（取 `T4T5_Timeout_ms`）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
  /** 超时上限（毫秒）；缺省取 `config.T4T5_Timeout_ms`（默认 5s）。 */
  timeoutMs?: number;
  /** 提示最多列出的候选条数（默认 3）。 */
  maxHint?: number;
  /** 可注入定时器（便于假超时单测）。 */
  timer?: TimerLike;
}

/** 单次触发的可选项（覆盖默认）。 */
export interface ReuseOptions {
  /** 提示标题（注入任务日志/意识流的前缀）。 */
  header?: string;
  /** 本次超时上限（毫秒）；缺省取 deps.timeoutMs。 */
  timeoutMs?: number;
  /** 本次提示最多条数；缺省取 deps.maxHint。 */
  max?: number;
  /**
   * 迟到结果回调（Req 19.9）：检索在超时后才返回时，把迟到的命中结果**仅作为后续步骤参考**
   * 交回调用方（如追加进任务日志）。绝不在此中断/回滚当前执行。无命中（空结果）不回调。
   * 回调内异常被吞掉，不影响主链。
   */
  onLate?: (late: { candidates: RetrievedSkill[]; hint: string }) => void;
}

// ─────────────────────────────────────────────────────────────────
// 提示格式化
// ─────────────────────────────────────────────────────────────────

/**
 * 把检索结果整形为人可读软提示（渐进加载，仅摘要，不展开 steps/script）。
 * 无结果返回空串。
 */
export function formatReuseHint(
  results: RetrievedSkill[],
  header: string,
  max: number,
): string {
  if (!results || results.length === 0) return "";
  const n = Math.max(1, Math.floor(max));
  const lines = results.slice(0, n).map((r) => {
    const s = r.summary;
    const scene = s.applicable_scenario ? `——${s.applicable_scenario}` : "";
    const flag = r.unverified_on_platform ? "（未在你平台验证）" : "";
    return `  · ${s.name}${scene}${flag}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────
// 核心：异步检索 + 超时 + 迟到仅参考（可独立单测）
// ─────────────────────────────────────────────────────────────────

/**
 * 把一个 Promise 与超时竞速（Req 19.9 的可测内核）：
 *  - 检索在超时内 resolve（有结果）→ `{ timedOut:false, value }`；
 *  - 检索在超时内 reject（失败）→ `{ timedOut:false, value:undefined }`（按未命中处理，不抛）；
 *  - 超时先到 → 立即 `{ timedOut:true }`（调用方立即继续）；之后检索若 resolve 出非空结果，
 *    经 `onLate` 仅作参考交回（绝不中断当前执行）；检索若 reject 则静默丢弃。
 *
 * 关键：超时分支 resolve 后，原 Promise 仍在后台运行，其迟到结果只走 `onLate`，
 * 不会二次 settle 本函数返回的 Promise。
 */
export function raceWithTimeout<T>(
  task: Promise<T>,
  ms: number,
  opts: { timer?: TimerLike; onLate?: (value: T) => void } = {},
): Promise<{ timedOut: boolean; value?: T }> {
  const timer = opts.timer ?? defaultTimer;
  return new Promise((resolve) => {
    let settled = false;
    const handle = timer.setTimer(() => {
      if (!settled) {
        settled = true;
        resolve({ timedOut: true }); // 超时 → 任务立即继续
      }
    }, ms);

    task.then(
      (value) => {
        if (!settled) {
          settled = true;
          timer.clearTimer(handle);
          resolve({ timedOut: false, value });
        } else if (opts.onLate) {
          // 已超时 → 迟到结果仅作参考，不中断当前执行（Req 19.9）。
          try {
            opts.onLate(value);
          } catch {
            /* onLate 异常吞掉，绝不影响主链 */
          }
        }
      },
      () => {
        // 检索失败：超时内 → 按未命中（value 留空）；已超时 → 静默丢弃。
        if (!settled) {
          settled = true;
          timer.clearTimer(handle);
          resolve({ timedOut: false });
        }
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────
// ActiveReuse 接口与工厂
// ─────────────────────────────────────────────────────────────────

/** 主动复用触发器（T4 救援 + T5 查库）。 */
export interface ActiveReuse {
  /**
   * T4 失败救援检索（Req 19.1–19.4）：任务 blocked/failed 或 verify_task failed 时，以 goal +
   * 失败上下文为检索条件，从公共库异步检索可解同类问题的 active 技能；超时视未命中、任务立即继续；
   * 命中作候选解法返回（复用结果的质量分回写由 Feedback_Writer 在真正复用时完成）。
   */
  rescueRetrieve(req: RetrieveReq, opts?: ReuseOptions): Promise<ReuseResult>;
  /**
   * T5 造轮子前查库（Req 19.5–19.7）：forge_capability/master_tool 新造前，以待造能力意图为检索
   * 条件异步查库是否已有可复用等价 active 技能；超时视未命中、立即继续；命中则提示「优先复用而非
   * 新造」（是否复用由 agent 决策）。若仍新造，沉淀时的去重合并由既有 Deduplicator 管线负责。
   */
  preForgeLookup(req: RetrieveReq, opts?: ReuseOptions): Promise<ReuseResult>;
}

/**
 * 创建 ActiveReuse 实例。
 * @param deps 依赖（`retrieve` 或 `dispatcher` 二选一必填其一）。
 */
export function createActiveReuse(deps: ActiveReuseDeps): ActiveReuse {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const defaultTimeoutMs = deps.timeoutMs ?? config.T4T5_Timeout_ms;
  const defaultMaxHint = deps.maxHint ?? 3;
  const timer = deps.timer ?? defaultTimer;

  const retrieve: RetrieveFn | undefined =
    deps.retrieve ?? (deps.dispatcher ? (req) => deps.dispatcher!.retrieve(req) : undefined);
  if (!retrieve) {
    throw new Error("createActiveReuse 需要注入 retrieve 或 dispatcher 之一");
  }

  /** T4/T5 共用的异步检索 + 超时 + 迟到仅参考主流程。 */
  async function run(
    req: RetrieveReq,
    defaultHeader: string,
    opts: ReuseOptions = {},
  ): Promise<ReuseResult> {
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    const max = opts.max ?? defaultMaxHint;
    const header = opts.header ?? defaultHeader;

    // 异步发起检索；与超时竞速。检索本身的失败由 raceWithTimeout 吞为「未命中」。
    const raced = await raceWithTimeout<RetrievedSkill[]>(retrieve!(req), timeoutMs, {
      timer,
      onLate: opts.onLate
        ? (late) => {
            // 迟到结果仅作参考：有命中才回调（空结果不打扰）。
            if (Array.isArray(late) && late.length > 0) {
              opts.onLate!({ candidates: late, hint: formatReuseHint(late, header, max) });
            }
          }
        : undefined,
    });

    if (raced.timedOut) {
      // 超时 → 视为未命中、任务立即继续（Req 19.9）。
      return { outcome: "timeout", candidates: [], hint: "", timedOut: true };
    }

    const results = raced.value ?? [];
    if (results.length === 0) {
      // 超时内完成但无匹配（或检索失败被吞）→ 未命中、不阻塞（Req 19.4）。
      return { outcome: "miss", candidates: [], hint: "", timedOut: false };
    }

    return {
      outcome: "hit",
      candidates: results,
      hint: formatReuseHint(results, header, max),
      timedOut: false,
    };
  }

  return {
    rescueRetrieve(req, opts) {
      return run(req, "【T4·救援：库内可能有可复用解法】", opts);
    },
    preForgeLookup(req, opts) {
      return run(req, "【T5·库内已有类似能力，可优先复用而非重复造轮子】", opts);
    },
  };
}
