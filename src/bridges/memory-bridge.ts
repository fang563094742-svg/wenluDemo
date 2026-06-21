/**
 * 海马体-飞轮桥接 (OPT-5)
 *
 * 在不引入双向依赖的前提下，让技能飞轮利用分层记忆进行：
 * 1. 路由增强（用记忆上下文扩充任务描述，提升匹配精度）
 * 2. 晋升回写（晋升的技能同步写入程序性记忆）
 * 3. 权威推算（从记忆中的交互历史推导教师权威值）
 */

import type { LayeredMemory, Episode, Concept } from "../hippocampus/types.js";
import { retrieveRelevant } from "../hippocampus/retrieval.js";
import type { SkillSpec } from "./skill-spec.js";

// ─── 1. 路由增强 ─────────────────────────────────────────────────

export interface RouteEnrichment {
  enrichedDesc: string;
  memoryHints: string[];
}

/**
 * 用海马体记忆扩充任务描述，为路由匹配提供更丰富的语义信号。
 * 追加最多 3 条记忆摘要作为"上下文线索"。
 */
export function enrichRouteWithMemory(
  taskDesc: string,
  memory: LayeredMemory,
  currentCycle: number = 0
): RouteEnrichment {
  const hits = retrieveRelevant(taskDesc, memory, {
    topK: 3,
    currentCycle,
    applyCapacityLimit: false,
    minRetention: 0.2,
  });

  if (hits.length === 0) {
    return { enrichedDesc: taskDesc, memoryHints: [] };
  }

  const hints = hits.map(h => h.content.slice(0, 60));
  const enrichedDesc = `${taskDesc} [记忆线索: ${hints.join("; ")}]`;

  return { enrichedDesc, memoryHints: hints };
}

// ─── 2. 晋升回写 ─────────────────────────────────────────────────

/**
 * 技能晋升后，将其写入海马体的程序性记忆层（procedural.rules）。
 * 这让前额叶决策时能"记住"问路已经掌握了哪些技能。
 */
export function syncPromotedSkillToMemory(
  skill: SkillSpec,
  memory: LayeredMemory
): void {
  const ruleContent = `当用户需要"${skill.when.taskPattern}"时，使用技能 ${skill.name}`;

  const existingIdx = memory.procedural.rules.findIndex(
    r => r.source === `skill:${skill.id}`
  );

  const ruleEntry = {
    rule: ruleContent,
    confidence: Math.min(1, (skill.provenance?.verifiedCount ?? 0) / 5),
    source: `skill:${skill.id}`,
  };

  if (existingIdx >= 0) {
    memory.procedural.rules[existingIdx] = ruleEntry;
  } else {
    memory.procedural.rules.push(ruleEntry);
  }
}

// ─── 3. 教师权威推算 ─────────────────────────────────────────────

/**
 * 从海马体的交互历史推算"教师权威值"(0~1)。
 *
 * 逻辑：
 * - 用户纠正次数越多 → 权威越高（纠正是高质量反馈信号）
 * - 活跃时间越长 → 基线权威越高
 * - 最终 clamp 到 [0, 1]
 */
export function inferTeacherAuthority(
  memory: LayeredMemory,
  currentCycle: number
): number {
  const episodes = memory.episodic;

  // 指标 1：纠正信号的比例（user-said 中包含"不对""错了""应该""改成" 等关键词）
  const correctionKeywords = ["不对", "错了", "应该", "改成", "不是这样", "修改", "纠正"];
  const userSaid = episodes.filter(ep => ep.source === "user-said");
  const corrections = userSaid.filter(ep =>
    correctionKeywords.some(kw => ep.content.includes(kw))
  );
  const correctionRatio = userSaid.length > 0
    ? corrections.length / userSaid.length
    : 0;

  // 指标 2：活跃 cycle 跨度
  const firstCycle = episodes.length > 0
    ? Math.min(...episodes.map(ep => ep.createdCycle))
    : currentCycle;
  const span = currentCycle - firstCycle;
  const spanScore = Math.min(span / 200, 1);

  // 指标 3：总交互量（归一化到 0~1，100 条算满分）
  const volumeScore = Math.min(userSaid.length / 100, 1);

  // 加权综合
  const authority = correctionRatio * 0.5 + spanScore * 0.25 + volumeScore * 0.25;

  return Math.min(Math.max(authority, 0), 1);
}
