/**
 * 持续执行内核 · Component 3：DefinitionOfDone 终态镜子
 * ------------------------------------------------------------------
 * 任务开始就确立"怎样算这件事真做完"，并让这个定义参考用户画像（userModel）投影——
 * 使"做好"反映用户真实需要、边界与"什么算有用"。这是与用户画像的核心链接。
 *
 * 红线：
 *  - 不引入任何对"过程 / 坚持 / 努力"本身发分的字段（防表演刷分）。
 *  - 不碰既有"只有外部可验证任务 passed 才涨 g_results"的反谄媚地基；只把可验证
 *    粒度从单步抬到整件事。
 *  - userModel 空 ⟹ 退回仅基于北极星差距构建，且不报错。
 * _Requirements: 3.1-3.7, 6.1_
 */

import {
  type WorldState,
  type UserModelReadLike,
  type GoalGapReadLike,
  type DefinitionOfDone,
} from "./types.js";

/**
 * 可选完成度语义裁判（LLM 增强注入点）。给定完成条件与当前状态摘要，判定哪些已满足。
 * 不注入 → 走 token 兜底；注入且不抛 → 用语义判定；抛异常 → fail-open 回退 token。
 */
export interface DoneJudgeLike {
  judge(input: {
    goal: string;
    doneConditions: string[];
    currentSummary: string;
  }): Promise<{ satisfied: string[]; missing: string[] } | null>;
}

/** 从用户画像投影出"完成必须满足的、与这件事相关的"约束条件。 */
function projectUserConstraints(goal: string, userModel?: UserModelReadLike): string[] {
  if (!userModel || !Array.isArray(userModel.insights) || userModel.insights.length === 0) return [];
  const conditions: string[] = [];
  // 取置信度较高的画像维度，转成"完成时必须照顾到"的条件。
  const sorted = [...userModel.insights]
    .filter((i) => i && typeof i.content === "string" && i.content.trim().length > 0)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 4);
  for (const ins of sorted) {
    const aspect = ins.aspect || "preference";
    conditions.push(`满足用户[${aspect}]：${ins.content.trim().slice(0, 80)}`);
  }
  return conditions;
}

/**
 * 纯函数：用户画像投影 + 北极星差距 → 完成定义。
 * - userModel 非空 → userAligned=true，doneConditions 含画像投影条件。
 * - userModel 空 → 退回仅 goal + goalGap，不报错，userAligned=false。
 */
export function buildDefinitionOfDone(params: {
  goal: string;
  userModel?: UserModelReadLike;
  goalGap?: GoalGapReadLike;
}): DefinitionOfDone {
  const goal = (params.goal ?? "").trim() || "(未命名目标)";
  const userConditions = projectUserConstraints(goal, params.userModel);
  const userAligned = userConditions.length > 0;

  const doneConditions: string[] = [];
  // 基线：这件事本身的客观完成（由调用方/LLM 后续具体化为 verifyCmd）。
  doneConditions.push(`「${goal}」的核心产出已客观达成且可被独立验证`);
  // 用户画像投影条件（与用户画像的链接）。
  doneConditions.push(...userConditions);
  // 北极星对齐（差距大的维度，提示这件事应推动它）。
  if (params.goalGap && typeof params.goalGap.gap === "number") {
    const dim = params.goalGap.topDimension ? `（最大差距维度：${params.goalGap.topDimension}）` : "";
    doneConditions.push(`推进结果应缩小与北极星目标的差距${dim}`);
  }

  return {
    goal,
    doneConditions,
    verifyHint: "用一条退出码 0 = 真完成的客观命令，或多断言结构化验证来结算整件事（非单步）",
    userAligned,
    createdAt: new Date().toISOString(),
  };
}

/** 据当前 WorldState 报"还差什么"。无当前态时全部计为 missing（保守）。 */
export function remainingToDone(
  dod: DefinitionOfDone,
  current: WorldState | undefined,
): { satisfied: string[]; missing: string[] } {
  const satisfied: string[] = [];
  const missing: string[] = [];
  const haystack = current ? JSON.stringify(current.snapshot ?? {}).toLowerCase() : "";
  for (const cond of dod.doneConditions) {
    if (!current) {
      missing.push(cond);
      continue;
    }
    // 轻量启发：完成条件里的关键 token 出现在当前态 → 视作已满足的客观佐证；否则待办。
    const tokens = cond.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((t) => t.length >= 2);
    const hit = tokens.length > 0 && tokens.some((t) => haystack.includes(t));
    if (hit) satisfied.push(cond);
    else missing.push(cond);
  }
  return { satisfied, missing };
}

/**
 * 语义增强版：注入 judge 且不抛 → 用语义判定哪些完成条件已满足；否则 fail-open 回退
 * 确定性 token 版 remainingToDone。永不 reject。
 * 这修掉"用 token includes 判断一件复杂事是否做完在原理上不可行"的精度缺口。
 */
export async function remainingToDoneSemantic(
  dod: DefinitionOfDone,
  current: WorldState | undefined,
  judge?: DoneJudgeLike,
): Promise<{ satisfied: string[]; missing: string[] }> {
  const fallback = remainingToDone(dod, current);
  if (!judge || !current) return fallback;
  try {
    const sem = await judge.judge({
      goal: dod.goal,
      doneConditions: dod.doneConditions,
      currentSummary: JSON.stringify(current.snapshot ?? {}).slice(0, 1200),
    });
    if (sem && Array.isArray(sem.satisfied) && Array.isArray(sem.missing)) {
      // 只采纳 judge 认定的、确属本 dod 的条件，防止幻觉引入不存在的条件。
      const known = new Set(dod.doneConditions);
      const satisfied = sem.satisfied.filter((c) => known.has(c));
      const missing = dod.doneConditions.filter((c) => !satisfied.includes(c));
      return { satisfied, missing };
    }
  } catch {
    // fail-open：语义裁判异常 → 回退 token 兜底。
  }
  return fallback;
}
