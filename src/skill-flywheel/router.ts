/**
 * 技能复利飞轮 · Component 3：确定性优先路由器（router.ts）
 * ------------------------------------------------------------------
 * 三级降级：技能命中(skill) → 可确定性求解(deterministic) → 临场 LLM(llm)。
 * "不走 LLM 依旧实力在线"：能用现成技能/确定性算法就绝不烧 LLM。
 * 纯函数 routeTask：确定、不改入参；任一段异常 fail-open → llm（既有路径永远兜底）。
 * DeterministicProbe 由接线点注入（如 chess.js 合法走法 / SQL 解析 / 文件操作探测）。
 * _Requirements: 2.1-2.7_
 */

import { type SkillKB, searchSkills, reputationOf } from "./skill-kb.js";
import { type SkillPlatform } from "./skill-spec.js";

export type RouteTier = "skill" | "deterministic" | "llm";

export interface RouteDecision {
  tier: RouteTier;
  /** skill: 命中技能 id；deterministic: 工具引用；llm: 无。 */
  ref?: string;
  reason: string;
}

/** 确定性探针：接线点注入。canSolve 判定该任务能否由确定性算法/工具求解。 */
export interface DeterministicProbe {
  canSolve(taskDesc: string): { ok: boolean; toolRef?: string };
}

export interface RouteParams {
  taskDesc: string;
  platform: SkillPlatform;
  kb: SkillKB;
  deterministic?: DeterministicProbe;
  /** 技能被信任复用所需的最小验证成功次数。 */
  minTrust: number;
}

/**
 * 三级降级路由。纯函数，异常 fail-open → llm。
 * 1) 技能库命中且信誉/验证次数达标 → skill
 * 2) 确定性探针可解 → deterministic
 * 3) 否则 → llm
 */
export function routeTask(params: RouteParams): RouteDecision {
  try {
    const { taskDesc, platform, kb, deterministic } = params;
    const minTrust = Number.isFinite(params.minTrust) && params.minTrust >= 0 ? params.minTrust : 1;

    // ── 一级：技能命中 ──
    const candidates = searchSkills(kb, taskDesc, platform);
    for (const skill of candidates) {
      const verified = skill.provenance?.verifiedCount ?? 0;
      // 达到最小验证次数才允许被信任复用；否则不固化未验证技能。
      if (verified >= minTrust && reputationOf(skill) > 0) {
        return {
          tier: "skill",
          ref: skill.id,
          reason: `技能命中 ${skill.name} (rep=${reputationOf(skill).toFixed(2)}, verified=${verified})`,
        };
      }
    }

    // ── 二级：确定性可解 ──
    if (deterministic) {
      const probe = deterministic.canSolve(taskDesc);
      if (probe?.ok) {
        return {
          tier: "deterministic",
          ref: probe.toolRef,
          reason: `确定性可解${probe.toolRef ? ` via ${probe.toolRef}` : ""}`,
        };
      }
    }

    // ── 三级：临场 LLM ──
    return { tier: "llm", reason: "无技能命中且非确定性可解，临场 LLM" };
  } catch (err) {
    // fail-open：任何异常都退回既有 LLM 路径，绝不阻断主链。
    return { tier: "llm", reason: `fail-open(${err instanceof Error ? err.message : String(err)})` };
  }
}
