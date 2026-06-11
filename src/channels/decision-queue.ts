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
  return (q ?? []).map((d) => {
    if (d.id !== id) return d;
    if (d.status !== "pending") return d;
    return {
      ...d,
      status: "resolved" as const,
      resolvedChoice: Array.isArray(choice) ? choice : [],
      resolvedAt: new Date().toISOString(),
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
