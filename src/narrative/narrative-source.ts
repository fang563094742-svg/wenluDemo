/**
 * 叙事输出层 · 来源归集器（Component 1：narrative-source.ts）
 * ------------------------------------------------------------------
 * 把 mind 内**已成形**的可追溯来源（knowledge / 活跃 belief / 活跃 userModel /
 * 河床判断 / 时空签名）归集成一个扁平、便于匹配的 {@link NarrativeSourceIndex}。
 * 纯只读、确定性、降级安全——绝不修改入参 mind、绝不抛错阻断说话。
 *
 * 设计要点（参见 design.md Component 1 / 算法一 / Data Models 与
 * requirements.md Requirement 1 / 7 / 9）：
 *  - `truthTier` **仅由上游 source 字段确定性映射得到**（{@link mapTruthTier}），
 *    叙事层不重新判断真假（职责边界最高红线）。
 *  - 关键词抽取为纯函数：相同 `content` 恒得相同关键词集合
 *    （中文 2-gram + 英文/数字 token，归一小写、去停用词）。
 *  - `riverbed` / `chronotopic` 以 `unknown` 接入，用窄化安全读取器消费
 *    （结构不符即跳过该来源、按空集处理，绝不抛错、不依赖河床/时空内部类型）。
 *  - 只读：调用前后 mind 的深度快照不变（不写记忆、不调任何写路径）。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 MindReadLike 解耦）。
 *  - 零第三方运行时依赖（仅 node:crypto 用于稳定 id）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import { createHash } from "node:crypto";

/**
 * 叙事层读取 mind 所需字段的**最小只读接口**（解耦核心）。
 *
 * 完整 `Mind` 天然满足此结构子类型；叙事层不反向 import `riverMain.ts`，
 * 仅通过该最小接口只读消费 mind（沿用河床 `MindLike` 哲学）。
 *
 * 字段说明（参见 design.md Data Models）：
 *  - `beliefs`：判断，含 `source` / `confidence` / 可选 `correctedBy`（被推翻标记）。
 *  - `knowledge`：知识，含 `source`。
 *  - `userModel`：用户洞察，含可选 `supersededBy`（被取代标记）。
 *  - `riverbed` / `chronotopic`：以 `unknown` 接入，经窄化安全读取器消费
 *    （{@link safeReadRiverbedReasons} / {@link safeReadChronoSummaries}），
 *    不依赖河床 / 时空内部类型，结构不符即跳过。
 *  - `fallbackReplyPolicy.legacyPatterns`：既有「军法」禁用模式，供人格门复用。
 *  - `narrativeVoice`：叙事层可选轻量配置；此处以 `unknown` 接入以**避免与
 *    `narrative-config.ts` 形成循环依赖**（配置解析由 config 模块单独负责）。
 *
 * 所有可选字段缺省时按空处理，绝不抛错（降级安全）。
 */
export interface MindReadLike {
  beliefs: ReadonlyArray<{
    id: string;
    content: string;
    confidence: number;
    source: string;
    correctedBy?: string;
  }>;
  knowledge: ReadonlyArray<{ content: string; source: string }>;
  userModel: ReadonlyArray<{
    id: string;
    aspect: string;
    content: string;
    confidence: number;
    supersededBy?: string;
  }>;
  /** 河床判断（unknown，经窄化安全读取器消费，不依赖河床内部类型）。 */
  riverbed?: unknown;
  /** 时空签名（unknown，经窄化安全读取器消费，不依赖时空内部类型）。 */
  chronotopic?: unknown;
  /** 既有军法禁用模式数据源（供人格门复用，不另立标准）。 */
  fallbackReplyPolicy?: { legacyPatterns: string[] };
  /**
   * 叙事层可选配置；以 `unknown` 接入以避免与 narrative-config 循环依赖
   * （配置类型与解析逻辑由 narrative-config.ts 单独负责）。
   */
  narrativeVoice?: unknown;
}

/**
 * 真假分层标签（**直接映射上游 source，叙事层不重新判断**）：
 *  - `verified`   : web-verified / file-observed / observed / user-said / user-told
 *  - `inferred`   : inferred / inferred-unverified（未证实）
 *  - `contextual` : 河床 / 时空 上下文态势（非事实断言）
 */
export type NarrativeTruthTier = "verified" | "inferred" | "contextual";

/** 来源所属的认知层。 */
export type NarrativeSourceKind =
  | "knowledge"
  | "belief"
  | "userModel"
  | "riverbed"
  | "chronotopic";

/** 单条可追溯来源。 */
export interface NarrativeSource {
  /** 稳定 id（sha256 截断；同 kind+content 恒得同 id）。 */
  id: string;
  /** 来源层。 */
  kind: NarrativeSourceKind;
  /** 来源文本内容（用于关键词抽取与脚注标注）。 */
  content: string;
  /** 真假分层（仅由上游 source 字段映射，不重判）。 */
  truthTier: NarrativeTruthTier;
  /** 抽取出的确定性关键词集合（小写归一、去重、稳定顺序）。 */
  keywords: ReadonlyArray<string>;
}

/** 归集后的扁平来源集合（含来源项、关键词倒排、构建时刻）。 */
export interface NarrativeSourceIndex {
  /** 所有可作为「实质断言支撑」的来源项（已抽取关键词）。 */
  sources: NarrativeSource[];
  /** 全部来源的关键词 → 来源 id 倒排（确定性，供忠实门快速匹配）。 */
  keywordIndex: ReadonlyMap<string, string[]>;
  /** 构建时刻 ISO（仅留痕，不参与匹配）。 */
  builtAt: string;
}

/**
 * 上游 source 字段 → truthTier 的确定性映射表。
 * 命中 verified / inferred 集合按表映射；其余（含未知 source）保守落 `inferred`。
 */
const VERIFIED_SOURCES: ReadonlySet<string> = new Set([
  "web-verified",
  "file-observed",
  "observed",
  "user-said",
  "user-told",
]);

const INFERRED_SOURCES: ReadonlySet<string> = new Set([
  "inferred",
  "inferred-unverified",
]);

/**
 * 确定性映射上游 source 字段为 truthTier。**仅由上游 source 决定**，
 * 与来源的其它字段无关（职责边界红线：叙事层不重判真假）。
 *
 *  - knowledge / belief / userModel：按 source 字段查表（verified / inferred）。
 *  - riverbed / chronotopic：恒为 `contextual`（上下文态势，非事实断言）。
 *  - 未知 / 缺省 source：保守落 `inferred`（不冒充已证实）。
 *
 * @param kind 来源层。
 * @param source 上游 source 字段（riverbed/chronotopic 可不传）。
 * @returns 真假分层标签。
 */
export function mapTruthTier(
  kind: NarrativeSourceKind,
  source?: string,
): NarrativeTruthTier {
  if (kind === "riverbed" || kind === "chronotopic") {
    return "contextual";
  }
  if (source !== undefined) {
    if (VERIFIED_SOURCES.has(source)) return "verified";
    if (INFERRED_SOURCES.has(source)) return "inferred";
  }
  // 未知或缺省 source：保守落 inferred（不冒充 verified）。
  return "inferred";
}

/**
 * 确定性关键词停用词表（中英常见虚词/连词，归一小写后比对）。
 * 仅作降噪，缺漏不影响正确性（关键词集合仍确定）。
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // 中文常见虚词（2-gram 命中后整体过滤）
  "的话",
  "了的",
  "是的",
  "和的",
  // 英文/通用停用词
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "is",
  "are",
  "was",
  "were",
  "be",
  "and",
  "or",
  "but",
  "for",
  "with",
  "as",
  "by",
  "it",
  "this",
  "that",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
]);

/** 单个中文（含 CJK 扩展）字符判别。 */
function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) // 兼容表意
  );
}

/**
 * 确定性关键词抽取：中文 2-gram + 英文/数字 token。
 *
 * 算法（纯函数、相同 content 恒得相同集合）：
 *  1. 归一小写。
 *  2. 连续 CJK 字符段取相邻 2-gram（单字段仅 1 字时取该单字）。
 *  3. 连续 ASCII 字母/数字段取整 token（长度 ≥ 2）。
 *  4. 去停用词、去重，按字典序稳定排序。
 *
 * @param content 来源文本内容。
 * @returns 关键词数组（小写、去重、稳定顺序）。
 */
export function extractKeywords(content: string): string[] {
  const text = String(content ?? "").toLowerCase();
  const found = new Set<string>();

  // 中文 2-gram：扫描连续 CJK 段。
  const cjkChars: string[] = [];
  const flushCjk = (): void => {
    if (cjkChars.length === 1) {
      found.add(cjkChars[0]);
    } else {
      for (let i = 0; i + 1 < cjkChars.length; i += 1) {
        found.add(cjkChars[i] + cjkChars[i + 1]);
      }
    }
    cjkChars.length = 0;
  };

  // 英文/数字 token：连续 ASCII 字母数字。
  let asciiToken = "";
  const flushAscii = (): void => {
    if (asciiToken.length >= 2) found.add(asciiToken);
    asciiToken = "";
  };

  for (const ch of text) {
    if (isCjkChar(ch)) {
      flushAscii();
      cjkChars.push(ch);
      continue;
    }
    if (/[a-z0-9]/.test(ch)) {
      flushCjk();
      asciiToken += ch;
      continue;
    }
    // 其它字符：作为分隔符，冲刷两个缓冲区。
    flushCjk();
    flushAscii();
  }
  flushCjk();
  flushAscii();

  // 去停用词后稳定排序，保证确定性。
  return [...found].filter((kw) => !STOPWORDS.has(kw)).sort();
}

/**
 * 生成稳定来源 id：sha256(kind + "|" + content) 取前 16 位十六进制，加 kind 前缀。
 * 同 kind+content 恒得同 id（幂等、确定）。
 */
function makeSourceId(kind: NarrativeSourceKind, content: string): string {
  const digest = createHash("sha256")
    .update(`${kind}|${content}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
}

/** 构造一条来源（抽取关键词 + 生成稳定 id）。 */
function makeSource(
  kind: NarrativeSourceKind,
  content: string,
  truthTier: NarrativeTruthTier,
): NarrativeSource {
  return {
    id: makeSourceId(kind, content),
    kind,
    content,
    truthTier,
    keywords: extractKeywords(content),
  };
}

/** 安全取对象自有属性（窄化读取器内部用）。 */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

/** 非空字符串判别 + trim。 */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 窄化安全读取河床节点理由（`mind.riverbed.nodes[].packet.reason`）。
 * 任何结构不符（缺字段、类型不对、非数组）即跳过、按空集处理，绝不抛错。
 * 不依赖河床内部类型，仅做防御式属性探测。
 *
 * @param riverbed `mind.riverbed`（unknown）。
 * @returns 河床理由文本数组（已 trim、去空）。
 */
export function safeReadRiverbedReasons(riverbed: unknown): string[] {
  const reasons: string[] = [];
  try {
    const state = readRecord(riverbed);
    if (!state) return reasons;
    const nodes = state.nodes;
    if (!Array.isArray(nodes)) return reasons;
    for (const node of nodes) {
      const nodeRec = readRecord(node);
      if (!nodeRec) continue;
      const packet = readRecord(nodeRec.packet);
      if (!packet) continue;
      const reason = asNonEmptyString(packet.reason);
      if (reason) reasons.push(reason);
    }
  } catch {
    return [];
  }
  return reasons;
}

/**
 * 窄化安全读取时空签名摘要（`mind.chronotopic.signatures[]`）。
 * 取签名的稳定可读字段（scene / frontAppName / targetRef.id）拼成摘要文本。
 * 任何结构不符即跳过、按空集处理，绝不抛错；不依赖时空内部类型。
 *
 * @param chronotopic `mind.chronotopic`（unknown）。
 * @returns 时空签名摘要文本数组（已去空）。
 */
export function safeReadChronoSummaries(chronotopic: unknown): string[] {
  const summaries: string[] = [];
  try {
    const state = readRecord(chronotopic);
    if (!state) return summaries;
    const signatures = state.signatures;
    if (!Array.isArray(signatures)) return summaries;
    for (const sig of signatures) {
      const sigRec = readRecord(sig);
      if (!sigRec) continue;
      const segments: string[] = [];
      const scene = asNonEmptyString(sigRec.scene);
      if (scene) segments.push(scene);
      const frontApp = asNonEmptyString(sigRec.frontAppName);
      if (frontApp) segments.push(frontApp);
      const targetRef = readRecord(sigRec.targetRef);
      if (targetRef) {
        const targetId = asNonEmptyString(targetRef.id);
        if (targetId) segments.push(targetId);
      }
      if (segments.length > 0) summaries.push(segments.join("·"));
    }
  } catch {
    return [];
  }
  return summaries;
}

/**
 * 归集 mind 内可追溯来源为 {@link NarrativeSourceIndex}（确定性纯函数、只读不改 mind）。
 *
 * 归集顺序（算法一）：
 *  1. knowledge（带 source → truthTier 映射）。
 *  2. 活跃 beliefs（`correctedBy` 未设；被推翻的不转述）。
 *  3. 活跃 userModel（`supersededBy` 未设；恒 verified）。
 *  4. riverbed 节点理由（窄化读取，contextual）。
 *  5. chronotopic 签名摘要（窄化读取，contextual）。
 *  6. 构建关键词 → 来源 id 倒排（确定性）。
 *
 * 降级安全：缺省字段按空集处理；riverbed/chronotopic 结构不符即跳过、不抛错。
 *
 * @param mind 只读 mind（MindReadLike 子类型即可）。
 * @param nowMs 当前时间戳（毫秒），仅用于 `builtAt` 留痕。
 * @returns 归集后的来源索引。
 */
export function buildSourceIndex(
  mind: MindReadLike,
  nowMs: number,
): NarrativeSourceIndex {
  const sources: NarrativeSource[] = [];

  // 1. knowledge（带 source）。
  const knowledge = Array.isArray(mind.knowledge) ? mind.knowledge : [];
  for (const k of knowledge) {
    const content = asNonEmptyString(k?.content);
    if (!content) continue;
    sources.push(makeSource("knowledge", content, mapTruthTier("knowledge", k.source)));
  }

  // 2. 活跃 beliefs（correctedBy 未设）。
  const beliefs = Array.isArray(mind.beliefs) ? mind.beliefs : [];
  for (const b of beliefs) {
    if (b?.correctedBy !== undefined && b.correctedBy !== null) continue;
    const content = asNonEmptyString(b?.content);
    if (!content) continue;
    sources.push(makeSource("belief", content, mapTruthTier("belief", b.source)));
  }

  // 3. 活跃 userModel（supersededBy 未设）。
  const userModel = Array.isArray(mind.userModel) ? mind.userModel : [];
  for (const u of userModel) {
    if (u?.supersededBy !== undefined && u.supersededBy !== null) continue;
    const content = asNonEmptyString(u?.content);
    if (!content) continue;
    sources.push(makeSource("userModel", content, mapTruthTier("userModel", "user-told")));
  }

  // 4. riverbed 节点理由（窄化安全读取，contextual）。
  for (const reason of safeReadRiverbedReasons(mind.riverbed)) {
    sources.push(makeSource("riverbed", reason, "contextual"));
  }

  // 5. chronotopic 签名摘要（窄化安全读取，contextual）。
  for (const summary of safeReadChronoSummaries(mind.chronotopic)) {
    sources.push(makeSource("chronotopic", summary, "contextual"));
  }

  // 6. 关键词 → 来源 id 倒排（确定性；与 sources 关键词集合一致）。
  const keywordIndex = new Map<string, string[]>();
  for (const s of sources) {
    for (const kw of s.keywords) {
      const bucket = keywordIndex.get(kw);
      if (bucket) {
        if (!bucket.includes(s.id)) bucket.push(s.id);
      } else {
        keywordIndex.set(kw, [s.id]);
      }
    }
  }

  return {
    sources,
    keywordIndex,
    builtAt: new Date(nowMs).toISOString(),
  };
}
