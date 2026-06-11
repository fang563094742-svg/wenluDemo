/**
 * 河床系统（Riverbed System）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 这是河床对外的唯一聚合出口。riverMain.ts 的 4 处接线点只从
 * `./riverbed/index.js` 导入所需类型与函数，保持最小侵入。
 *
 * 模块逐步落地，按 design.md 的组件划分 re-export：
 *   - riverbed-util.ts            共享工具与 MindLike（已就绪）
 *   - riverbed-domain.ts          14 域注册表（Task 2）
 *   - riverbed-evidence.ts        证据 / 约束引用归一化（Task 3）
 *   - no-engine-trigger-guard.ts  判断不驱动执行守卫（Task 4）
 *   - domain-judgement-packet.ts  判断包构建（Task 5）
 *   - domain-aggregation.ts       域聚合态势（Task 7）
 *   - riverbed-sense.ts           域映射与兜底汇聚（Task 8）
 *   - riverbed-store.ts           节点持久化 / reflux / prune（Task 9-10）
 *   - riverbed-render.ts          渲染进意识（Task 11）
 *
 * 沿用弟弟 ESM 约定：相对导入一律带 `.js` 扩展。
 */

// ── 共享工具与基础类型（Task 1，已就绪） ──────────────────────────
export { clamp01 } from "./riverbed-util.js";
export type {
  MindLike,
  MindBeliefLike,
  MindUserInsightLike,
  MindConversationEntryLike,
  MindPredictionLike,
  MindMetricsLike,
} from "./riverbed-util.js";

// ── 14 域注册表（Task 2，已就绪） ─────────────────────────────────
export * from "./riverbed-domain.js";

// ── 以下模块在后续任务中逐步实现并在此 re-export ──────────────────
export * from "./riverbed-evidence.js"; // Task 3
export * from "./no-engine-trigger-guard.js"; // Task 4
export * from "./domain-judgement-packet.js"; // Task 5
export * from "./domain-aggregation.js"; // Task 7
export * from "./riverbed-sense.js"; // Task 8
export * from "./riverbed-store.js"; // Task 9 / 10
export * from "./riverbed-render.js"; // Task 11
export * from "./interrupt-engine.js"; // 打断引擎（移植自产品后端 past-riverbed，剥壳+接地）
export * from "./temporary-authority.js"; // 双向回流临时权威层（移植自 bidirectional-reflux）
