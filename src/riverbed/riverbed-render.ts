/**
 * 河床系统（Riverbed System）· 渲染进意识（Riverbed Renderer）
 * ------------------------------------------------------------------
 * 把活跃河床节点 + 聚合态势渲染成 `buildConsciousness` 能注入 system prompt 的
 * 中文纯文本块。这是河床"喂回决策"的读路径终点（design.md Component 7 / 流程一）。
 *
 * 渲染只输出对 LLM 规划有用的安全字段：domain / verdict / severity / reason /
 * suggestedCutList / suggestedNextStep。它**天然不含**任何可被解析为 shell 或
 * 引擎触发的字段名（`enginePacket` / `executionAllowed` / `selectedEngine`），
 * 因为这些字段从不出现在判断包的可读输出里（Requirement 8.4 / Property 12）。
 *
 * 职责（design.md Component 7 + Requirement 8）：
 *   - 8.1 标注 14 域结构化判断、否决级别（verdict）、严重度、suggestedCutList。
 *   - 8.2 空节点集合返回固定占位串"（河床尚在形成）"。
 *   - 8.3 输出长度有上限（maxChars，默认 1500），超长截断；maxChars=0 返回空串。
 *   - 8.5 按 `severity × interruptAuthority × confidence` 降序取前 N 个高价值节点。
 *   - 8.6 占位文本生成失败时返回空字符串而不崩溃（try/catch 兜底）。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。确定性纯函数，无副作用。
 *
 * _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
 */

import { clamp01 } from "./riverbed-util.js";
import { getRiverbedDomainEntry } from "./riverbed-domain.js";
import type { RiverbedDomainId } from "./riverbed-domain.js";
import type {
  DomainJudgementSeverity,
} from "./domain-judgement-packet.js";
import type { DomainJudgementAggregation } from "./domain-aggregation.js";
import type { RiverbedNode } from "./riverbed-store.js";

/** 空河床的固定中文占位串（Requirement 8.2）。 */
const EMPTY_PLACEHOLDER = "（河床尚在形成）";

/** 渲染输出的默认字符上限（防 token 膨胀，Requirement 8.3）。 */
const DEFAULT_MAX_CHARS = 1500;

/** 渲染前默认取前 N 个高价值节点（Requirement 8.5）。 */
const DEFAULT_TOP_N = 12;

/** 超长截断时追加的省略标记。 */
const TRUNCATION_MARK = "…（已截断）";

/** 河床块标题。 */
const BLOCK_HEADER = "== 你对用户的河床判断（14域结构化） ==";

/**
 * 严重度排名（none < low < medium < high < critical，数值越大越严重）。
 * 用于 `severity × interruptAuthority × confidence` 排序的数值化（Requirement 8.5）。
 */
const SEVERITY_RANK: Record<DomainJudgementSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * 节点高价值排序分（severity × interruptAuthority × confidence）。
 * severity 用 rank 数值化参与排序；与 store 的 active 排序口径一致。
 * 确定性函数，供降序排列取前 N。
 */
function renderValueScore(node: RiverbedNode): number {
  return (
    SEVERITY_RANK[node.packet.severity] *
    clamp01(node.interruptAuthority) *
    clamp01(node.packet.confidence)
  );
}

/**
 * 取领域的中文 label（用于人类/LLM 可读标注）。
 * 未知领域回退为 domain id 本身，保证不崩溃。
 */
function domainLabel(domain: RiverbedDomainId): string {
  const entry = getRiverbedDomainEntry(domain);
  return entry ? `${domain}·${entry.label}` : domain;
}

/**
 * 渲染单条节点为一行中文文本。
 * 形如：`[D8_EMOTION·情绪|warn|high] 理由... | 建议砍：xxx；yyy`
 * 只输出 domain / verdict / severity / reason / suggestedCutList / suggestedNextStep
 * 等安全字段，天然不含引擎触发字段名（Requirement 8.1 / 8.4）。
 */
function renderNodeLine(node: RiverbedNode): string {
  const { packet } = node;
  const head = `[${domainLabel(packet.domain)}|${packet.verdict}|${packet.severity}]`;

  const segments: string[] = [head];

  const reason = packet.reason?.trim();
  if (reason) segments.push(reason);

  const nextStep = packet.suggestedNextStep?.trim();
  if (nextStep) segments.push(`建议：${nextStep}`);

  const cutList = (packet.suggestedCutList ?? [])
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  if (cutList.length > 0) segments.push(`建议砍：${cutList.join("；")}`);

  return segments.join(" | ");
}

/**
 * 渲染聚合态势摘要行（开头摘要）。
 * 输出 summary、最高严重度、被阻断领域等安全字段。
 */
function renderAggregationLine(agg: DomainJudgementAggregation): string {
  const parts: string[] = [];

  if (agg.summary?.trim()) parts.push(agg.summary.trim());
  if (agg.highestSeverity) parts.push(`最高严重度：${agg.highestSeverity}`);
  if (agg.blockedDomains.length > 0) {
    parts.push(`被阻断领域：${agg.blockedDomains.map(domainLabel).join("、")}`);
  }
  if (agg.recoveryRequired) parts.push("（存在需恢复的判断）");

  return parts.join("　");
}

/**
 * 把活跃节点 + 聚合态势渲染成中文纯文本块（喂进 `buildConsciousness`）。
 *
 * 算法（design.md Component 7 + Requirement 8）：
 *   1. maxChars ≤ 0 → 返回空串（Requirement 8.3 边界）。
 *   2. 空节点集合 → 返回固定占位串"（河床尚在形成）"（Requirement 8.2）。
 *   3. 按 `severity × interruptAuthority × confidence` 降序取前 N（Requirement 8.5）。
 *      入参 nodes 通常已由 `getActiveRiverbedNodes` 过滤排序；此处再排一次保证口径，
 *      且 slice() 拷贝后排序，绝不修改入参（无副作用）。
 *   4. 拼接：标题 + 聚合摘要行 + 每节点一行（标注域/否决级别/严重度/建议砍）。
 *   5. 超长按 maxChars 截断并追加省略标记（Requirement 8.3）。
 *   6. 全程 try/catch 兜底：任何异常返回空串而不崩溃（Requirement 8.6）。
 *
 * 渲染只输出 domain/verdict/severity/reason/suggestedCutList/suggestedNextStep
 * 等安全字段，天然不含 `enginePacket`/`executionAllowed`/`selectedEngine`
 * （Requirement 8.4 / Property 12）。
 *
 * @param nodes 活跃河床节点（通常已过滤排序，本函数会再排一次保证口径）
 * @param agg 聚合态势（开头摘要来源）
 * @param maxChars 输出字符上限，默认 1500；为 0 时返回空串
 * @returns 中文纯文本块；空集合返回占位串；异常或上限为 0 返回空串
 */
export function renderRiverbedBlock(
  nodes: readonly RiverbedNode[],
  agg: DomainJudgementAggregation,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  try {
    // Requirement 8.3 边界：上限为 0（或负）→ 空输出。
    if (!Number.isFinite(maxChars) || maxChars <= 0) return "";

    // Requirement 8.2：空节点集合 → 固定占位串（占位串本身亦受上限约束）。
    if (!nodes || nodes.length === 0) {
      return EMPTY_PLACEHOLDER.length <= maxChars
        ? EMPTY_PLACEHOLDER
        : EMPTY_PLACEHOLDER.slice(0, maxChars);
    }

    // Requirement 8.5：按高价值降序取前 N（slice 拷贝，绝不修改入参）。
    const top = nodes
      .slice()
      .sort((a, b) => renderValueScore(b) - renderValueScore(a))
      .slice(0, DEFAULT_TOP_N);

    const lines: string[] = [BLOCK_HEADER];

    const aggLine = renderAggregationLine(agg);
    if (aggLine) lines.push(aggLine);

    for (const node of top) {
      lines.push(renderNodeLine(node));
    }

    const block = lines.join("\n");

    // Requirement 8.3：超长截断，追加省略标记（标记本身也纳入上限）。
    if (block.length <= maxChars) return block;

    if (maxChars <= TRUNCATION_MARK.length) return block.slice(0, maxChars);
    return block.slice(0, maxChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
  } catch {
    // Requirement 8.6：占位 / 渲染失败时返回空串而不崩溃。
    return "";
  }
}
