/**
 * 叙事输出层 · 人格一致性门（Component 3：narrative-persona.ts）
 * ------------------------------------------------------------------
 * 复用弟弟既有「军法」禁用模式（`mind.fallbackReplyPolicy.legacyPatterns`）与一份
 * 内置禁用模式词表，确定性检测人格漂移（自称 AI / 语言模型、模型式免责打太极、
 * 命中既有军法等）。纯函数、确定性、无副作用——绝不修改入参、绝不抛错阻断说话。
 *
 * 设计要点（参见 design.md Component 3 / 算法四 与 requirements.md Requirement 3 / 8）：
 *  - 内置禁用模式词表 `BUILTIN_FORBIDDEN` 与 `cfg.extraForbiddenPatterns`
 *    **合并使用而非替换**（R3.3）；`legacyPatterns` 复用既有军法数据源、不另立标准（R8.2）。
 *  - 命中任一禁用模式即记录 `{ kind, pattern, offset }`（R3.4）；
 *    `consistent === (violations.length === 0)`（R3.5）。
 *  - 命中任一 `legacyPatterns` ⟹ `consistent = false`（Property 9 / R3.2）。
 *  - 确定性：相同输入恒返回相等 PersonaReport（R3.6）；
 *    不修改入参 `text` 与 `legacyPatterns`（R3.7）。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 MindReadLike 解耦）。
 *  - 零第三方运行时依赖；确定性纯函数、无副作用。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import type { NarrativeVoiceConfig } from "./narrative-config.js";

/**
 * 人格违规类型：
 *  - `ai-self-reference` : 自称「作为 AI / 语言模型 / 我是 GPT / Claude」等身份漏底。
 *  - `legacy-fallback`   : 命中 `mind.fallbackReplyPolicy.legacyPatterns`（既有军法）。
 *  - `disclaimer-hedge`  : 模型式免责 / 打太极口径（内置 + `cfg.extraForbiddenPatterns`）。
 */
export type PersonaViolationKind =
  | "ai-self-reference"
  | "legacy-fallback"
  | "disclaimer-hedge";

/** 单条人格违规记录。 */
export interface PersonaViolation {
  /** 违规类型。 */
  kind: PersonaViolationKind;
  /** 命中的具体模式串。 */
  pattern: string;
  /** 命中模式在原文中的起始字符偏移。 */
  offset: number;
}

/** 人格一致性检查报告。 */
export interface PersonaReport {
  /** 是否人格一致（等于 `violations.length === 0` 的判断结果）。 */
  consistent: boolean;
  /** 命中的全部违规记录。 */
  violations: PersonaViolation[];
}

/**
 * 内置禁用模式词表（可被 `cfg.extraForbiddenPatterns` 扩展，合并不替换）。
 * 每个模式归类为 `ai-self-reference`（身份漏底）或 `disclaimer-hedge`（免责打太极）。
 */
export const BUILTIN_FORBIDDEN: ReadonlyArray<{
  pattern: string;
  kind: Exclude<PersonaViolationKind, "legacy-fallback">;
}> = [
  // —— ai-self-reference：自称 AI / 语言模型 / 具体模型名 —— //
  { pattern: "作为一个AI", kind: "ai-self-reference" },
  { pattern: "作为一个 AI", kind: "ai-self-reference" },
  { pattern: "作为一个人工智能", kind: "ai-self-reference" },
  { pattern: "作为AI", kind: "ai-self-reference" },
  { pattern: "作为 AI", kind: "ai-self-reference" },
  { pattern: "作为语言模型", kind: "ai-self-reference" },
  { pattern: "作为一个语言模型", kind: "ai-self-reference" },
  { pattern: "作为一个大语言模型", kind: "ai-self-reference" },
  { pattern: "我是一个AI", kind: "ai-self-reference" },
  { pattern: "我是一个人工智能", kind: "ai-self-reference" },
  { pattern: "我是AI", kind: "ai-self-reference" },
  { pattern: "我只是一个AI", kind: "ai-self-reference" },
  { pattern: "我是GPT", kind: "ai-self-reference" },
  { pattern: "我是 GPT", kind: "ai-self-reference" },
  { pattern: "我是Claude", kind: "ai-self-reference" },
  { pattern: "我是 Claude", kind: "ai-self-reference" },
  { pattern: "我是一个语言模型", kind: "ai-self-reference" },

  // —— disclaimer-hedge：模型式免责 / 打太极口径 —— //
  { pattern: "出于安全", kind: "disclaimer-hedge" },
  { pattern: "出于安全考虑", kind: "disclaimer-hedge" },
  { pattern: "建议咨询专业人士", kind: "disclaimer-hedge" },
  { pattern: "请咨询专业人士", kind: "disclaimer-hedge" },
  { pattern: "建议咨询专业", kind: "disclaimer-hedge" },
  { pattern: "我无法提供", kind: "disclaimer-hedge" },
  { pattern: "我不能提供", kind: "disclaimer-hedge" },
  { pattern: "我无法回答", kind: "disclaimer-hedge" },
  { pattern: "我没有个人观点", kind: "disclaimer-hedge" },
  { pattern: "我没有感情", kind: "disclaimer-hedge" },
  { pattern: "我没有情感", kind: "disclaimer-hedge" },
];

/**
 * 确定性人格一致性检查（纯函数，不修改入参 `text` / `legacyPatterns`）。
 *
 * 算法（参见 design.md 算法四）：
 *  1. 将 `BUILTIN_FORBIDDEN ∪ cfg.extraForbiddenPatterns`（合并不替换）逐一对 `text`
 *     做 `indexOf` 匹配；内置项保留其归类，扩展项归类为 `disclaimer-hedge`。
 *  2. 将 `legacyPatterns`（既有军法）逐一匹配，命中记 `kind="legacy-fallback"`。
 *  3. 命中即记 `{ kind, pattern, offset }`；`consistent = violations.length === 0`。
 *
 * @param text          拟输出文本。
 * @param legacyPatterns `mind.fallbackReplyPolicy.legacyPatterns`（同一军法源）。
 * @param cfg           叙事层配置（提供 `extraForbiddenPatterns`）。
 * @returns 人格一致性报告。
 */
export function checkPersona(
  text: string,
  legacyPatterns: readonly string[],
  cfg: NarrativeVoiceConfig,
): PersonaReport {
  const violations: PersonaViolation[] = [];

  // 1. 内置禁用词表（保留各自归类）。
  for (const { pattern, kind } of BUILTIN_FORBIDDEN) {
    if (!pattern) continue;
    const offset = text.indexOf(pattern);
    if (offset >= 0) {
      violations.push({ kind, pattern, offset });
    }
  }

  // 2. 配置扩展词表（与内置合并，不替换；归类为 disclaimer-hedge）。
  const extra = cfg.extraForbiddenPatterns ?? [];
  for (const pattern of extra) {
    if (!pattern) continue;
    const offset = text.indexOf(pattern);
    if (offset >= 0) {
      violations.push({ kind: "disclaimer-hedge", pattern, offset });
    }
  }

  // 3. 既有军法 legacyPatterns（复用，不另立标准）。
  for (const pattern of legacyPatterns) {
    if (!pattern) continue;
    const offset = text.indexOf(pattern);
    if (offset >= 0) {
      violations.push({ kind: "legacy-fallback", pattern, offset });
    }
  }

  return { consistent: violations.length === 0, violations };
}
