/**
 * 频道与上下文隔离 · 系统频道定义（channel-config.ts）
 * ------------------------------------------------------------------
 * 两个单例系统频道（decisions/notifications）+ 默认用户频道。
 * ensureSystemChannels 幂等补齐——保证任何时刻系统频道各恰一（Property 12）。
 * _Requirements: 2.1, 2.4_
 */

import {
  type Channel,
  type ChannelKind,
  DECISIONS_CHANNEL_ID,
  NOTIFICATIONS_CHANNEL_ID,
  DEFAULT_USER_CHANNEL_ID,
} from "./channel-types.js";

export interface SystemChannelDef {
  id: string;
  title: string;
  kind: ChannelKind;
  origin: "system";
}

export const SYSTEM_CHANNELS: ReadonlyArray<SystemChannelDef> = [
  { id: DECISIONS_CHANNEL_ID, title: "待你裁决", kind: "decisions", origin: "system" },
  { id: NOTIFICATIONS_CHANNEL_ID, title: "通知", kind: "notifications", origin: "system" },
];

function makeSystemChannel(def: SystemChannelDef, now: string): Channel {
  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    origin: "system",
    messages: [],
    lastReadMessageId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 默认用户频道（迁移裸 conversation 的落点）。 */
export function defaultUserChannel(now: string = new Date().toISOString()): Channel {
  return {
    id: DEFAULT_USER_CHANNEL_ID,
    title: "主对话",
    kind: "user-chat",
    origin: "user",
    messages: [],
    lastReadMessageId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 幂等补齐两个系统频道。已存在的不动（保留其 messages/cursor），缺失的补建。
 * 不修改入参，返回新数组。
 */
export function ensureSystemChannels(channels: Channel[], now: string = new Date().toISOString()): Channel[] {
  const base = Array.isArray(channels) ? [...channels] : [];
  for (const def of SYSTEM_CHANNELS) {
    if (!base.find((c) => c.id === def.id)) {
      base.push(makeSystemChannel(def, now));
    }
  }
  return base;
}
