/**
 * 频道与上下文隔离 · 回复上下文构造（reply-context.ts）
 * ------------------------------------------------------------------
 * 焊死"对话隔离、认知共享"：
 *  - conversation 只来自传入的单个 channel（Property 1 隔离）。
 *  - cognition 只来自全局认知层引用（Property 2 共享）。
 * 两参物理分离 + 类型不可互塞——编译期就混不了。
 * 本文件不 import 任何 riverbed/userModel 具体实现，只接收只读结构子集。
 * _Requirements: 1.1, 1.2, 1.3_
 */

import { type Channel } from "./channel-types.js";

/** 全局河床认知层只读快照（结构子集，由接线点注入；本库不绑定具体实现）。 */
export interface GlobalCognition {
  /** 对用户的核心理解（userModel 投影文本）。 */
  userInsights: string[];
  /** 河床判断摘要（可空）。 */
  riverbedSummary?: string;
  /** 北极星目标使命（可空）。 */
  northStar?: string;
}

export interface ReplyContext {
  /** 仅当前频道的对话（隔离）。 */
  conversation: Array<{ role: "user" | "wenlu"; text: string }>;
  /** 全局认知（共享）。 */
  cognition: GlobalCognition;
}

/**
 * 构造回复上下文。
 * @param channel 当前频道——只取它自己的 messages
 * @param global 全局认知——原样透传（共享）
 * @param maxTurns 取最近几条对话（缺省 12）
 */
export function buildReplyContext(
  channel: Channel,
  global: GlobalCognition,
  maxTurns: number = 12,
): ReplyContext {
  const n = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 12;
  const msgs = channel?.messages ?? [];
  // 只取对话类消息（user/wenlu），裁决/通知不进对话上下文。
  const conv = msgs
    .filter((m) => m.kind === "user" || m.kind === "wenlu")
    .slice(-n)
    .map((m) => ({ role: m.role, text: m.text }));
  return {
    conversation: conv,
    cognition: {
      userInsights: [...(global?.userInsights ?? [])],
      riverbedSummary: global?.riverbedSummary,
      northStar: global?.northStar,
    },
  };
}
