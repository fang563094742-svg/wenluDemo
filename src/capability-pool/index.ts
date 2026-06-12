/**
 * 问路 — 能力共享池模块 barrel export。
 */
export { submitCapability, getApprovedCapabilities, inheritCapabilities, getUserInheritedCapabilities, getPoolStats } from "./repo.js";
// skill-reflux 扩展（治理并存：新增 skill 表族继承/回写，不改既有 capability_pool 逻辑）
export { inheritSkills, recordSkillUsage, type SkillRowLite } from "./repo.js";
export { capabilityRouter } from "./routes.js";
