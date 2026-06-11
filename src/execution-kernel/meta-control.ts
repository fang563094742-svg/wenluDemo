/**
 * 持续执行内核 · Component 5：MetaControl 注意力对齐
 * ------------------------------------------------------------------
 * 定期回看"我现在投入的事 vs 北极星最大差距"，对不上就产出一个"注意力重定向"建议，
 * 指向最大差距处。闭合此前悬空的"反思→行为"回路。
 *
 * 联动（不做孤岛）：复用既有 goalMonitor 差距 + reflect 元判断，不重造引擎。
 * 红线：只产出建议（赋能），绝不作为强制闸门粗暴杀死正在推进的任务（非限制）。
 * _Requirements: 5.1-5.7_
 */

import { type GoalGapReadLike, type ReflectionReadLike } from "./types.js";

/**
 * 纯函数：据当前任务目标 + 北极星差距 + 反思元判断，给出注意力重定向建议。
 * 触发重定向的条件（任一）：
 *  - 反思层 shrinkSignal=false（说明在原地打转 / 没在缩小差距）且存在明确 goalFocus；
 *  - 北极星差距很大（gap 高）且当前任务目标与 topDimension 明显不相关。
 * 只返回建议，无副作用。
 */
export function suggestAttentionRedirect(params: {
  currentTaskGoal: string;
  goalGap?: GoalGapReadLike;
  reflection?: ReflectionReadLike;
}): { redirect: boolean; towards?: string; reason: string } {
  const goal = (params.currentTaskGoal ?? "").trim().toLowerCase();
  const refl = params.reflection;
  const gap = params.goalGap;

  // 信号 1：反思判定在打转（shrinkSignal=false）且给了聚焦方向。
  if (refl && refl.shrinkSignal === false && refl.goalFocus && refl.goalFocus.trim()) {
    const focus = refl.goalFocus.trim();
    const focusHit = goal.length > 0 && focus.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).some((t) => t.length >= 2 && goal.includes(t));
    if (!focusHit) {
      return {
        redirect: true,
        towards: focus,
        reason: `反思判定未在缩小差距(shrinkSignal=false)，当前任务与聚焦方向「${focus}」不匹配`,
      };
    }
  }

  // 信号 2：差距很大且当前任务与最大差距维度不相关。
  if (gap && typeof gap.gap === "number" && gap.gap >= 50 && gap.topDimension) {
    const dim = gap.topDimension.toLowerCase();
    const dimHit = goal.length > 0 && dim.split(/[^a-z0-9\u4e00-\u9fa5]+/).some((t) => t.length >= 2 && goal.includes(t));
    if (!dimHit) {
      return {
        redirect: true,
        towards: gap.topDimension,
        reason: `北极星差距大(${gap.gap})，当前任务与最大差距维度「${gap.topDimension}」不相关`,
      };
    }
  }

  return { redirect: false, reason: "当前投入与北极星对齐，无需重定向" };
}

/** 类封装。 */
export class MetaControl {
  suggestRedirect(params: Parameters<typeof suggestAttentionRedirect>[0]) {
    return suggestAttentionRedirect(params);
  }
}
