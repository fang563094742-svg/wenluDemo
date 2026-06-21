/**
 * 技能复利飞轮 · Component 2：技能库 SkillKB（skill-kb.ts）
 * ------------------------------------------------------------------
 * 不可变操作：addSkill / recordSkillOutcome 一律返回新 KB，绝不原地改入参。
 * searchSkills：先按适用条件 + 平台过滤，再按信誉降序排序。
 * reputationOf：verifiedCount/totalCount（无样本视为中性，避免新技能被永久埋没）。
 * 纯库，无副作用，不反向 import riverMain。
 * _Requirements: 4.1-4.5_
 */

import {
  type SkillSpec,
  type SkillPlatform,
  type SkillTaxonomy,
  skillMatches,
  skillRelevance,
} from "./skill-spec.js";
import { type FlywheelRankingParams, DEFAULT_RANKING } from "./flywheel-config.js";

export interface SkillKB {
  skills: SkillSpec[];
}

export function emptyKB(): SkillKB {
  return { skills: [] };
}

/** 不可变：返回包含新技能的新 KB。同 id 视为升级覆盖（保留较高 totalCount 的来源）。 */
export function addSkill(kb: SkillKB, spec: SkillSpec): SkillKB {
  const base = kb?.skills ?? [];
  const without = base.filter((s) => s.id !== spec.id);
  return { skills: [...without, spec] };
}

/** 信誉：verifiedCount/totalCount。无样本返回中性 0.5（不奖不罚，给机会被试）。 */
export function reputationOf(spec: SkillSpec): number {
  const total = spec?.provenance?.totalCount ?? 0;
  const ok = spec?.provenance?.verifiedCount ?? 0;
  if (total <= 0) return 0.5;
  const r = ok / total;
  if (!Number.isFinite(r)) return 0.5;
  return Math.max(0, Math.min(1, r));
}

/**
 * UCB1 探索奖励：给低样本技能额外分数，鼓励探索。
 * C = 探索常数（默认 0.5），globalN = 所有技能总调用次数。
 */
export function ucb1Bonus(spec: SkillSpec, globalN: number, C = 0.5): number {
  const total = spec?.provenance?.totalCount ?? 0;
  if (total <= 0) return C; // 从未被用过→给满额探索奖励
  if (globalN <= 0) return 0;
  return C * Math.sqrt(Math.log(globalN) / total);
}

/**
 * Recency boost：新创建的技能在 decayDays 内获得线性衰减加分。
 * 返回 0~maxBoost（默认 0.3），超过 decayDays（默认 7 天）后归零。
 */
export function recencyBoost(spec: SkillSpec, nowMs = Date.now(), decayDays = 7, maxBoost = 0.3): number {
  const created = spec?.provenance?.createdAt;
  if (!created) return 0;
  const ageMs = nowMs - new Date(created).getTime();
  if (ageMs < 0) return maxBoost;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays >= decayDays) return 0;
  return maxBoost * (1 - ageDays / decayDays);
}

/**
 * 检索：适用条件 + 平台过滤后按综合排名降序。
 * 不变式：rel=0 的技能绝不出现在结果中（探索奖励在 rel 括号内，rel=0 → score=0）。
 * ranking 参数从 FlywheelConfig.ranking 透传，消除 magic number 双源。
 */
export function searchSkills(
  kb: SkillKB,
  taskDesc: string,
  platform: SkillPlatform,
  taxonomy?: Partial<SkillTaxonomy>,
  minRelevance = 0,
  ranking: FlywheelRankingParams = DEFAULT_RANKING,
): SkillSpec[] {
  const all = kb?.skills ?? [];
  const scored: Array<{ s: SkillSpec; rel: number }> = [];
  for (const s of all) {
    const rel = skillRelevance(s, taskDesc, platform);
    if (rel <= 0) continue;
    if (rel < minRelevance) continue;
    if (!skillMatches(s, taskDesc, platform)) continue;
    if (taxonomy?.taskType && s.taxonomy?.taskType !== taxonomy.taskType) continue;
    if (taxonomy?.app && s.taxonomy?.app !== taxonomy.app) continue;
    if (taxonomy?.industry && s.taxonomy?.industry !== taxonomy.industry) continue;
    scored.push({ s, rel });
  }
  // 综合排序：rel * (exploit + exploreWeight*explore + freshWeight*fresh)
  // rel=0 被上面的 continue 排除；rel>0 时探索/新鲜度按比例缩放，不会独立主导。
  const globalN = all.reduce((sum, s) => sum + (s.provenance?.totalCount ?? 0), 0);
  const nowMs = Date.now();
  const { ucb1C, recencyDecayDays, recencyMaxBoost, exploreWeight, freshWeight } = ranking;
  return scored
    .sort((a, b) => {
      const exploitA = reputationOf(a.s);
      const exploreA = ucb1Bonus(a.s, globalN, ucb1C);
      const freshA = recencyBoost(a.s, nowMs, recencyDecayDays, recencyMaxBoost);
      const scoreA = a.rel * (exploitA + exploreWeight * exploreA + freshWeight * freshA);

      const exploitB = reputationOf(b.s);
      const exploreB = ucb1Bonus(b.s, globalN, ucb1C);
      const freshB = recencyBoost(b.s, nowMs, recencyDecayDays, recencyMaxBoost);
      const scoreB = b.rel * (exploitB + exploreWeight * exploreB + freshWeight * freshB);

      if (scoreB !== scoreA) return scoreB - scoreA;
      const ta = a.s.provenance?.totalCount ?? 0;
      const tb = b.s.provenance?.totalCount ?? 0;
      if (tb !== ta) return tb - ta;
      return a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0;
    })
    .map((x) => x.s);
}

/**
 * 复用结果回写信誉（不可变）。
 * success：totalCount+1 且 verifiedCount+1；fail：仅 totalCount+1。
 * 信誉单调（P7）：success 不降低 reputation，fail 不升高。
 */
export function recordSkillOutcome(kb: SkillKB, skillId: string, success: boolean): SkillKB {
  const base = kb?.skills ?? [];
  let touched = false;
  const skills = base.map((s) => {
    if (s.id !== skillId) return s;
    touched = true;
    const prevTotal = s.provenance?.totalCount ?? 0;
    const prevOk = s.provenance?.verifiedCount ?? 0;
    return {
      ...s,
      provenance: {
        ...s.provenance,
        createdAt: s.provenance?.createdAt ?? new Date().toISOString(),
        totalCount: prevTotal + 1,
        verifiedCount: success ? prevOk + 1 : prevOk,
      },
    } satisfies SkillSpec;
  });
  if (!touched) return kb; // 未命中：原样返回（fail-open，不抛）。
  return { skills };
}
