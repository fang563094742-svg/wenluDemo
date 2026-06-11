/**
 * 叙事输出层 · 可追溯渲染器（Component 4：narrative-render.ts）
 * ------------------------------------------------------------------
 * 把「真假分层 + 来源可溯」忠实呈现给用户。**不重新判断真假**——真假由上游
 * 已定（source / truthTier），本层只把这份既有标记追加呈现出来。确定性、
 * 降级安全：任何异常 try/catch 兜底返回原文，绝不阻断说话。
 *
 * 设计要点（参见 design.md Component 4 / Key Functions 与 requirements.md Requirement 4）：
 *  - `cfg.annotateMode = "off"` → 原样返回 `text`（恒等，最忠实、零增改语义，R4.1 / Property 13）。
 *  - `"inline-tier"` → 仅当存在「未验证来源（truthTier="inferred"）」支撑的断言时，
 *    在文末追加轻量分层提示（如「（其中部分为推断，未经证实）」）——**只加分层说明，
 *    不改原断言语义**（R4.2 / R4.4）。
 *  - `"footnote"` → 文末追加来源脚注（`matchedSourceIds` 的人类可读标签）——
 *    **不改原断言语义**（R4.3 / R4.4）。
 *  - 产出增强文本时，**原文恒为结果字符串的前缀**（只在其后追加，绝不删改原断言，
 *    R4.4 / Property 8）。
 *  - 仅呈现 mind 内已存在内容、不重判真假（R4.5）；整体 try/catch 异常兜底返回原文（R4.6）。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 NarrativeSourceIndex 等只读类型解耦）。
 *  - 零第三方运行时依赖；确定性纯函数、无副作用、降级安全。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import type { NarrativeVoiceConfig } from "./narrative-config.js";
import type { FaithfulnessReport } from "./narrative-faithfulness.js";
import type { PersonaReport } from "./narrative-persona.js";
import type {
  NarrativeSource,
  NarrativeSourceIndex,
  NarrativeTruthTier,
} from "./narrative-source.js";

/** inline-tier 模式下，存在未验证来源支撑时追加的分层提示。 */
const INLINE_TIER_HINT = "（其中部分为推断，未经证实）";

/** footnote 模式下脚注区的标题行（与原文以换行分隔）。 */
const FOOTNOTE_HEADER = "来源：";

/** 来源层 → 人类可读中文标签。 */
const KIND_LABELS: Readonly<Record<NarrativeSource["kind"], string>> = {
  knowledge: "知识",
  belief: "判断",
  userModel: "用户洞察",
  riverbed: "河床态势",
  chronotopic: "时空线索",
};

/** 真假分层 → 人类可读中文标签。 */
const TIER_LABELS: Readonly<Record<NarrativeTruthTier, string>> = {
  verified: "已证实",
  inferred: "推断",
  contextual: "上下文",
};

/**
 * 按 id 建立来源查找表（仅本模块内部用，确定性）。
 *
 * @param index 来源索引。
 * @returns id → NarrativeSource 的 Map。
 */
function indexById(index: NarrativeSourceIndex): Map<string, NarrativeSource> {
  const byId = new Map<string, NarrativeSource>();
  const sources = Array.isArray(index?.sources) ? index.sources : [];
  for (const source of sources) {
    if (source && typeof source.id === "string") {
      byId.set(source.id, source);
    }
  }
  return byId;
}

/**
 * 判定命中的来源中是否存在「未验证（truthTier="inferred"）」者。
 *
 * @param faith 忠实性报告（提供命中来源 id）。
 * @param byId  来源 id 查找表。
 * @returns 存在至少一个 inferred 命中来源即返回 true。
 */
function hasInferredSupport(
  faith: FaithfulnessReport,
  byId: ReadonlyMap<string, NarrativeSource>,
): boolean {
  const matchedIds = Array.isArray(faith?.matchedSourceIds)
    ? faith.matchedSourceIds
    : [];
  for (const id of matchedIds) {
    const source = byId.get(id);
    if (source && source.truthTier === "inferred") return true;
  }
  return false;
}

/**
 * 为单条来源生成人类可读脚注标签：`[层·分层] 内容片段`。
 * 内容过长时截断（保留前 40 字），保证脚注简洁、确定。
 *
 * @param source 来源项。
 * @returns 人类可读标签。
 */
function formatSourceLabel(source: NarrativeSource): string {
  const kindLabel = KIND_LABELS[source.kind] ?? String(source.kind);
  const tierLabel = TIER_LABELS[source.truthTier] ?? String(source.truthTier);
  const content = String(source.content ?? "");
  const snippet = content.length > 40 ? `${content.slice(0, 40)}…` : content;
  return `[${kindLabel}·${tierLabel}] ${snippet}`;
}

/**
 * 渲染拟输出文本：附可追溯标注 / 真假分层提示（确定性、降级安全）。
 *
 * 行为（参见 design.md Component 4 / Key Functions）：
 *  - `annotateMode = "off"` → 返回 `=== text`（恒等）。
 *  - `"inline-tier"` → 仅当存在未验证来源支撑时，文末追加 {@link INLINE_TIER_HINT}；
 *    否则恒等返回原文。
 *  - `"footnote"` → 命中来源非空时，文末换行追加来源脚注；否则恒等返回原文。
 *  - 任何模式下，原文恒为结果字符串前缀（仅追加、不删改原断言）。
 *  - 任意异常 → 兜底返回原文（fail-open，绝不阻断说话）。
 *
 * @param text    拟输出文本。
 * @param index   来源索引（由 buildSourceIndex 产出）。
 * @param faith   忠实性报告（提供命中来源 id）。
 * @param persona 人格一致性报告（当前渲染不依赖其内容，保留以契合统一签名）。
 * @param cfg     叙事层配置（提供 `annotateMode`）。
 * @returns 渲染后的文本（off 模式或无可标注内容时恒等于原文）。
 */
export function renderNarrativeOutput(
  text: string,
  index: NarrativeSourceIndex,
  faith: FaithfulnessReport,
  persona: PersonaReport,
  cfg: NarrativeVoiceConfig,
): string {
  // persona 当前不参与渲染决策，但保留入参以契合 design 的统一渲染签名。
  void persona;

  const raw = String(text ?? "");
  try {
    const mode = cfg?.annotateMode ?? "off";

    // off：最忠实，零增改语义（恒等）。
    if (mode === "off") return raw;

    const byId = indexById(index);
    const matchedIds = Array.isArray(faith?.matchedSourceIds)
      ? faith.matchedSourceIds
      : [];

    if (mode === "inline-tier") {
      // 仅当存在未验证来源支撑时追加分层提示；否则原样返回（不无故增改）。
      if (hasInferredSupport(faith, byId)) {
        return raw + INLINE_TIER_HINT;
      }
      return raw;
    }

    if (mode === "footnote") {
      // 收集命中来源的人类可读标签（去重、稳定顺序）。
      const labels: string[] = [];
      const seen = new Set<string>();
      for (const id of matchedIds) {
        if (seen.has(id)) continue;
        const source = byId.get(id);
        if (!source) continue;
        seen.add(id);
        labels.push(formatSourceLabel(source));
      }
      // 无可溯来源 → 不追加脚注，恒等返回原文。
      if (labels.length === 0) return raw;
      const footnote = `\n\n${FOOTNOTE_HEADER}\n${labels
        .map((label, i) => `${i + 1}. ${label}`)
        .join("\n")}`;
      return raw + footnote;
    }

    // 未知模式：保守恒等返回原文。
    return raw;
  } catch {
    // 降级安全：任何异常兜底返回原文，绝不阻断说话。
    return raw;
  }
}
