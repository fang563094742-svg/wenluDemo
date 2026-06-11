/**
 * 叙事输出层 · 忠实性门（Component 2：narrative-faithfulness.ts）
 * ------------------------------------------------------------------
 * 确定性近似校验「拟输出文本的每个实质断言是否都有 mind 内来源支撑」。
 * 基于**断言抽取 + 来源关键词重叠度（Jaccard 近似）评分**，纯函数、可 fast-check。
 *
 * 设计要点（参见 design.md Component 2 / 算法二 与 requirements.md Requirement 2）：
 *  - `extractAssertions`：确定性切句（按中英文标点 。！？.!?；; 与换行切分）+
 *    实质性标注（疑问 / 寒暄 / 元话语 `substantive=false`），记录每段在原文的 `offset`。
 *  - `supportScore`：用 span 关键词与来源关键词重叠的 Jaccard 近似 ∈ [0,1]
 *    （复用 narrative-source 的 {@link extractKeywords} 抽取 span 关键词，再借助
 *    `index.keywordIndex` / `index.sources` 计算重叠）。**取 span 对所有来源的最大
 *    重叠**——保证对来源集合单调不减（加来源只会让最大值不减，对应 Property 5）。
 *  - `scoreFaithfulness`：无实质断言 → `score=1, unsupported=[]`；否则按权重
 *    `1 + cfg.lateBoost × offsetRatio`（offsetRatio = span.offset / max(1,文本长度)）
 *    后段加重，支撑度 ≥ `cfg.supportThreshold` 计入支撑、否则记 `unsupported`；
 *    `score = supportedWeight / totalWeight ∈ [0,1]`；纯函数、确定。
 *
 * Postconditions（算法二）：
 *  - `score ∈ [0,1]`；无实质断言 → `score = 1`；`unsupported ⊆ 实质断言集`；纯确定。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 MindReadLike / NarrativeSourceIndex 解耦）。
 *  - 零第三方运行时依赖；确定性纯函数、无副作用。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import type { NarrativeVoiceConfig } from "./narrative-config.js";
import {
  extractKeywords,
  type NarrativeSource,
  type NarrativeSourceIndex,
} from "./narrative-source.js";

/** 切句后的单个断言片段。 */
export interface AssertionSpan {
  /** 断言原文片段（按句 / 子句切分，已去除首尾空白）。 */
  text: string;
  /** 在原文中的起始字符偏移（用于「后段加重」定位）。 */
  offset: number;
  /** 是否实质断言（陈述事实 / 判断）；疑问 / 寒暄 / 元话语不计。 */
  substantive: boolean;
}

/** 忠实性评分报告。 */
export interface FaithfulnessReport {
  /** 整体忠实度 ∈ [0,1]：受支撑实质断言的加权占比。 */
  score: number;
  /** 实质断言总数。 */
  assertionCount: number;
  /** 未获 mind 来源支撑的实质断言（按需标记 / 回退）。 */
  unsupported: AssertionSpan[];
  /** 命中的来源 id（可追溯渲染用，去重、稳定顺序）。 */
  matchedSourceIds: string[];
}

/** 切句分隔符：中英文句末标点、分号、换行。 */
const DELIMITERS: ReadonlySet<string> = new Set([
  "。",
  "！",
  "？",
  ".",
  "!",
  "?",
  "；",
  ";",
  "\n",
  "\r",
]);

/** 终止于问号视为疑问句的分隔符。 */
const QUESTION_DELIMITERS: ReadonlySet<string> = new Set(["？", "?"]);

/**
 * 寒暄 / 元话语词表（小写归一后整体比对）。命中（整段等于或以其开头且较短）
 * 则标 `substantive=false`，不计入忠实度评分。
 */
const PLEASANTRY_TERMS: ReadonlyArray<string> = [
  "你好",
  "您好",
  "大家好",
  "谢谢",
  "多谢",
  "感谢",
  "不客气",
  "没关系",
  "再见",
  "拜拜",
  "嗨",
  "哈喽",
  "你好呀",
  "早上好",
  "晚上好",
  "午安",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank you",
  "bye",
  "goodbye",
];

/** 元话语 / 语气填充词（整段等于这些短词时标非实质）。 */
const META_TERMS: ReadonlyArray<string> = [
  "嗯",
  "哦",
  "啊",
  "唉",
  "呃",
  "好的",
  "好吧",
  "行",
  "嗯嗯",
  "这样啊",
  "原来如此",
  "ok",
  "okay",
  "well",
  "um",
  "uh",
];

/** 句中疑问语气助词（出现即倾向判为疑问）。 */
const QUESTION_PARTICLES: ReadonlyArray<string> = ["吗", "呢", "吧"];

/**
 * 判定一个（已 trim、已小写归一）片段是否为非实质（疑问 / 寒暄 / 元话语）。
 *
 * @param normalized 归一后的片段文本（小写、trim）。
 * @param closedByQuestion 该片段是否由问号收尾。
 * @returns true 表示非实质（不计入忠实度）。
 */
function isNonSubstantive(
  normalized: string,
  closedByQuestion: boolean,
): boolean {
  if (normalized.length === 0) return true;
  if (closedByQuestion) return true;

  // 元话语：整段等于某个填充词。
  for (const term of META_TERMS) {
    if (normalized === term) return true;
  }

  // 寒暄：整段等于或以寒暄词开头且整体很短（≤ 该词 + 2 字）。
  for (const term of PLEASANTRY_TERMS) {
    if (normalized === term) return true;
    if (normalized.startsWith(term) && normalized.length <= term.length + 2) {
      return true;
    }
  }

  // 句中疑问助词：靠近结尾出现（最后 2 字内）倾向判为疑问。
  const tail = normalized.slice(-2);
  for (const particle of QUESTION_PARTICLES) {
    if (tail.includes(particle)) return true;
  }

  return false;
}

/**
 * 确定性切句 + 实质性标注。
 *
 * 算法（纯函数、相同 text 恒得相同结果）：
 *  1. 逐字符扫描，遇分隔符（。！？.!?；; 换行）即收束当前片段。
 *  2. 记录每段去首尾空白后的 `text` 与其在原文中的起始 `offset`。
 *  3. 由问号收尾、寒暄、元话语、句末疑问助词 → `substantive=false`，其余为实质断言。
 *  4. 去首尾空白后为空的片段直接丢弃（不产出 span）。
 *
 * @param text 拟输出文本。
 * @returns 断言片段数组（含 offset 与实质性标注）。
 */
export function extractAssertions(text: string): AssertionSpan[] {
  const raw = String(text ?? "");
  const spans: AssertionSpan[] = [];

  let buf = "";
  let segStart = -1;

  const flush = (closedByQuestion: boolean): void => {
    if (segStart < 0) {
      buf = "";
      return;
    }
    // 计算 trim 后的内容与其在原文中的偏移。
    const leadingWs = buf.length - buf.trimStart().length;
    const trimmed = buf.trim();
    if (trimmed.length > 0) {
      const offset = segStart + leadingWs;
      const normalized = trimmed.toLowerCase();
      spans.push({
        text: trimmed,
        offset,
        substantive: !isNonSubstantive(normalized, closedByQuestion),
      });
    }
    buf = "";
    segStart = -1;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (DELIMITERS.has(ch)) {
      flush(QUESTION_DELIMITERS.has(ch));
      continue;
    }
    if (segStart < 0) segStart = i;
    buf += ch;
  }
  // 收尾：末段无分隔符。
  flush(false);

  return spans;
}

/** 计算两个关键词集合的 Jaccard 系数 ∈ [0,1]。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlyArray<string>): number {
  if (a.size === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let intersection = 0;
  for (const kw of a) {
    if (bSet.has(kw)) intersection += 1;
  }
  if (intersection === 0) return 0;
  const union = a.size + bSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

/**
 * 计算单断言对来源索引的支撑度及命中来源 id（内部辅助）。
 *
 * **取 span 对所有来源的最大 Jaccard 重叠**——这是 Property 5（来源单调性）的关键：
 * 加来源只会让候选集合扩大，最大值只增不减。命中来源 id 取达到该最大值的来源
 * （`jaccard === best 且 best > 0`），确定性、稳定顺序。
 *
 * 借助 `index.keywordIndex` 收集候选来源（仅与 span 关键词有交集的来源才可能非零），
 * 与遍历全部来源取最大值等价，但更省。
 *
 * @param span 断言片段。
 * @param index 来源索引。
 * @returns `{ score, matchedIds }`，score ∈ [0,1]。
 */
function computeSupport(
  span: AssertionSpan,
  index: NarrativeSourceIndex,
): { score: number; matchedIds: string[] } {
  const spanKeywords = new Set(extractKeywords(span.text));
  if (spanKeywords.size === 0) return { score: 0, matchedIds: [] };

  const sources: ReadonlyArray<NarrativeSource> = Array.isArray(index?.sources)
    ? index.sources
    : [];
  if (sources.length === 0) return { score: 0, matchedIds: [] };

  // 借助倒排收集候选来源 id（仅与 span 关键词有交集者才可能非零）。
  const keywordIndex = index?.keywordIndex;
  const candidateIds = new Set<string>();
  if (keywordIndex && typeof keywordIndex.get === "function") {
    for (const kw of spanKeywords) {
      const bucket = keywordIndex.get(kw);
      if (bucket) {
        for (const id of bucket) candidateIds.add(id);
      }
    }
  }

  // 候选来源（无倒排命中则退化为遍历全部来源，结果等价：最大值仍正确）。
  const candidates: ReadonlyArray<NarrativeSource> =
    candidateIds.size > 0
      ? sources.filter((s) => candidateIds.has(s.id))
      : sources;

  let best = 0;
  for (const source of candidates) {
    const sup = jaccard(spanKeywords, source.keywords);
    if (sup > best) best = sup;
  }

  if (best <= 0) return { score: 0, matchedIds: [] };

  // 命中来源：达到最大重叠者（稳定顺序，去重）。
  const matchedIds: string[] = [];
  const seen = new Set<string>();
  for (const source of candidates) {
    if (jaccard(spanKeywords, source.keywords) === best && !seen.has(source.id)) {
      seen.add(source.id);
      matchedIds.push(source.id);
    }
  }

  return { score: best, matchedIds };
}

/**
 * 单断言对来源的支撑度 ∈ [0,1]（关键词重叠 Jaccard 近似）。
 *
 * 取 span 对索引中所有来源的最大重叠——对来源集合单调不减（Property 5）。
 *
 * @param span 断言片段。
 * @param index 来源索引。
 * @returns 支撑度 ∈ [0,1]。
 */
export function supportScore(
  span: AssertionSpan,
  index: NarrativeSourceIndex,
): number {
  return computeSupport(span, index).score;
}

/**
 * 忠实性评分（后段断言权重更高，吸收 arXiv 2505.15291）。
 *
 * 算法二（纯函数、确定）：
 *  - 切句 → 取实质断言；若无实质断言 → `score=1, unsupported=[]`。
 *  - 逐断言：`offsetRatio = span.offset / max(1, text长度)`；
 *    `weight = 1 + cfg.lateBoost × offsetRatio`（后段加重）。
 *  - `supportScore(span, index) ≥ cfg.supportThreshold` ⟹ 计入 supportedWeight 并记命中来源；
 *    否则记入 `unsupported`。
 *  - `score = supportedWeight / totalWeight ∈ [0,1]`。
 *
 * @param text 拟输出文本。
 * @param index 来源索引（由 buildSourceIndex 产出）。
 * @param cfg 叙事层配置（`lateBoost ≥ 0`，`supportThreshold ∈ [0,1]`）。
 * @returns 忠实性报告。
 */
export function scoreFaithfulness(
  text: string,
  index: NarrativeSourceIndex,
  cfg: NarrativeVoiceConfig,
): FaithfulnessReport {
  const raw = String(text ?? "");
  const spans = extractAssertions(raw);
  const substantive = spans.filter((s) => s.substantive);

  // 无实质断言（纯寒暄 / 提问）→ 视为完全忠实（无可幻觉内容）。
  if (substantive.length === 0) {
    return { score: 1, assertionCount: 0, unsupported: [], matchedSourceIds: [] };
  }

  // lateBoost 防御性下限钳制（合法配置 ≥ 0；非法负值按 0 处理，保持确定）。
  const lateBoost = Number.isFinite(cfg?.lateBoost) ? Math.max(0, cfg.lateBoost) : 0;
  const supportThreshold = Number.isFinite(cfg?.supportThreshold)
    ? cfg.supportThreshold
    : 0;
  const textLen = Math.max(1, raw.length);

  let totalWeight = 0;
  let supportedWeight = 0;
  const unsupported: AssertionSpan[] = [];
  const matched = new Set<string>();

  for (const span of substantive) {
    const clampedOffset = Math.min(Math.max(0, span.offset), textLen);
    const offsetRatio = clampedOffset / textLen;
    const weight = 1 + lateBoost * offsetRatio;
    const { score: sup, matchedIds } = computeSupport(span, index);

    totalWeight += weight;
    // 零重叠（sup=0）的断言恒视为不被支撑——即便 supportThreshold=0（合法值）也不计入，
    // 以满足「空来源 ⟹ score=0」（Requirement 2.4 / Property 4）。
    if (sup > 0 && sup >= supportThreshold) {
      supportedWeight += weight;
      for (const id of matchedIds) matched.add(id);
    } else {
      unsupported.push(span);
    }
  }

  // totalWeight 恒 > 0（实质断言非空且 weight ≥ 1），无除零风险。
  const score = totalWeight > 0 ? supportedWeight / totalWeight : 1;

  return {
    score,
    assertionCount: substantive.length,
    unsupported,
    matchedSourceIds: [...matched],
  };
}
