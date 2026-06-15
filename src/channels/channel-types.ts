/**
 * 频道与上下文隔离 · 锁定 Schema（channel-types.ts）
 * ------------------------------------------------------------------
 * 第一刀（模型补硬）：钉死全局认知层与频道层的边界。
 *  - 全局河床认知层（riverbed/beliefs/userModel/goal）不属于任何频道，跨频道共享。
 *  - 频道 = 1 notifications + 1 decisions + N user-chat。
 *  - Message 补 id/channelId/kind/source/decisionId；Channel 补 lastReadMessageId(read cursor)；
 *    PendingDecision 补 messageId；schemaVersion 作迁移闸。
 * 纯类型 + id 生成（node:crypto）。不反向 import riverMain、不碰 3.1/3.2。
 * _Requirements: 锁定模型, 1.3_
 */

import { randomUUID } from "node:crypto";

/** 持久结构版本号：缺省 0=旧（单流），迁移后置为此值。 */
export const CHANNELS_SCHEMA_VERSION = 1;

/** 固定系统频道 id（单例）。 */
export const DECISIONS_CHANNEL_ID = "decisions";
export const NOTIFICATIONS_CHANNEL_ID = "notifications";
/** 反思/回流专用频道 id。本地未提交代码引入，从删除前（06-15 16:26）缓存恢复。 */
export const REFLECT_CHANNEL_ID = "reflect";
/** 默认迁移目标用户频道 id。 */
export const DEFAULT_USER_CHANNEL_ID = "chat_default";

/** 消息种类：user/wenlu 对话；decision 裁决；notice 通知。 */
export type MessageKind = "user" | "wenlu" | "decision" | "notice";

/** 来源标签（原顶层分类降维成 tag）。 */
export type MessageSource = "reflect" | "debt" | "event" | "task" | "calibration" | "chat" | "system";

/** 频道种类。 */
export type ChannelKind = "decisions" | "notifications" | "user-chat";

/** 裁决状态。 */
export type DecisionStatus = "pending" | "resolved" | "expired";

/** 一条消息（事实主键 id）。 */
export interface Message {
  id: string;
  channelId: string;
  kind: MessageKind;
  source: MessageSource;
  role: "user" | "wenlu";
  text: string;
  time: string;
  /** kind==="decision" 时关联 PendingDecision.id。 */
  decisionId?: string;
}

/** 一个频道。未读由 lastReadMessageId 派生，不存计数。 */
export interface Channel {
  id: string;
  title: string;
  kind: ChannelKind;
  origin: "user" | "system";
  messages: Message[];
  /** read cursor：未读 = 此 id 之后的消息；null 表示全未读。 */
  lastReadMessageId: string | null;
  /** user-chat 软删标记；系统频道恒 false。 */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 待裁决持久状态项（与承载它的 Message 双向定位）。 */
export interface PendingDecision {
  id: string;
  channelId: string;
  messageId: string;
  question: string;
  options: string[];
  multi: boolean;
  status: DecisionStatus;
  resolvedChoice?: string[];
  createdAt: string;
  resolvedAt?: string;
  /** 发起裁决的来源频道（多用户隔离用）。本地未提交代码引入，从删除前缓存恢复。 */
  originChannelId?: string;
  /** 发起裁决的来源消息 id。本地未提交代码引入，从删除前缓存恢复。 */
  originMessageId?: string;
  /** 结算时回填的回流频道 id（= originChannelId）。本地未提交代码引入，从删除前缓存恢复。 */
  reflowChannelId?: string;
  /** 结算时回填的回流消息 id（= originMessageId）。本地未提交代码引入，从删除前缓存恢复。 */
  reflowMessageId?: string;
}

/** 挂在 Mind 上的频道层增量（认知层不在此，全局共享）。 */
export interface MindChannelsPart {
  schemaVersion?: number;
  channels?: Channel[];
  pendingDecisions?: PendingDecision[];
  /** legacy 单流，迁移后冻结只读。 */
  conversation?: Array<{ role: "user" | "wenlu"; text: string; time: string }>;
}

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function newChannelId(): string {
  return `chat_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function newDecisionId(): string {
  return `dec_${randomUUID()}`;
}
