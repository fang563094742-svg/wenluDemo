/**
 * 持续执行内核 · Component 2：ContinuationKernel 持续脊柱
 * ------------------------------------------------------------------
 * 让任务能跨"等待"存活：做完当前能做的就挂起（waiting）+ 绑一个外部 WakeCondition，
 * 被真实世界事件唤醒后从断点续推，直到目标达成 / 止损 / 用户中止。
 *
 * 核心红线（守 E7 不空转）：库永不产出"无 WakeCondition 的自我唤醒"——wait 必带
 * WakeCondition；真正的唤醒由接线点用真实外部探针在事件满足时触发，库不自起 timer。
 *
 * 合法等待 ≠ 空转：绑定了具体 WakeCondition 的 waiting 不计入止损预算。
 * _Requirements: 2.1-2.9_
 */

import {
  type ActionOutcome,
  type TaskExecStatus,
  type WakeCondition,
  type WorkingState,
  type ContinuationDecision,
} from "./types.js";

/** 合法等待判定：状态为 waiting 且绑定了具体外部 WakeCondition。 */
export function isLegitimateWait(status: TaskExecStatus, wake?: WakeCondition): boolean {
  return status === "waiting" && !!wake && typeof wake.kind === "string" && !!wake.describe;
}

/** 一步是否"低产"（无实质推进）：unknown / no_effect 计为低产。 */
function isLowYield(outcome: ActionOutcome): boolean {
  return outcome === "no_effect" || outcome === "unknown";
}

/**
 * 纯函数：决定下一拍。优先级：
 *  1) userAbort → abort（用户中止/接管，安全停止）
 *  2) doneReached → complete（目标达成）
 *  3) pendingWake 存在 → wait（带该 WakeCondition；这是"做完当前能做的、等外部事件"）
 *  4) stepsUsed ≥ maxStepsHardCap → stop_loss（防无限循环大额保险）
 *  5) 连续低产步 ≥ stallBudget → stop_loss（投入产出过低，主动止损）
 *  6) 否则 → continue
 *
 * 不修改入参；wait 必带 WakeCondition（不自转）。
 */
export function decideContinuation(params: {
  recentOutcomes: ReadonlyArray<ActionOutcome>;
  working: WorkingState;
  doneReached: boolean;
  pendingWake?: WakeCondition;
  userAbort: boolean;
  stallBudget: number;
  stepsUsed: number;
  maxStepsHardCap: number;
}): ContinuationDecision {
  const {
    recentOutcomes,
    doneReached,
    pendingWake,
    userAbort,
    stallBudget,
    stepsUsed,
    maxStepsHardCap,
  } = params;

  if (userAbort) {
    return { next: "abort", reason: "user requested abort/takeover" };
  }
  if (doneReached) {
    return { next: "complete", reason: "definition-of-done satisfied" };
  }
  if (pendingWake) {
    return {
      next: "wait",
      wake: pendingWake,
      reason: `waiting for external event: ${pendingWake.describe}`,
    };
  }
  if (stepsUsed >= maxStepsHardCap) {
    return { next: "stop_loss", reason: `hard step cap reached (${stepsUsed}/${maxStepsHardCap})` };
  }
  // 连续低产步数（从尾部数起）
  let consecutiveLowYield = 0;
  for (let i = recentOutcomes.length - 1; i >= 0; i--) {
    if (isLowYield(recentOutcomes[i])) consecutiveLowYield++;
    else break;
  }
  if (consecutiveLowYield >= stallBudget) {
    return {
      next: "stop_loss",
      reason: `stall budget exhausted: ${consecutiveLowYield} consecutive low-yield steps (budget ${stallBudget})`,
    };
  }
  return { next: "continue", reason: "progressing" };
}

/** 类封装。 */
export class ContinuationKernel {
  decide(params: Parameters<typeof decideContinuation>[0]): ContinuationDecision {
    return decideContinuation(params);
  }
  isLegitimateWait(status: TaskExecStatus, wake?: WakeCondition): boolean {
    return isLegitimateWait(status, wake);
  }
}
