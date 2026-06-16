/**
 * 频道与上下文隔离 · barrel（index.ts）
 * ------------------------------------------------------------------
 * 对外唯一入口。全局认知层不属于频道；频道层负责对话隔离 + 待裁决队列 + read cursor。
 * 纯函数库，不反向 import riverMain、不碰 3.1/3.2。
 * _Requirements: 9.1_
 */

// 类型 + id
export {
  type MessageKind,
  type MessageSource,
  type ChannelKind,
  type DecisionStatus,
  type Message,
  type Channel,
  type PendingDecision,
  type MindChannelsPart,
  CHANNELS_SCHEMA_VERSION,
  DECISIONS_CHANNEL_ID,
  NOTIFICATIONS_CHANNEL_ID,
  REFLECT_CHANNEL_ID,
  DEFAULT_USER_CHANNEL_ID,
  newMessageId,
  newChannelId,
  newDecisionId,
} from "./channel-types.js";

// 系统频道配置
export {
  type SystemChannelDef,
  SYSTEM_CHANNELS,
  defaultUserChannel,
  ensureSystemChannels,
} from "./channel-config.js";

// 不可变存储
export {
  emptyChannels,
  getChannel,
  addUserChannel,
  renameChannel,
  archiveChannel,
  appendMessage,
} from "./channel-store.js";

// 待裁决队列
export {
  enqueueDecision,
  resolveDecision,
  expireDecisionsForChannel,
  pendingCount,
  pendingForChannel,
} from "./decision-queue.js";

// read cursor
export {
  unreadMessages,
  unreadCount,
  advanceCursor,
  markChannelRead,
  decisionsBadge,
} from "./read-cursor.js";

// 路由
export {
  type RouteInput,
  routeMessage,
} from "./message-router.js";

// 回复上下文（隔离/共享焊死）
export {
  type GlobalCognition,
  type ReplyContext,
  buildReplyContext,
} from "./reply-context.js";

// 迁移
export {
  type LegacyTopicsData,
  type MigrateInput,
  type MigrateResult,
  migrateLegacyConversation,
} from "./migrate.js";
