/**
 * 叙事输出层 · 质量门编排器（Component 5：narrative-gate.ts）
 * ------------------------------------------------------------------
 * 编排忠实性门（{@link scoreFaithfulness}）与人格一致性门（{@link checkPersona}），
 * 给出 `verdict` 并执行降级策略。这是接入 `say_to_user` 的**唯一入口**。
 * 确定性、降级安全（fail-open）：任何输入 / 任何内部异常下都不抛错、都产出可发送的
 * 非空文本（输入非空时），绝不因质量门让弟弟说不了话。
 *
 * 设计要点（参见 design.md Component 5 / 算法三 与 requirements.md Requirement 5 / 7.4）：
 *  - 仅返回四种 verdict 之一：`pass` / `annotate` / `fallback` / `reject`（R5.3）。
 *  - `cfg.mode = "dry-run"`（默认）→ 永远 `verdict ∈ {pass, annotate}`，绝不改变既有
 *    say 行为；`pass` 时 `result.text === 输入原文`（行为零改变，R5.4 / R5.5 / Property 7）。
 *  - `cfg.mode = "enforce"`：persona 不一致 → `reject`（中性重述提示，R5.7）；
 *    `faith.score < passThreshold` → `fallback`（放行原文 + 留痕，R5.8）；
 *    存在未验证来源支撑且 `annotateMode≠off` → `annotate`；其余 → `pass`。
 *  - `annotate` 时 `result.text` 以原文为前缀且语义等价（仅追加分层/脚注，R5.6 / Property 8）。
 *  - 任意异常 → fail-open 返回 `pass` + 原文（faithfulness 用空报告，persona 用
 *    consistent:true 空报告，R5.9 / Property 6）。
 *  - `note` 记人类可读裁决说明，**不发给用户**（R5.10）。
 *  - 返回对象字段名严禁出现 `enginePacket` / `executionAllowed` / `selectedEngine`
 *    （no-engine-trigger，沿用河床哲学，R7.4 / Property 12）。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 NarrativeSourceIndex 等只读类型解耦）。
 *  - 零第三方运行时依赖；确定性纯函数、降级安全。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import type { NarrativeVoiceConfig } from "./narrative-config.js";
import {
  scoreFaithfulness,
  type FaithfulnessReport,
} from "./narrative-faithfulness.js";
import {
  checkPersona,
  type PersonaReport,
} from "./narrative-persona.js";
import { renderNarrativeOutput } from "./narrative-render.js";
import type {
  NarrativeSource,
  NarrativeSourceIndex,
} from "./narrative-source.js";

/** 裁决类型：放行 / 标注放行 / 回退原文 / 拒绝重述。 */
export type NarrativeVerdict = "pass" | "annotate" | "fallback" | "reject";

/** 叙事质量门裁决结果。 */
export interface NarrativeGateResult {
  /** 裁决（四种之一）。 */
  verdict: NarrativeVerdict;
  /** 实际放行文本（pass=原文；annotate=渲染增强；fallback=原文；reject=重述提示）。 */
  text: string;
  /** 忠实性评分报告（留痕用）。 */
  faithfulness: FaithfulnessReport;
  /** 人格一致性报告（留痕用）。 */
  persona: PersonaReport;
  /** 人类可读裁决说明（留痕用，**不发给用户**）。 */
  note: string;
}

/** enforce 下 persona 违规时返回的中性重述提示（不阻断说话，仅引导换一种说法）。 */
const NEUTRAL_RESTATE_PROMPT = "让我换个方式说。";

/**
 * 取本次裁决所用的 legacyPatterns。
 *
 * 按 design 算法三：`legacyPatternsOf(cfg)` 在 cfg 不含 legacy 数据时返回空数组——
 * gate 签名仅为 `(text, index, cfg)`，不直接持有 `mind.fallbackReplyPolicy`；
 * 真正的 legacyPatterns 由 riverMain 接线层通过另一路径注入。人格门内置词表 +
 * `cfg.extraForbiddenPatterns` 已覆盖本层的人格漂移检测。
 *
 * @param cfg 叙事层配置。
 * @returns legacyPatterns（此处恒为空数组）。
 */
function legacyPatternsOf(cfg: NarrativeVoiceConfig): string[] {
  void cfg;
  return [];
}

/**
 * 判定命中的来源中是否存在「未验证来源」支撑（truthTier="inferred"）。
 *
 * 用于决定是否走 `annotate`（追加真假分层提示）。仅消费 mind 内已有标记，
 * 不重新判断真假（职责边界红线）。
 *
 * @param faith 忠实性报告（提供命中来源 id）。
 * @param index 来源索引（用于按 id 查 truthTier）。
 * @returns 存在至少一个 inferred 命中来源即返回 true。
 */
function hasUnverifiedSupport(
  faith: FaithfulnessReport,
  index: NarrativeSourceIndex,
): boolean {
  const matchedIds = Array.isArray(faith?.matchedSourceIds)
    ? faith.matchedSourceIds
    : [];
  if (matchedIds.length === 0) return false;

  const sources: ReadonlyArray<NarrativeSource> = Array.isArray(index?.sources)
    ? index.sources
    : [];
  if (sources.length === 0) return false;

  const matched = new Set(matchedIds);
  for (const source of sources) {
    if (matched.has(source.id) && source.truthTier === "inferred") {
      return true;
    }
  }
  return false;
}

/**
 * 构造 `annotate` 裁决结果：调 {@link renderNarrativeOutput} 得增强文本。
 * 渲染器保证「原文是结果前缀、只追加不删改」且异常兜底返回原文，故 annotate
 * 的 `text` 恒以原文为前缀、语义与原文等价（Property 8）。
 *
 * @param text 原文。
 * @param index 来源索引。
 * @param faith 忠实性报告。
 * @param persona 人格报告。
 * @param cfg 叙事层配置。
 * @returns annotate 裁决结果。
 */
function annotateResult(
  text: string,
  index: NarrativeSourceIndex,
  faith: FaithfulnessReport,
  persona: PersonaReport,
  cfg: NarrativeVoiceConfig,
): NarrativeGateResult {
  const rendered = renderNarrativeOutput(text, index, faith, persona, cfg);
  return {
    verdict: "annotate",
    text: rendered,
    faithfulness: faith,
    persona,
    note: "annotate: unverified source support",
  };
}

/** fail-open 兜底用的空忠实性报告（满分、无未支撑断言）。 */
function emptyReport(): FaithfulnessReport {
  return { score: 1, assertionCount: 0, unsupported: [], matchedSourceIds: [] };
}

/** fail-open 兜底用的「一致」空人格报告。 */
function okReport(): PersonaReport {
  return { consistent: true, violations: [] };
}

/**
 * 叙事质量门主入口（确定性、降级安全、绝不抛错阻断说话）。
 *
 * 编排两道门并执行降级裁决（参见 design.md 算法三）：
 *  - **dry-run**（默认）：仅产 `pass`/`annotate`，`pass` 时 `text === 输入原文`（零行为改变）。
 *  - **enforce**：persona 不一致 → `reject`（中性重述提示）；`score < passThreshold`
 *    → `fallback`（放行原文）；未验证来源支撑且 `annotateMode≠off` → `annotate`；其余 `pass`。
 *  - **任意异常** → fail-open 返回 `pass` + 原文。
 *
 * Postconditions（算法三）：
 *  - 降级安全（最高）：任何输入 / 异常下 `result.text` 可发（输入非空时非空）；
 *    dry-run + pass ⟹ `text === 输入原文`。
 *  - `annotate` ⟹ 原文是 `text` 前缀、语义等价。
 *  - 永不返回可执行指令、永不抛错；仅返回四种 verdict 之一。
 *
 * @param text 拟输出文本（接受任意字符串，含空串、超长、特殊字符）。
 * @param index 来源索引（由 buildSourceIndex 产出）。
 * @param cfg 叙事层配置。
 * @returns 裁决结果。
 */
export function gateNarrative(
  text: string,
  index: NarrativeSourceIndex,
  cfg: NarrativeVoiceConfig,
): NarrativeGateResult {
  const raw = String(text ?? "");
  try {
    const faith = scoreFaithfulness(raw, index, cfg);
    const persona = checkPersona(raw, legacyPatternsOf(cfg), cfg);

    const annotateOn = cfg?.annotateMode !== undefined && cfg.annotateMode !== "off";

    // dry-run：只观察，绝不改变既有 say 行为（默认）。
    if (cfg?.mode !== "enforce") {
      if (annotateOn && hasUnverifiedSupport(faith, index)) {
        return annotateResult(raw, index, faith, persona, cfg);
      }
      return {
        verdict: "pass",
        text: raw,
        faithfulness: faith,
        persona,
        note: "dry-run observe",
      };
    }

    // enforce：启用裁决，仍降级安全（绝不阻断说话）。
    if (persona.consistent === false) {
      return {
        verdict: "reject",
        text: NEUTRAL_RESTATE_PROMPT,
        faithfulness: faith,
        persona,
        note: "persona violation",
      };
    }
    if (faith.score < cfg.passThreshold) {
      return {
        verdict: "fallback",
        text: raw /* 原文放行 */,
        faithfulness: faith,
        persona,
        note: "low faithfulness, passthrough+log",
      };
    }
    if (annotateOn && hasUnverifiedSupport(faith, index)) {
      return annotateResult(raw, index, faith, persona, cfg);
    }
    return {
      verdict: "pass",
      text: raw,
      faithfulness: faith,
      persona,
      note: "ok",
    };
  } catch {
    // 任何异常 → 放行原文（降级安全第一，绝不因质量门让弟弟说不了话）。
    return {
      verdict: "pass",
      text: raw,
      faithfulness: emptyReport(),
      persona: okReport(),
      note: "gate error, fail-open",
    };
  }
}
