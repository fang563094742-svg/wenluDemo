/**
 * 持续执行内核（Execution Kernel）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 对外唯一聚合出口。riverMain.ts 的接线点**只**从 `./execution-kernel/index.js`
 * 导入所需类型与函数；内部模块相对路径一律不对外暴露。
 *
 * 五段执行脊柱（按 design.md 组件划分）：
 *   - execution-config.ts    配置与默认 + MindExecReadLike 最小接口
 *   - types.ts               一等公民类型 + ReadLike 解耦接口
 *   - perception-loop.ts     Component 1：感知闭环（执行≠成功，独立回读判定四态）
 *   - continuation-kernel.ts Component 2：持续脊柱（waiting/外部唤醒/止损/中止）
 *   - definition-of-done.ts  Component 3：终态镜子（接用户画像 userModel）
 *   - strategy-kernel.ts     Component 4：策略层（复用 cognitive-core Intent + 河床判断）
 *   - meta-control.ts        Component 5：注意力对齐（复用 goalMonitor + reflect）
 *   - post-verify.ts         动作后独立验证 + failedAttempts 防重复（接线点注入真实回读）
 *   - wait-eval.ts           唤醒条件满足/超时判定（接线点注入真实探测）
 *
 * 绝对边界（Requirement 6.7 / 7.1）：
 *   - 不 import 任何 3.1 / 3.2 路径，不 import "server-only" / "node:sqlite" / "@/lib"。
 *   - 不反向 import `riverMain.ts`（经 *ReadLike 只读类型解耦）。
 *   - 纯 TypeScript ESM，相对导入带 `.js`，最多 `node:crypto`。
 *   - 跨模块引用只经对应 barrel（cognitive-core/index.js 等）。
 */

export {
  DEFAULT_EXECUTION_KERNEL,
  resolveExecutionConfig,
} from "./execution-config.js";
export type {
  ExecutionMode,
  ExecutionStageToggles,
  ExecutionKernelConfig,
  MindExecReadLike,
} from "./execution-config.js";

export {
  newStepId,
  newPlanId,
} from "./types.js";
export type {
  ActionOutcome,
  ActionKind,
  WorldState,
  StateProbe,
  ExecutionStep,
  TaskExecStatus,
  WakeCondition,
  WorkingState,
  ContinuationDecision,
  UserModelReadLike,
  GoalGapReadLike,
  DefinitionOfDone,
  RiverbedJudgmentReadLike,
  LegalityValidator,
  ReflectionReadLike,
  OutcomeJudgeLike,
} from "./types.js";

export {
  PerceptionLoop,
  observeAction,
  judgeOutcome,
  probeState,
} from "./perception-loop.js";

export {
  ContinuationKernel,
  decideContinuation,
  isLegitimateWait,
} from "./continuation-kernel.js";

export {
  buildDefinitionOfDone,
  remainingToDone,
  remainingToDoneSemantic,
} from "./definition-of-done.js";
export type { DoneJudgeLike } from "./definition-of-done.js";

export {
  StrategyKernel,
  buildMidPlan,
  detectPlanDrift,
  validateCandidate,
} from "./strategy-kernel.js";
export type { MovePlan } from "./strategy-kernel.js";

export {
  MetaControl,
  suggestAttentionRedirect,
} from "./meta-control.js";

export {
  VERIFY_POLICY,
  needsPostVerify,
  commandHasSideEffect,
  judgePostVerify,
  shouldForceNewApproach,
} from "./post-verify.js";
export type { VerifyPolicy, PostVerifyEvidence, PostVerifyResult } from "./post-verify.js";

export {
  isWakeSatisfied,
  isWaitTimeout,
  clampWaitTimeout,
} from "./wait-eval.js";
export type { WakeProbeResult } from "./wait-eval.js";
