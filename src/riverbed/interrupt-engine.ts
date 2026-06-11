/**
 * 河床系统（Riverbed System）· 打断引擎（Interrupt Engine）
 * ------------------------------------------------------------------
 * 移植自产品后端 lib/wenlu/past-riverbed/interrupt-engine.ts，**剥壳 + 接地**：
 *   - 剥掉 `import "server-only"`、`@/lib/...` 别名、sqlite、AuthorityRow 表依赖。
 *   - 接地到弟弟既有世界：消费 `RiverbedNode[]`（已含 interruptAuthority）+ 一段
 *     "当下情境文本"，无需 PresentSlice / user_id / DB。
 *
 * 这是河床从"被动渲染进意识"升级为"主动在关键时刻插话"的那只手——把过去稳定的
 * 高权威判断，在当下情境与它高度相关时，按三级强度推到台前：
 *   - whisper：耳语。只注入意识（system prompt），不打断主流，让它"心里有数"。
 *   - knock：敲门。值得主动说一句，但限频（默认 1 次/小时），防打扰。
 *   - intercept：拦截。仅对 commitment（承诺/愿景域）且当下分裂度高时，强提醒，带 cooldown。
 *
 * 河床铁律（与本目录其它模块一致）：
 *   - 判断永不驱动执行：本引擎只产出"该说什么"的意图，不调用任何工具、不触发动作。
 *   - 纯函数、确定性：同输入恒同输出（knock 限频用外部注入的时间 + 计数器，可测）。
 *   - 不 import sqlite / server-only / @/ 别名；相对导入带 `.js`。
 *   - 任何异常由调用方兜底；本模块不抛非 TypeError 的运行时异常。
 */

import { clamp01 } from "./riverbed-util.js";
import type { RiverbedNode } from "./riverbed-store.js";
import type { RiverbedDomainId } from "./riverbed-domain.js";

// ============================================================================
// 类型
// ============================================================================

/** 三级打断强度（沿用产品后端语义）。 */
export type InterruptLevel = "whisper" | "knock" | "intercept";

/**
 * 打断意图事件——引擎的唯一产物。承载"该用哪一级、说哪条过去判断、为什么"。
 * 不含任何可执行/引擎触发字段（贯彻判断不驱动执行）。
 */
export interface InterruptIntent {
  level: InterruptLevel;
  /** 命中的河床节点 id（= packet.packetId）。 */
  nodeId: string;
  /** 命中节点所属领域。 */
  domain: RiverbedDomainId;
  /** 要对用户说/在意识里提示的核心文本（来自节点 reason / suggestedNextStep）。 */
  messageText: string;
  /** 人可读的触发理由（便于留痕与调试）。 */
  reason: string;
  /** 与当下情境的相关度 ∈ [0,1]。 */
  relevance: number;
  /** 命中节点的打断权威分 ∈ [0,1]。 */
  authority: number;
  occurredAt: string;
}

/** 引擎依赖（全部注入，便于测试与解耦；无 DB）。 */
export interface InterruptEngineDeps {
  /** 当下情境文本（弟弟 perceive 产物 + 最近用户消息拼接）。 */
  presentContext: string;
  /** 当下"分裂度" ∈ [0,1]：当下越偏离/矛盾越高。缺省 0。 */
  splittingScore?: number;
  /** 活跃河床节点（调用方用 getActiveRiverbedNodes 传入）。 */
  candidates: readonly RiverbedNode[];
  /** 当前时间 ms（默认 Date.now()，注入便于测试）。 */
  nowMs?: number;
  /** knock 限频计数器（调用方持有并持久化于内存；引擎只读写其 hits 数组）。 */
  knockState?: KnockRateState;
}

/** knock 限频状态：最近命中的时间戳数组（ms epoch）。调用方持有，跨呼吸保留。 */
export interface KnockRateState {
  hits: number[];
}

// ============================================================================
// 配置阈值（沿用产品后端 spec 锁定值）
// ============================================================================

/** intercept 触发阈值（splitting）— 仅限 commitment 类域。 */
export const INTERCEPT_SPLITTING_THRESHOLD = 0.7;
/** knock 触发阈值（splitting）— lesson / contradiction / failure 类域。 */
export const KNOCK_SPLITTING_THRESHOLD = 0.5;
/** knock 频率上限：每小时 1 次（超出自动降级 whisper）。 */
export const KNOCK_RATE_LIMIT_PER_HOUR = 1;
/** intercept 触发后的 cooldown 秒数。 */
export const DEFAULT_INTERCEPT_COOLDOWN_SEC = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * 域 → 打断类目映射（接地：弟弟用 14 域，无产品后端的 PastNodeKind）。
 * - commitment 类：愿景/目标/决策——这些是"承诺与方向"，分裂度高时值得 intercept。
 * - knock 类：失败/行为/认知/情绪——值得敲门提醒但不强拦。
 * - 其余：只 whisper。
 */
const INTERCEPT_DOMAINS: ReadonlySet<string> = new Set([
  "D0_ASPIRATION",
  "D2_GOAL",
  "D3_DECISION",
]);
const KNOCK_DOMAINS: ReadonlySet<string> = new Set([
  "D6_FAILURE",
  "D4_BEHAVIOR",
  "D9_COGNITION",
  "D8_EMOTION",
]);

// ============================================================================
// 关键词重叠打分（O(N) 简易语义召回；与产品后端同口径，纯确定性）
// ============================================================================

const STOP_WORDS: ReadonlySet<string> = new Set([
  "你", "我", "他", "她", "的", "是", "了", "在", "和", "也", "都", "就", "不", "没", "要",
]);

function tokenize(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch) && !STOP_WORDS.has(ch)) out.push(ch);
  }
  const words = s.toLowerCase().match(/[a-z]+/g);
  if (words) {
    for (const w of words) {
      if (w.length >= 2 && !STOP_WORDS.has(w)) out.push(w);
    }
  }
  return out;
}

/** 简易 cosine（基于关键词集合，unit weight）。 */
function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersect = 0;
  for (const t of aSet) if (bSet.has(t)) intersect += 1;
  return intersect / Math.sqrt(aSet.size * bSet.size);
}

/** 节点的语义文本：领域判断的 reason + 下一步建议（弟弟 packet 字段）。 */
function nodeTokens(node: RiverbedNode): string[] {
  const parts = [
    node.packet.reason ?? "",
    node.packet.suggestedNextStep ?? "",
    (node.packet.suggestedCutList ?? []).join(" "),
  ].join(" ");
  return tokenize(parts);
}

// ============================================================================
// knock 限频
// ============================================================================

function withinHourKnockCount(state: KnockRateState | undefined, nowMs: number): number {
  if (!state || !Array.isArray(state.hits)) return 0;
  return state.hits.filter((t) => nowMs - t < HOUR_MS).length;
}

function recordKnock(state: KnockRateState, nowMs: number): void {
  state.hits = state.hits.filter((t) => nowMs - t < HOUR_MS);
  state.hits.push(nowMs);
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 评估当下是否该用某条过去河床判断打断/提醒，及用哪一级。
 *
 * 决策树（对齐产品后端）：
 *   1. 在活跃节点里按 `关键词重叠(当下情境, 节点) × interruptAuthority` 排序，取 top。
 *      authority ≤ 0 或重叠为 0 的节点不参与。
 *   2. 决定 level：
 *      - 域 ∈ commitment类 且 splitting ≥ 0.7 → intercept
 *      - 域 ∈ knock类 且 splitting ≥ 0.5     → knock
 *      - 否则                                  → whisper
 *   3. knock 限频：1 小时内已达上限 → 自动降级 whisper（记 reason）。
 *   4. 无任何匹配 → 返回 null（沉默是默认，不硬凑打断）。
 *
 * 纯确定性：同 (deps) 输入恒得同输出（时间由 nowMs 注入）。不修改 candidates。
 *
 * @returns 打断意图，或 null（本轮不打断）
 */
export function evaluateInterrupt(deps: InterruptEngineDeps): InterruptIntent | null {
  if (!deps || typeof deps.presentContext !== "string") {
    throw new TypeError("evaluateInterrupt: deps.presentContext required");
  }
  const nowMs = deps.nowMs ?? Date.now();
  const splitting = clamp01(deps.splittingScore ?? 0);
  const ctxToks = tokenize(deps.presentContext);
  if (ctxToks.length === 0) return null;

  // 1) 排序取 top（重叠 × 权威）。
  let best: { node: RiverbedNode; relevance: number; score: number } | null = null;
  for (const node of deps.candidates ?? []) {
    const auth = clamp01(node.interruptAuthority);
    if (auth <= 0) continue;
    const relevance = overlapScore(ctxToks, nodeTokens(node));
    if (relevance <= 0) continue;
    const score = relevance * auth;
    if (!best || score > best.score) best = { node, relevance, score };
  }
  if (!best) return null;

  const node = best.node;
  const domain = String(node.packet.domain);
  const occurredAt = new Date(nowMs).toISOString();

  // 2) 决定 level。
  let level: InterruptLevel;
  if (INTERCEPT_DOMAINS.has(domain) && splitting >= INTERCEPT_SPLITTING_THRESHOLD) {
    level = "intercept";
  } else if (KNOCK_DOMAINS.has(domain) && splitting >= KNOCK_SPLITTING_THRESHOLD) {
    level = "knock";
  } else {
    level = "whisper";
  }

  let rateLimited = false;
  // 3) knock 限频 → 降级 whisper。
  if (level === "knock") {
    const prior = withinHourKnockCount(deps.knockState, nowMs);
    if (prior >= KNOCK_RATE_LIMIT_PER_HOUR) {
      level = "whisper";
      rateLimited = true;
    } else if (deps.knockState) {
      recordKnock(deps.knockState, nowMs);
    }
  }

  const messageText =
    (node.packet.suggestedNextStep?.trim() || node.packet.reason?.trim() || "").slice(0, 200);
  const reason =
    `level=${level}; domain=${domain}; relevance=${best.relevance.toFixed(3)}; ` +
    `authority=${node.interruptAuthority.toFixed(3)}; splitting=${splitting.toFixed(3)}` +
    (rateLimited ? "; knock限频→降级whisper" : "");

  return {
    level,
    nodeId: node.nodeId,
    domain: node.packet.domain as RiverbedDomainId,
    messageText,
    reason,
    relevance: best.relevance,
    authority: clamp01(node.interruptAuthority),
    occurredAt,
  };
}
