/**
 * 主权自体（Sovereign Self）· 桶文件（barrel）
 * ------------------------------------------------------------------
 * 对外唯一聚合出口。riverMain.ts 接线点只从 `./sovereign/index.js` 导入。
 * 三刀：统一真相源(unify) + 宪法裁决(constitution) + 镜像闭环(mirror) + 时空入主(chrono) + 自进化升格(policy)。
 *
 * 绝对边界：不 import 3.1/3.2、不 server-only/node:sqlite/@/lib、不反向 import riverMain；
 * 仅相对(.js)/node:crypto/既有 barrel（chronotopic/runtime 等只读复用）。
 */

export {
  DEFAULT_SOVEREIGN,
  DEFAULT_POLICY_WEIGHTS,
  resolveSovereignConfig,
} from "./sovereign-config.js";
export type {
  SovereignMode,
  SovereignConfig,
  SovereignCutToggles,
  PolicyWeights,
  MindSovereignReadLike,
} from "./sovereign-config.js";

export { newVerdictId } from "./types.js";
export type {
  SignalSource,
  SourceSignal,
  Intervention,
  Verdict,
  MirrorScore,
  ChronoVerdictInput,
} from "./types.js";

export {
  toDualWriteCommands,
  compareMindVsStore,
} from "./unify.js";
export type { MindChange, DualWriteCommand, ConsistencyReport } from "./unify.js";

export {
  Constitution,
  adjudicate,
  enforceRiverbedBedrock,
  reconcileUserNowVsTrajectory,
} from "./constitution.js";

export {
  settleShadowPrediction,
  computeMirrorScore,
  detectGoalTension,
  mirrorToBehaviorParams,
  mirrorToWeight,
} from "./mirror-loop.js";

export {
  signatureToVerdictInput,
  chronoRetrievalBias,
  chronoToPersonaStance,
} from "./chrono-govern.js";

export {
  sanitizePolicyDelta,
  applyPolicyDelta,
  isPolicyDeltaEndorsed,
} from "./policy-delta.js";
export type { PolicyDelta } from "./policy-delta.js";
