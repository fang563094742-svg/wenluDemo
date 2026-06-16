/**
 * 前额叶（Prefrontal Cortex）— 确定性决策层
 *
 * 纯 if/else 规则引擎，零 LLM 调用，完全可预测可测试。
 * 在每次呼吸前运行，决定"这次该做什么"。
 */

import type {
  InteractionState,
  PrefrontalDecision,
  PendingDelivery,
} from "./hippocampus/types.js";

// ─── 配置 ──────────────────────────────────────────────────────

/** 沉默阈值：超过此毫秒数 + 有未交付任务 → 强制汇报 */
const SILENCE_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟

/** 最小巩固间隔：至少这么多次呼吸才触发一次巩固 */
const MIN_BREATHS_BETWEEN_CONSOLIDATION = 10;

/** 连续空转次数阈值 → 跳过本次呼吸（延长间隔） */
const IDLE_SKIP_THRESHOLD = 3;

/** 用户刚说话的窗口：此毫秒内算"刚说话" */
const RECENT_USER_MSG_MS = 60_000;

// ─── 主决策函数 ─────────────────────────────────────────────────

/**
 * 前额叶决策：根据当前交互状态，确定性地决定下一步动作。
 *
 * 规则优先级（从高到低）：
 * 1. 用户刚说话但没被回复 → reply-user
 * 2. 用户消息要求旧自主目标失效 → replan-after-user
 * 3. 沉默超阈值 + 有未交付任务 → force-report
 * 4. 用户不在 + 距上次巩固够久 → consolidate
 * 5. 连续空转超阈值 → skip
 * 6. 默认 → breathe
 */
export function prefrontal(
  state: InteractionState,
  now: number = Date.now(),
  degradationLevel: number = 0
): PrefrontalDecision {
  const silentMs = getSilentDuration(state, now);
  const userRecentMs = getUserMessageAge(state, now);
  const hasPendingDeliveries = state.pendingDeliveries.some(d => !d.delivered);
  const needsImmediateReply =
    state.replanRequired &&
    userRecentMs !== null &&
    userRecentMs < RECENT_USER_MSG_MS &&
    !state.userRespondedToLastSay;

  if (needsImmediateReply) {
    return {
      action: "reply-user",
      priority: "high",
      context: `用户 ${Math.round(userRecentMs / 1000)}s 前说了话，需要先回应再重排`,
    };
  }

  if (state.replanRequired) {
    return {
      action: "replan-after-user",
      priority: "high",
      context: "用户新消息已到达，旧自主目标必须失效并重排",
    };
  }

  if (silentMs > SILENCE_THRESHOLD_MS && hasPendingDeliveries) {
    return {
      action: "force-report",
      priority: "high",
      context: `已沉默 ${Math.round(silentMs / 60000)}min，有 ${state.pendingDeliveries.filter(d => !d.delivered).length} 个待交付`,
    };
  }

  if (state.breathsSinceLastConsolidation >= MIN_BREATHS_BETWEEN_CONSOLIDATION) {
    return {
      action: "consolidate",
      priority: "low",
      context: `已过 ${state.breathsSinceLastConsolidation} 次呼吸未整理`,
    };
  }

  if (state.consecutiveIdleBreaths >= IDLE_SKIP_THRESHOLD && degradationLevel < 1) {
    return {
      action: "skip",
      priority: "low",
      context: `连续 ${state.consecutiveIdleBreaths} 次空转，延长间隔`,
    };
  }

  return { action: "breathe" };
}

export function updateInteractionState(
  state: InteractionState,
  _now: number = Date.now()
): void {
  state.breathsSinceLastConsolidation++;
}

export function onSayToUser(
  state: InteractionState,
  text: string,
  now: number = Date.now()
): void {
  state.lastSayTime = new Date(now).toISOString();
  state.lastSayTopic = text.slice(0, 50);
  state.consecutiveIdleBreaths = 0;
  state.userRespondedToLastSay = false;
}

export function onUserMessage(
  state: InteractionState,
  now: number = Date.now()
): void {
  state.lastUserMessageTime = new Date(now).toISOString();
  state.userRespondedToLastSay = false;
  state.consecutiveIdleBreaths = 0;
  state.replanRequired = true;
}

export function onTaskComplete(
  state: InteractionState,
  taskId: string,
  summary: string,
  now: number = Date.now()
): void {
  state.pendingDeliveries.push({
    taskId,
    completedAt: new Date(now).toISOString(),
    summary,
    delivered: false,
  });
}

export function markAllDelivered(state: InteractionState): void {
  for (const d of state.pendingDeliveries) {
    d.delivered = true;
  }
}

export function onConsolidationDone(state: InteractionState): void {
  state.breathsSinceLastConsolidation = 0;
}

export function onIdleBreath(state: InteractionState): void {
  state.consecutiveIdleBreaths++;
}

export function onActiveBreath(state: InteractionState): void {
  state.consecutiveIdleBreaths = 0;
}

export function onReplanHandled(
  state: InteractionState,
  sentNewDirectionReply: boolean = false
): void {
  state.replanRequired = !sentNewDirectionReply;
}

export function buildProgressReport(pendingDeliveries: PendingDelivery[]): string {
  const undelivered = pendingDeliveries.filter(d => !d.delivered);
  if (undelivered.length === 0) return "暂无待汇报进展。";
  return undelivered
    .slice(-5)
    .map(d => `- ${d.summary}`)
    .join("\n");
}

export function createInteractionState(): InteractionState {
  return {
    lastUserMessageTime: null,
    lastSayTime: null,
    lastSayTopic: null,
    userRespondedToLastSay: true,
    replanRequired: false,
    pendingDeliveries: [],
    breathsSinceLastConsolidation: 0,
    consecutiveIdleBreaths: 0,
  };
}

function getSilentDuration(state: InteractionState, now: number): number {
  const lastSay = parseIsoMs(state.lastSayTime);
  if (lastSay === null) return Number.POSITIVE_INFINITY;
  return now - lastSay;
}

function getUserMessageAge(state: InteractionState, now: number): number | null {
  const lastUser = parseIsoMs(state.lastUserMessageTime);
  if (lastUser === null) return null;
  return now - lastUser;
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
