/**
 * 频道与上下文隔离 · 消息路由（message-router.ts）
 * ------------------------------------------------------------------
 * 分类判据落地（确定、纯函数，Property 7）：
 *  - 阻塞裁决（kind=decision）→ decisions 频道
 *  - 非阻塞告知（kind=notice）→ notifications 频道
 *  - 用户对话/弟弟对用户的回复（kind=user/wenlu）→ 当前用户频道（缺省 chat_default）
 * 判据在消息产生点静态确定（kind 即语义），运行时不猜。
 * _Requirements: 2.2, 2.3, 2.5_
 */

import {
  type MessageKind,
  type MessageSource,
  DECISIONS_CHANNEL_ID,
  NOTIFICATIONS_CHANNEL_ID,
  REFLECT_CHANNEL_ID,
  DEFAULT_USER_CHANNEL_ID,
} from "./channel-types.js";

export interface RouteInput {
  kind: MessageKind;
  source: MessageSource;
  /** 用户对话归属的频道；缺省落 chat_default。 */
  currentUserChannelId?: string;
}

/** 纯函数：根据消息种类确定目标频道 id。异常输入 fail-open 落 notifications（不丢消息）。 */
export function routeMessage(input: RouteInput): string {
  try {
    switch (input.kind) {
      case "decision":
        return DECISIONS_CHANNEL_ID;
      case "notice":
        return input.source === "reflect" ? REFLECT_CHANNEL_ID : NOTIFICATIONS_CHANNEL_ID;
      case "user":
      case "wenlu":
        return input.currentUserChannelId && input.currentUserChannelId.trim()
          ? input.currentUserChannelId
          : DEFAULT_USER_CHANNEL_ID;
      default:
        // 未知种类：保守落通知，不丢。
        return NOTIFICATIONS_CHANNEL_ID;
    }
  } catch {
    return NOTIFICATIONS_CHANNEL_ID;
  }
}
