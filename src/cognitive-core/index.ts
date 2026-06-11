/**
 * 认知核（Cognitive Core）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 这是认知核对外的唯一聚合出口。riverMain.ts 的接线点**只**从
 * `./cognitive-core/index.js` 导入所需类型与函数——本层内部模块的相对路径
 * 一律不对外暴露，保持对宿主最小侵入、可整体替换。
 *
 * V1 模块（按 design.md 的组件划分 re-export，均已就绪）：
 *   - cognitive-config.ts    配置与默认 + MindConfigReadLike 最小接口
 *   - types.ts               一等公民类型（Intent / Output / 上下文 / DAG 工具）
 *   - cognitive-registry.ts  输出类型注册表（OutputTypeRegistry）
 *   - plan-kernel.ts         Component 1：规划核 PlanKernel
 *   - dispatch-kernel.ts     Component 2：调度核 DispatchKernel
 *   - output-kernel.ts       Component 3：输出核 OutputKernel
 *
 * 命名约定：类型与值分别用 `export type` / `export`，避免 isolatedModules 下的
 * 类型/值混淆；每个名字仅从其权威定义处导出一次，杜绝重复导出冲突。
 *
 * 绝对边界（贯穿全认知核，参见 requirements.md Requirement 6）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *   - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *   - 不反向 import `riverMain.ts`（经 *ReadLike 等只读类型解耦）。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 6.4_
 */

export {
  DEFAULT_COGNITIVE_CORE,
  resolveCognitiveConfig,
} from "./cognitive-config.js";
export type {
  CognitiveMode,
  CognitiveStageToggles,
  CognitiveCoreConfig,
  MindConfigReadLike,
} from "./cognitive-config.js";

export { isValidDag, newIntentId, newOutputId } from "./types.js";
export type {
  Intent,
  Subgoal,
  IntentStatus,
  Output,
  WenluOutputType,
  OutputAudience,
  OutputStatus,
  NodeSignal,
  EmitDecision,
  PlanContext,
  OutputContext,
  DispatchPlan,
  DispatchWave,
  DispatchLine,
  DispatchOptions,
  GoalGapReadLike,
  PrefrontalReadLike,
  LlmLike,
} from "./types.js";

export {
  DefaultOutputTypeRegistry,
  createDefaultOutputTypeRegistry,
} from "./cognitive-registry.js";
export type {
  OutputTypeDescriptor,
  OutputTypeRegistry,
} from "./cognitive-registry.js";

export { PlanKernel, planFromContext, planDeterministic } from "./plan-kernel.js";
export type { PlanKernelLike } from "./plan-kernel.js";
export { shrinkTasklineToSingleBlocker, decideTasklineNextStep } from "./taskline-planner.js";
export type {
  TasklineCandidate,
  TasklinePlan,
  TasklineDecision,
  TasklineExecutionPolicy,
} from "./taskline-planner.js";

export { DispatchKernel, DispatchCycleError, dispatch, dispatchSafe } from "./dispatch-kernel.js";

export {
  OutputKernel,
  shouldEmit,
  condense,
  inferOutputType,
  deterministicCondense,
} from "./output-kernel.js";
