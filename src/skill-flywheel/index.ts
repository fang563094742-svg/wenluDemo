/**
 * 技能复利飞轮 · barrel（index.ts）
 * ------------------------------------------------------------------
 * 对外唯一入口。Router(确定性优先) + Distiller(轨迹→技能) + SkillKB(技能库) + SkillSpec(可反哺规格)。
 * observe 缺省零改变，fail-open，复用 execution-kernel，不反向 import riverMain、不碰 3.1/3.2。
 * _Requirements: 6.4_
 */

// 配置
export {
  type FlywheelMode,
  type FlywheelToggles,
  type FlywheelConfig,
  type MindFlywheelReadLike,
  DEFAULT_FLYWHEEL,
  resolveFlywheelConfig,
} from "./flywheel-config.js";

// 可反哺规格 + 去隐私 + 适用条件
export {
  type SkillPlatform,
  type SkillTaxonomy,
  type SkillVerifyContract,
  type SkillExecStep,
  type SkillSpec,
  newSkillId,
  scanResidualPrivacy,
  skillMatches,
  isReshareReady,
} from "./skill-spec.js";

// 技能库
export {
  type SkillKB,
  emptyKB,
  addSkill,
  reputationOf,
  searchSkills,
  recordSkillOutcome,
} from "./skill-kb.js";

// 路由器
export {
  type RouteTier,
  type RouteDecision,
  type DeterministicProbe,
  type RouteParams,
  routeTask,
} from "./router.js";

// 蒸馏器
export {
  type DistillInput,
  type DistillResult,
  distillSkill,
} from "./distiller.js";

// 海马体桥接
export {
  type RouteEnrichment,
  enrichRouteWithMemory,
  syncPromotedSkillToMemory,
  inferTeacherAuthority,
} from "../bridges/memory-bridge.js";
