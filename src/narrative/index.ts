/**
 * 叙事输出层（Narrative Output Layer）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 这是叙事层对外的唯一聚合出口。riverMain.ts 的接线点**只**从
 * `./narrative/index.js` 导入所需类型与函数——本层内部模块的相对路径
 * 一律不对外暴露，保持对宿主最小侵入、可整体替换。
 *
 * V1 模块（按 design.md 的组件划分 re-export，均已就绪）：
 *   - narrative-config.ts        Component 6：配置与默认 + MindReadLike 最小接口
 *   - narrative-source.ts        Component 1：可追溯来源归集器
 *   - narrative-faithfulness.ts  Component 2：忠实性门（断言抽取 + 支撑度评分）
 *   - narrative-persona.ts       Component 3：人格一致性门（复用既有军法）
 *   - narrative-render.ts        Component 4：可追溯渲染器（真假分层呈现）
 *   - narrative-gate.ts          Component 5：质量门编排器（say_to_user 唯一入口）
 *
 * 命名约定：`MindReadLike` 在 narrative-config.ts 定义，并被 narrative-source.ts
 * 顺带 re-export；为避免重复导出错误，本桶**只从 config 导出一次**，source 侧改用
 * 显式具名导出（不再 `export *`）。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *   - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *   - 不反向 import `riverMain.ts`（经 MindReadLike 等只读类型解耦）。
 *   - 零第三方运行时依赖（最多 node:crypto）。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 8.1, 9.2, 9.3_
 */

// ── Component 6：配置与默认 + MindReadLike 最小接口（narrative-config.ts） ──
export {
  DEFAULT_NARRATIVE_VOICE,
  resolveNarrativeConfig,
} from "./narrative-config.js";
export type { NarrativeVoiceConfig, MindReadLike } from "./narrative-config.js";

// ── Component 1：可追溯来源归集器（narrative-source.ts） ───────────────────
// 注意：MindReadLike 已在 config 处导出，这里用显式具名导出避免重复导出冲突。
export {
  buildSourceIndex,
  mapTruthTier,
  extractKeywords,
  safeReadRiverbedReasons,
  safeReadChronoSummaries,
} from "./narrative-source.js";
export type {
  NarrativeSource,
  NarrativeSourceIndex,
  NarrativeTruthTier,
  NarrativeSourceKind,
} from "./narrative-source.js";

// ── Component 2：忠实性门（narrative-faithfulness.ts） ─────────────────────
export { extractAssertions, supportScore, scoreFaithfulness } from "./narrative-faithfulness.js";
export type { AssertionSpan, FaithfulnessReport } from "./narrative-faithfulness.js";

// ── Component 3：人格一致性门（narrative-persona.ts） ──────────────────────
export { BUILTIN_FORBIDDEN, checkPersona } from "./narrative-persona.js";
export type {
  PersonaViolationKind,
  PersonaViolation,
  PersonaReport,
} from "./narrative-persona.js";

// ── Component 4：可追溯渲染器（narrative-render.ts） ───────────────────────
export { renderNarrativeOutput } from "./narrative-render.js";

// ── Component 5：质量门编排器（narrative-gate.ts） ─────────────────────────
export { gateNarrative } from "./narrative-gate.js";
export type { NarrativeVerdict, NarrativeGateResult } from "./narrative-gate.js";
