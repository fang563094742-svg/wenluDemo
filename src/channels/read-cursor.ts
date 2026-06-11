/**
 * 频道与上下文隔离 · read cursor 驱动未读（read-cursor.ts）
 * ------------------------------------------------------------------
 * 未读是派生量：= lastReadMessageId 之后的消息（Property 5）。
 * 不存独立未读计数作为事实源。advanceCursor=mark-read（移游标）。
 * _Requirements: 4.1, 4.2, 4.3_
 */

import { type Channel, type Message, type PendingDecision } from "./channel-types.js";
import { pendingCount } from "./decision-queue.js";

/** cursor 之后的未读消息。cursor 为 null ⟹ 全部未读；cursor 不在 messages 中（已被裁剪）⟹ 全部未读。 */
export function unreadMessages(ch: Channel): Message[] {
  const msgs = ch?.messages ?? [];
  const cursor = ch?.lastReadMessageId ?? null;
  if (cursor === null) return [...msgs];
  const idx = msgs.findIndex((m) => m.id === cursor);
  if (idx < 0) return [...msgs]; // 游标已被裁剪，保守视为全未读
  return msgs.slice(idx + 1);
}

/** 未读计数（派生）。 */
export function unreadCount(ch: Channel): number {
  return unreadMessages(ch).length;
}

/** 推进游标到指定消息（不可变，mark-read 语义）。messageId 不在频道内则原样返回。 */
export function advanceCursor(ch: Channel, messageId: string): Channel {
  const msgs = ch?.messages ?? [];
  if (!msgs.find((m) => m.id === messageId)) return ch;
  if (ch.lastReadMessageId === messageId) return ch;
  return { ...ch, lastReadMessageId: messageId };
}

/** 推进游标到频道最新一条（前端打开频道即清未读）。空频道原样返回。 */
export function markChannelRead(ch: Channel): Channel {
  const msgs = ch?.messages ?? [];
  if (msgs.length === 0) return ch;
  const last = msgs[msgs.length - 1];
  return advanceCursor(ch, last.id);
}

/** decisions 频道强红点 = 待裁决计数。 */
export function decisionsBadge(q: PendingDecision[]): number {
  return pendingCount(q);
}
