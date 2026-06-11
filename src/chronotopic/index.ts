/**
 * 时空校准层（Chronotopic Calibration Layer）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 这是时空校准层对外的唯一聚合出口。riverMain.ts 的接线点**只**从
 * `./chronotopic/index.js` 导入所需类型与函数——本层内部模块的相对路径
 * 一律不对外暴露，保持对宿主最小侵入、可整体替换。
 *
 * V1 模块（按 design.md 的组件划分 re-export，均已就绪）：
 *   - chronotopic-time.ts        Component 1：时间维度纯函数
 *   - chronotopic-signature.ts   Component 2：时空签名构建
 *   - chronotopic-calibrator.ts  Component 3：置信度校准器
 *   - chronotopic-store.ts       Component 4：mind.chronotopic 持久化层
 *   - chronotopic-render.ts      Component 5：意识注入（中文文本块）
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *   - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 13.6, 14.3_
 */

// ── Component 1：时间维度纯函数（chronotopic-time.ts） ─────────────
export { deriveTemporalDimension, ageMs } from "./chronotopic-time.js";
export type { TimeOfDay, TemporalDimension } from "./chronotopic-time.js";

// ── Component 2：时空签名构建（chronotopic-signature.ts） ──────────
export { buildChronotopicSignature } from "./chronotopic-signature.js";
export type {
  ChronotopicTargetRef,
  ChronotopicScene,
  ChronotopicPresence,
  ChronotopicSignature,
  ChronotopicSensorInput,
  ChronotopicInteractionInput,
} from "./chronotopic-signature.js";

// ── Component 3：置信度校准器（chronotopic-calibrator.ts） ─────────
export {
  calibrateConfidence,
  clamp01,
  DEFAULT_CHRONOTOPIC_CONFIG,
} from "./chronotopic-calibrator.js";
export type { ChronotopicCalibrationConfig } from "./chronotopic-calibrator.js";

// ── Component 4：mind.chronotopic 持久化层（chronotopic-store.ts） ─
export {
  emptyChronotopicState,
  getSignatures,
  upsertSignature,
  getActiveSignatures,
  pruneSignatures,
} from "./chronotopic-store.js";
export type { ChronotopicState } from "./chronotopic-store.js";

// ── Component 5：意识注入（chronotopic-render.ts） ────────────────
export { renderChronotopicBlock } from "./chronotopic-render.js";

// ── V2：时空衰减与三信号融合（chronotopic-decay.ts） ─────────────
export * from "./chronotopic-decay.js";    // V2：时空衰减

// ── V3：期望校准误差（chronotopic-ece.ts） ──────────────────────
export * from "./chronotopic-ece.js";        // V3：期望校准误差（ECE）

// ── 以下 V3 模块在后续任务中逐步实现并在此 re-export（预留占位） ──
export * from "./chronotopic-compress.js"; // V3：签名压缩 / 聚类
