/**
 * 频道与上下文隔离 · 不可变频道存储（channel-store.ts）
 * ------------------------------------------------------------------
 * 所有操作返回新数组/新频道，绝不原地改入参（Property 8）。
 * emptyChannels = 两系统频道 + chat_default。
 * 系统频道不可 archive / 不可 rename 为用户频道语义。
 * _Requirements: 2.4, 6.1_
 */

import {
  type Channel,
  type Message,
  newChannelId,
} from "./channel-types.js";
import { ensureSystemChannels, defaultUserChannel } from "./channel-config.js";

/** 初始频道集：两系统频道 + 默认用户频道。 */
export function emptyChannels(now: string = new Date().toISOString()): Channel[] {
  return ensureSystemChannels([defaultUserChannel(now)], now);
}

export function getChannel(channels: Channel[], id: string): Channel | undefined {
  return (channels ?? []).find((c) => c.id === id);
}

/** 新建用户频道（不可变）。返回新频道集 + 新 id。 */
export function addUserChannel(
  channels: Channel[],
  title: string,
  now: string = new Date().toISOString(),
): { channels: Channel[]; id: string } {
  const id = newChannelId();
  const ch: Channel = {
    id,
    title: (title ?? "").trim() || "新对话",
    kind: "user-chat",
    origin: "user",
    messages: [],
    lastReadMessageId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  return { channels: [...(channels ?? []), ch], id };
}

/** 重命名（不可变）。系统频道也允许改标题（仅 title）。 */
export function renameChannel(channels: Channel[], id: string, title: string): Channel[] {
  const t = (title ?? "").trim();
  if (!t) return channels;
  return (channels ?? []).map((c) =>
    c.id === id ? { ...c, title: t, updatedAt: new Date().toISOString() } : c,
  );
}

/** 软删（不可变）。仅 user-chat 可 archive；系统频道拒绝（原样返回）。 */
export function archiveChannel(channels: Channel[], id: string): Channel[] {
  return (channels ?? []).map((c) => {
    if (c.id !== id) return c;
    if (c.origin === "system" || c.kind !== "user-chat") return c; // 系统频道不可删
    return { ...c, archived: true, updatedAt: new Date().toISOString() };
  });
}

/** 追加消息到目标频道（不可变）。目标频道不存在则原样返回（fail-open，不丢入参）。 */
export function appendMessage(channels: Channel[], msg: Message): Channel[] {
  let touched = false;
  const next = (channels ?? []).map((c) => {
    if (c.id !== msg.channelId) return c;
    touched = true;
    return { ...c, messages: [...c.messages, msg], updatedAt: msg.time || new Date().toISOString() };
  });
  return touched ? next : (channels ?? []);
}
