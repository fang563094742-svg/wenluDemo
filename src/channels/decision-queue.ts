/**
 * 频道与上下文隔离 · 待裁决状态队列（decision-queue.ts）
 * ------------------------------------------------------------------
 * 待裁决建模为持久状态（非瞬时事件）：刷新/重连可从队列完整重建（Property 4）。
 * 全不可变。resolveDecision 是专用裁决变更，绝不复用 say 路径。
 * _Requirements: 3.1, 3.2, 3.3_
 */

import { type PendingDecision } from "./channel-types.js";

/** 入队（不可变）。同 id 已存在则不重复入（幂等）。 */
export function enqueueDecision(q: PendingDecision[], d: PendingDecision): PendingDecision[] {
  const base = q ?? [];
  if (base.find((x) => x.id === d.id)) return base;
  return [...base, d];
}

/** 结算（不可变）。把 pending 项置 resolved，记录选择与时间。已结算项不动。 */
export function resolveDecision(q: PendingDecision[], id: string, choice: string[]): PendingDecision[] {
  const now = new Date().toISOString();
  return (q ?? []).map((d) => {
    if (d.id !== id) return d;
    if (d.status !== "pending") return d;
    return {
      ...d,
      status: "resolved" as const,
      resolvedChoice: Array.isArray(choice) ? choice : [],
      resolvedAt: now,
      reflowChannelId: d.originChannelId,
      reflowMessageId: d.originMessageId,
    };
  });
}

/** 待裁决计数（= decisions 频道强红点）。 */
export function pendingCount(q: PendingDecision[]): number {
  return (q ?? []).filter((d) => d.status === "pending").length;
}

/** 某频道的待裁决项。 */
export function pendingForChannel(q: PendingDecision[], channelId: string): PendingDecision[] {
  return (q ?? []).filter((d) => d.status === "pending" && d.channelId === channelId);
}

/**
 * 过期某来源频道下的全部待裁决项（不可变）。把该来源频道发起、仍 pending 的裁决置 expired。
 * 返回新队列与过期数量。本地未提交代码引入，从删除前（06-15 16:26）缓存恢复。
 */
export function expireDecisionsForChannel(
  q: PendingDecision[],
  originChannelId: string,
): { queue: PendingDecision[]; expiredCount: number } {
  let expiredCount = 0;
  const queue = (q ?? []).map((d) => {
    if (d.status !== "pending" || d.originChannelId !== originChannelId) return d;
    expiredCount += 1;
    return { ...d, status: "expired" as const, resolvedAt: new Date().toISOString() };
  });
  return { queue, expiredCount };
}
