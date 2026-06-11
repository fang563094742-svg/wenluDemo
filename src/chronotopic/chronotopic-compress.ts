/**
 * 时空校准层 · Hindsight 式分层压缩模块（V3：chronotopic-compress.ts）
 * ------------------------------------------------------------------
 * 提供**三层确定性压缩**视图：`raw_fact → observation → mental_model`，与河床
 * 节点 / 海马体记忆协同。压缩**只读**既有数据生成更高层摘要索引，不删除原始层
 * （与弟弟"只增不删、留痕"的一致原则）。
 *
 * 设计要点（参见 design.md §11.2 与 requirements.md R10）：
 *  - `liftTier` 为确定性纯函数：相同输入必得相同输出，不读时钟、不读随机、不调 LLM。
 *  - 仅做结构化聚合：按当前层级分组 → 去重合并 sourceIds → 拼接 content 摘要 →
 *    选取来源中"最近一次"的 signatureId 作为聚合签名。
 *  - sourceIds 守恒（Property 16）：输出所有 sourceIds 并集 === 输入所有 sourceIds
 *    并集（无遗漏、无凭空新增、去重）。
 *  - 层级恰提升一档：raw_fact→observation、observation→mental_model；mental_model
 *    为吸收态（→mental_model）。
 *  - LLM 提炼仍交给海马体既有 consolidation.distillConcepts（本函数不与之争）。
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 10.1, 10.2, 10.3, 10.4_
 */

/** 压缩层级（Hindsight 三层，确定性映射）。 */
export type CompressionTier = "raw_fact" | "observation" | "mental_model";

/** 一条分层压缩条目（外挂视图，不替代原始记忆）。 */
export interface CompressedEntry {
  /** 当前压缩层级。 */
  tier: CompressionTier;
  /** 条目内容（上层为该组的结构化摘要拼接）。 */
  content: string;
  /** 来源条目 id（可追溯到 raw 层）。 */
  sourceIds: string[];
  /** 该层条目的聚合时空签名（最近一次的签名，便于时间衰减）；无来源签名时为 null。 */
  signatureId: string | null;
}

/**
 * 层级提升映射（确定性，提升一档；mental_model 为吸收态）。
 *  - raw_fact      → observation
 *  - observation   → mental_model
 *  - mental_model  → mental_model（吸收态）
 */
const TIER_LIFT: Record<CompressionTier, CompressionTier> = {
  raw_fact: "observation",
  observation: "mental_model",
  mental_model: "mental_model",
};

/** 层级在输出中的稳定排序秩（保证输出顺序确定性）。 */
const TIER_RANK: Record<CompressionTier, number> = {
  raw_fact: 0,
  observation: 1,
  mental_model: 2,
};

/** 上层摘要拼接时各源 content 之间的分隔符。 */
const CONTENT_JOINER = " ⋄ ";

/**
 * 把当前层级确定性地提升一档。
 *
 * @param tier 当前压缩层级
 * @returns 提升一档后的层级（mental_model 为吸收态）
 */
export function nextTier(tier: CompressionTier): CompressionTier {
  return TIER_LIFT[tier];
}

/**
 * 把一组分层压缩条目确定性地归并为上一层（raw→observation→mental_model）。
 *
 * 聚合策略（确定性、可复现、无副作用）：
 *  1. 按**当前层级**分组（同 tier 的条目一起提升）。分组遵循输入中各层级的首次
 *     出现顺序，但输出最终按 {@link TIER_RANK} 稳定排序，确保与输入排列无关的确定性。
 *  2. 每组聚合成一条上层条目：
 *     - `tier`        = 该组当前层级提升一档（{@link nextTier}）。
 *     - `sourceIds`   = 该组所有 sourceIds 的去重并集（保留首次出现顺序）。
 *     - `content`     = 该组各条目 content 的去重结构化拼接（保留首次出现顺序）。
 *     - `signatureId` = 该组中"最近一次"的非空 signatureId；以输入顺序中**最后一个**
 *                       非空 signatureId 视为最近（无来源签名时为 null）。
 *
 * 关键不变量（Property 16）：输出所有条目的 sourceIds 并集 === 输入所有条目的
 * sourceIds 并集（无遗漏、无凭空新增、去重）。空输入产出空输出。
 *
 * 不修改入参、无副作用、不调 LLM、不删除原始层数据。
 *
 * @param entries 待提升的分层压缩条目集合
 * @returns 提升一档后的聚合条目集合（按层级秩稳定排序）
 */
export function liftTier(entries: CompressedEntry[]): CompressedEntry[] {
  // 按当前层级分组，保留各层级的首次出现顺序作为初始排列。
  const groups = new Map<CompressionTier, CompressedEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.tier);
    if (bucket === undefined) {
      groups.set(entry.tier, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  const lifted: CompressedEntry[] = [];
  for (const [tier, members] of groups) {
    // sourceIds：去重并集，保留首次出现顺序。
    const sourceIds = dedupePreservingOrder(members.flatMap((m) => m.sourceIds));

    // content：去重结构化拼接，保留首次出现顺序（忽略空白片段）。
    const contents = dedupePreservingOrder(
      members.map((m) => m.content).filter((c) => c.trim() !== ""),
    );

    // signatureId：以输入顺序中最后一个非空签名视为"最近"。
    let signatureId: string | null = null;
    for (const member of members) {
      if (member.signatureId !== null) {
        signatureId = member.signatureId;
      }
    }

    lifted.push({
      tier: nextTier(tier),
      content: contents.join(CONTENT_JOINER),
      sourceIds,
      signatureId,
    });
  }

  // 输出按层级秩稳定排序，保证与输入排列无关的确定性。
  lifted.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  return lifted;
}

/**
 * 去重并保留首次出现顺序（确定性）。
 *
 * @param values 原始字符串序列
 * @returns 去重后的序列（首次出现顺序）
 */
function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
