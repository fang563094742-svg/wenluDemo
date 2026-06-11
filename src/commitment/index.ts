/**
 * 承诺兑现（Commitment Keeping）· 移植自产品后端 lib/wenlu/commitment-keeping
 * ------------------------------------------------------------------
 * 剥壳：去掉 server-only / sqlite / 哈希链 / PII redactor / audit 表依赖，
 * 接地到弟弟：承诺锚点就是 mind.commitments 数组（存 mind.json）。
 *
 * 第一性价值：把用户对话里"第一人称未来时承诺"识别成锚点 → 到期主动回访 →
 * 算兑现率。AI 永不替用户判定是否兑现（只问、只记，由用户回报）。
 *
 * 全局联动（非孤岛）：
 *   - 输入：onUserMessage 时对用户原话跑 detectCommitment。
 *   - 输出：到期锚点喂给打断引擎（commitment 域 → intercept 主动回访）+ 渲染进意识。
 *   - 闭环：用户回报 fulfilled/half/unfulfilled → 兑现率，喂回意识与引领读数。
 *
 * 纯函数 / 确定性（时间由 nowMs 注入）；不调 LLM、不碰 DB。
 */

export type CommitStrength = "loose" | "firm" | "inviolable";
export type FulfillmentStatus = "fulfilled" | "half" | "unfulfilled" | "expired_silent";

/** 承诺锚点（挂在 mind.commitments，存 mind.json）。 */
export interface CommitmentAnchor {
  anchorId: string;
  /** 承诺原文（弟弟单用户，不做 PII 脱敏）。 */
  commitText: string;
  createdAtMs: number;
  /** 到期回访时间点（绝对 ms）。 */
  horizonMs: number;
  strength: CommitStrength;
  sincerityScore: number;
  /** 是否已回访（避免重复打扰）。 */
  lookedBack: boolean;
  /** 用户回报的兑现结果（未回报为 null）。 */
  report: FulfillmentStatus | null;
  reportedAtMs?: number;
}

export interface CommitmentDetectorResult {
  matched: boolean;
  commitText?: string;
  horizonMs?: number;
  strength?: CommitStrength;
  sincerityScore?: number;
  reason?: "regex_match" | "none";
}

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

interface TimeAnchorRule {
  keyword: string;
  resolve(nowMs: number): number;
  specificity: number;
}

const TIME_ANCHORS: readonly TimeAnchorRule[] = [
  { keyword: "今晚", resolve: () => 8 * MS_HOUR, specificity: 1.0 },
  { keyword: "今天晚上", resolve: () => 8 * MS_HOUR, specificity: 1.0 },
  { keyword: "明天", resolve: () => 24 * MS_HOUR, specificity: 0.9 },
  { keyword: "后天", resolve: () => 48 * MS_HOUR, specificity: 0.85 },
  { keyword: "本周末", resolve: (now) => msToNextSaturday(now), specificity: 0.7 },
  { keyword: "周末", resolve: (now) => msToNextSaturday(now), specificity: 0.65 },
  { keyword: "下周", resolve: () => 7 * MS_DAY, specificity: 0.6 },
  { keyword: "这周", resolve: () => 5 * MS_DAY, specificity: 0.6 },
  { keyword: "月底", resolve: (now) => msToEndOfMonth(now), specificity: 0.5 },
  { keyword: "下个月", resolve: () => 30 * MS_DAY, specificity: 0.4 },
];

function msToNextSaturday(nowMs: number): number {
  const day = new Date(nowMs).getUTCDay();
  const delta = day === 6 ? 6 : 6 - day;
  return delta * MS_DAY;
}

function msToEndOfMonth(nowMs: number): number {
  const d = new Date(nowMs);
  const eom = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
  const delta = eom - nowMs;
  return delta > 0 ? delta : MS_DAY;
}

const FIRST_PERSON_FUTURE_RE =
  /(我|今晚|明天|后天|下周|这周|周末|本周末|月底|下个月).{0,15}?(会|要|准备|打算|想)/;

const INVIOLABLE_HEDGES = ["一定", "绝对", "必须"];
const INVIOLABLE_TOPICS = ["结婚", "离婚", "辞职", "搬家", "手术", "戒", "出国", "孩子", "父母"];

function inferStrength(text: string): CommitStrength {
  const hedgeHit = INVIOLABLE_HEDGES.some((h) => text.includes(h));
  const topicHit = INVIOLABLE_TOPICS.some((t) => text.includes(t));
  if (hedgeHit && topicHit) return "inviolable";
  if (/我会|我要|我准备/.test(text)) return "firm";
  return "loose";
}

function specificVerbScore(text: string): number {
  if (/(完成|提交|发|寄|交|做|写|跑|走|去|打电话|发消息|签|付)/.test(text)) return 1.0;
  if (/(看看|想想|考虑|聊聊|试试)/.test(text)) return 0.4;
  return 0.7;
}

function lengthScore(text: string): number {
  const len = text.length;
  if (len <= 8) return 0.3;
  if (len >= 80) return 1.0;
  return 0.3 + ((len - 8) / 72) * 0.7;
}

function timeAnchorSpecificity(keyword: string | null): number {
  if (!keyword) return 0.3;
  const rule = TIME_ANCHORS.find((t) => t.keyword === keyword);
  return rule ? rule.specificity : 0.3;
}

function sincerityScore(text: string, keyword: string | null): number {
  const raw = lengthScore(text) * specificVerbScore(text) * timeAnchorSpecificity(keyword);
  return Number(Math.min(1, Math.max(0, raw)).toFixed(4));
}

function findMatchedTimeAnchor(text: string): TimeAnchorRule | null {
  for (const rule of TIME_ANCHORS) if (text.includes(rule.keyword)) return rule;
  return null;
}

/**
 * 检测一句话里是否含"第一人称未来时承诺"。确定性纯函数（regex 单遍）。
 * @returns 命中则带 commitText/horizonMs/strength/sincerity；否则 matched:false。
 */
export function detectCommitment(text: string, nowMs: number): CommitmentDetectorResult {
  if (typeof text !== "string" || text.length === 0) return { matched: false, reason: "none" };
  if (!Number.isFinite(nowMs)) return { matched: false, reason: "none" };
  const firstPass = FIRST_PERSON_FUTURE_RE.test(text);
  const timeAnchor = findMatchedTimeAnchor(text);
  if (firstPass && timeAnchor) {
    return {
      matched: true,
      commitText: text,
      horizonMs: nowMs + timeAnchor.resolve(nowMs),
      strength: inferStrength(text),
      sincerityScore: sincerityScore(text, timeAnchor.keyword),
      reason: "regex_match",
    };
  }
  return { matched: false, reason: "none" };
}

/** 把检测结果转成可存储锚点（确定性，id 由 nowMs + 序号生成）。 */
export function toAnchor(r: CommitmentDetectorResult, nowMs: number, seq: number): CommitmentAnchor | null {
  if (!r.matched || !r.commitText || typeof r.horizonMs !== "number") return null;
  return {
    anchorId: `cmt_${nowMs}_${seq}`,
    commitText: r.commitText.slice(0, 300),
    createdAtMs: nowMs,
    horizonMs: r.horizonMs,
    strength: r.strength ?? "loose",
    sincerityScore: r.sincerityScore ?? 0.3,
    lookedBack: false,
    report: null,
  };
}

/** 取到期且未回访的锚点（horizon 已过、尚未 lookedBack、未回报）。 */
export function dueAnchors(anchors: readonly CommitmentAnchor[], nowMs: number): CommitmentAnchor[] {
  return anchors.filter((a) => !a.lookedBack && a.report === null && a.horizonMs <= nowMs);
}

export interface FulfillmentRate {
  total: number;
  fulfilled: number;
  half: number;
  unfulfilled: number;
  rate: number;
}

/** 兑现率 = (fulfilled + 0.5×half) / 已回报总数。中性数字，不掺励志。 */
export function computeFulfillmentRate(anchors: readonly CommitmentAnchor[]): FulfillmentRate {
  let fulfilled = 0, half = 0, unfulfilled = 0;
  for (const a of anchors) {
    if (a.report === "fulfilled") fulfilled += 1;
    else if (a.report === "half") half += 1;
    else if (a.report === "unfulfilled" || a.report === "expired_silent") unfulfilled += 1;
  }
  const total = fulfilled + half + unfulfilled;
  const rate = total === 0 ? 0 : Number(((fulfilled + 0.5 * half) / total).toFixed(4));
  return { total, fulfilled, half, unfulfilled, rate };
}
