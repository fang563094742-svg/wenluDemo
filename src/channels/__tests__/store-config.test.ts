/**
 * config + store 测试 — Property 12 系统频道单例 / Property 8 不可变
 * Validates: Requirements 2.1, 2.4, 6.1
 */
import { describe, it, expect } from "vitest";
import {
  ensureSystemChannels, SYSTEM_CHANNELS, emptyChannels, getChannel,
  addUserChannel, renameChannel, archiveChannel, appendMessage,
  DECISIONS_CHANNEL_ID, NOTIFICATIONS_CHANNEL_ID, DEFAULT_USER_CHANNEL_ID,
} from "../index.js";
import { mkMsg, mkChannel } from "./_factory.js";

describe("Property 12 系统频道单例 + 幂等", () => {
  it("emptyChannels 含两系统频道 + 默认用户频道", () => {
    const ch = emptyChannels();
    expect(getChannel(ch, DECISIONS_CHANNEL_ID)).toBeDefined();
    expect(getChannel(ch, NOTIFICATIONS_CHANNEL_ID)).toBeDefined();
    expect(getChannel(ch, DEFAULT_USER_CHANNEL_ID)).toBeDefined();
  });
  it("ensureSystemChannels 幂等：两次不重复", () => {
    const once = ensureSystemChannels([]);
    const twice = ensureSystemChannels(once);
    const decCount = twice.filter((c) => c.id === DECISIONS_CHANNEL_ID).length;
    const notifCount = twice.filter((c) => c.id === NOTIFICATIONS_CHANNEL_ID).length;
    expect(decCount).toBe(1);
    expect(notifCount).toBe(1);
    expect(twice.length).toBe(once.length);
  });
  it("已存在系统频道的 messages 不被覆盖", () => {
    let ch = ensureSystemChannels([]);
    ch = appendMessage(ch, mkMsg({ channelId: NOTIFICATIONS_CHANNEL_ID, kind: "notice" }));
    const after = ensureSystemChannels(ch);
    expect(getChannel(after, NOTIFICATIONS_CHANNEL_ID)!.messages.length).toBe(1);
  });
});

describe("Property 8 store 不可变", () => {
  it("addUserChannel 不改入参", () => {
    const ch0 = emptyChannels();
    const len0 = ch0.length;
    const { channels, id } = addUserChannel(ch0, "我的新对话");
    expect(ch0.length).toBe(len0);
    expect(channels.length).toBe(len0 + 1);
    expect(getChannel(channels, id)!.kind).toBe("user-chat");
  });
  it("appendMessage 不改入参且写入目标频道", () => {
    const ch0 = emptyChannels();
    const ch1 = appendMessage(ch0, mkMsg({ channelId: DEFAULT_USER_CHANNEL_ID }));
    expect(getChannel(ch0, DEFAULT_USER_CHANNEL_ID)!.messages.length).toBe(0);
    expect(getChannel(ch1, DEFAULT_USER_CHANNEL_ID)!.messages.length).toBe(1);
  });
  it("appendMessage 目标频道不存在 → 原样返回", () => {
    const ch0 = emptyChannels();
    const ch1 = appendMessage(ch0, mkMsg({ channelId: "nonexistent" }));
    expect(ch1).toBe(ch0);
  });
  it("archiveChannel 仅 user-chat；系统频道拒绝", () => {
    const ch0 = emptyChannels();
    const archived = archiveChannel(ch0, DECISIONS_CHANNEL_ID);
    expect(getChannel(archived, DECISIONS_CHANNEL_ID)!.archived).toBe(false);
    const ua = archiveChannel(ch0, DEFAULT_USER_CHANNEL_ID);
    expect(getChannel(ua, DEFAULT_USER_CHANNEL_ID)!.archived).toBe(true);
  });
  it("renameChannel 改标题、空标题忽略", () => {
    const ch0 = emptyChannels();
    const r = renameChannel(ch0, DEFAULT_USER_CHANNEL_ID, "改名了");
    expect(getChannel(r, DEFAULT_USER_CHANNEL_ID)!.title).toBe("改名了");
    const r2 = renameChannel(ch0, DEFAULT_USER_CHANNEL_ID, "   ");
    expect(r2).toBe(ch0);
  });
});
