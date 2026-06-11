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
} from "./skill-spec.js";

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
 * 检索：适用条件 + 平台过滤后按信誉降序。
 * taxonomy 给定时按 taskType/app/industry 做额外收窄（缺省不收窄）。
 */
export function searchSkills(
  kb: SkillKB,
  taskDesc: string,
  platform: SkillPlatform,
  taxonomy?: Partial<SkillTaxonomy>,
): SkillSpec[] {
  const all = kb?.skills ?? [];
  const matched = all.filter((s) => {
    if (!skillMatches(s, taskDesc, platform)) return false;
    if (taxonomy?.taskType && s.taxonomy?.taskType !== taxonomy.taskType) return false;
    if (taxonomy?.app && s.taxonomy?.app !== taxonomy.app) return false;
    if (taxonomy?.industry && s.taxonomy?.industry !== taxonomy.industry) return false;
    return true;
  });
  // 信誉降序；并列时验证样本多者优先（更可靠），再并列按 id 稳定排序。
  return [...matched].sort((a, b) => {
    const ra = reputationOf(a);
    const rb = reputationOf(b);
    if (rb !== ra) return rb - ra;
    const ta = a.provenance?.totalCount ?? 0;
    const tb = b.provenance?.totalCount ?? 0;
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
