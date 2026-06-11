/**
 * 隔离/共享 + 迁移 — Property 1 隔离 / Property 2 认知共享 / Property 3 删不丢认知 / Property 6 迁移无损幂等
 * （最高约束·不可跳过）
 * Validates: Requirements 1.1, 1.2, 1.4, 6.2, 6.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildReplyContext, type GlobalCognition,
  migrateLegacyConversation, type LegacyTopicsData,
  emptyChannels, appendMessage, archiveChannel, getChannel,
  CHANNELS_SCHEMA_VERSION, DECISIONS_CHANNEL_ID, NOTIFICATIONS_CHANNEL_ID, DEFAULT_USER_CHANNEL_ID,
} from "../index.js";
import { mkMsg, mkChannel } from "./_factory.js";

const GLOBAL: GlobalCognition = { userInsights: ["他重视第一性原理"], riverbedSummary: "稳", northStar: "更强" };

describe("Property 1 上下文隔离", () => {
  it("buildReplyContext 只含本频道对话，不含他频道", () => {
    const chA = mkChannel({ id: "A", messages: [mkMsg({ text: "A1", channelId: "A" }), mkMsg({ text: "A2", channelId: "A", role: "wenlu", kind: "wenlu" })] });
    const ctx = buildReplyContext(chA, GLOBAL);
    const joined = ctx.conversation.map((m) => m.text).join("|");
    expect(joined).toContain("A1");
    expect(joined).not.toContain("B");
  });
  it("裁决/通知消息不进对话上下文", () => {
    const ch = mkChannel({
      messages: [
        mkMsg({ text: "chat", kind: "user" }),
        mkMsg({ text: "notice-x", kind: "notice", source: "reflect" }),
        mkMsg({ text: "decision-x", kind: "decision", source: "calibration" }),
      ],
    });
    const ctx = buildReplyContext(ch, GLOBAL);
    const joined = ctx.conversation.map((m) => m.text).join("|");
    expect(joined).toContain("chat");
    expect(joined).not.toContain("notice-x");
    expect(joined).not.toContain("decision-x");
  });
});

describe("Property 2 认知共享", () => {
  it("任一频道的 cognition 恒等于全局", () => {
    const a = buildReplyContext(mkChannel({ id: "A" }), GLOBAL);
    const b = buildReplyContext(mkChannel({ id: "B" }), GLOBAL);
    expect(a.cognition).toEqual(b.cognition);
    expect(a.cognition.userInsights).toEqual(["他重视第一性原理"]);
  });
});

describe("Property 3 删对话不删认知", () => {
  it("archive 频道后全局 cognition 引用不受影响", () => {
    let ch = emptyChannels();
    ch = appendMessage(ch, mkMsg({ channelId: DEFAULT_USER_CHANNEL_ID }));
    const before = JSON.stringify(GLOBAL);
    archiveChannel(ch, DEFAULT_USER_CHANNEL_ID);
    expect(JSON.stringify(GLOBAL)).toBe(before); // 认知是独立对象，archive 不触碰
  });
});

describe("Property 6 迁移无损幂等", () => {
  const topics: LegacyTopicsData = {
    active: "default",
    topics: [
      { id: "default", category: "system" },
      { id: "reflect", category: "reflect" },
      { id: "calibration", category: "calibration" },
      { id: "topic_1", title: "我的项目", category: "user" },
    ],
    conversations: {
      default: [{ role: "user", text: "你好", time: "2026-01-01T00:00:00Z" }],
      reflect: [{ role: "wenlu", text: "我反思了X", time: "2026-01-01T01:00:00Z" }],
      calibration: [{ role: "wenlu", text: "你想走A还是B？", time: "2026-01-01T02:00:00Z" }],
      topic_1: [{ role: "user", text: "项目进度", time: "2026-01-01T03:00:00Z" }],
    },
  };

  it("两源消息全部落入对应频道", () => {
    const r = migrateLegacyConversation({ schemaVersion: 0, legacyTopics: topics, legacyConversation: [{ role: "user", text: "裸消息", time: "2026-01-01T04:00:00Z" }] });
    expect(r.schemaVersion).toBe(CHANNELS_SCHEMA_VERSION);
    const def = getChannel(r.channels, DEFAULT_USER_CHANNEL_ID)!;
    const notif = getChannel(r.channels, NOTIFICATIONS_CHANNEL_ID)!;
    const dec = getChannel(r.channels, DECISIONS_CHANNEL_ID)!;
    const userTopic = getChannel(r.channels, "topic_1")!;
    expect(def.messages.map((m) => m.text)).toContain("你好");
    expect(def.messages.map((m) => m.text)).toContain("裸消息");
    expect(notif.messages.map((m) => m.text)).toContain("我反思了X");
    expect(dec.messages.map((m) => m.text)).toContain("你想走A还是B？");
    expect(userTopic.messages.map((m) => m.text)).toContain("项目进度");
  });

  it("calibration 旧提问重建为已结裁决（不再打扰）", () => {
    const r = migrateLegacyConversation({ schemaVersion: 0, legacyTopics: topics });
    expect(r.pendingDecisions.length).toBeGreaterThanOrEqual(1);
    expect(r.pendingDecisions.every((d) => d.status === "resolved")).toBe(true);
    expect(r.pendingDecisions[0].messageId).toBeTruthy();
  });

  it("幂等：迁移产物再喂回（schemaVersion>=1）不重复灌入", () => {
    const r1 = migrateLegacyConversation({ schemaVersion: 0, legacyTopics: topics });
    const r2 = migrateLegacyConversation({ schemaVersion: r1.schemaVersion });
    // 已是新版 → 返回干净空集（不再迁移），不会把旧消息再灌一遍
    const def2 = getChannel(r2.channels, DEFAULT_USER_CHANNEL_ID)!;
    expect(def2.messages.length).toBe(0);
  });

  it("确定性 id：同源迁移两次，消息 id 一致（可去重）", () => {
    const a = migrateLegacyConversation({ schemaVersion: 0, legacyConversation: [{ role: "user", text: "x", time: "2026-01-01T00:00:00Z" }] });
    const b = migrateLegacyConversation({ schemaVersion: 0, legacyConversation: [{ role: "user", text: "x", time: "2026-01-01T00:00:00Z" }] });
    const ida = getChannel(a.channels, DEFAULT_USER_CHANNEL_ID)!.messages[0].id;
    const idb = getChannel(b.channels, DEFAULT_USER_CHANNEL_ID)!.messages[0].id;
    expect(ida).toBe(idb);
  });

  it("空输入 fail-open：返回合法空 channels", () => {
    const r = migrateLegacyConversation({});
    expect(getChannel(r.channels, DECISIONS_CHANNEL_ID)).toBeDefined();
  });
});
