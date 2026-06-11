/**
 * decision-queue + read-cursor + router 测试
 * — Property 4 裁决持久 / Property 5 cursor 派生 / Property 7 路由确定 / Property 8 不可变
 * Validates: Requirements 2.5, 3.x, 4.x
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  enqueueDecision, resolveDecision, pendingCount, pendingForChannel,
  unreadMessages, unreadCount, advanceCursor, markChannelRead, decisionsBadge,
  routeMessage,
  DECISIONS_CHANNEL_ID, NOTIFICATIONS_CHANNEL_ID, DEFAULT_USER_CHANNEL_ID,
  type PendingDecision,
} from "../index.js";
import { mkMsg, mkChannel } from "./_factory.js";

function mkDec(id: string, over: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id, channelId: DECISIONS_CHANNEL_ID, messageId: `m_${id}`,
    question: "q?", options: ["a", "b"], multi: false, status: "pending",
    createdAt: new Date().toISOString(), ...over,
  };
}

describe("Property 4 待裁决持久状态", () => {
  it("enqueue 幂等：同 id 不重复", () => {
    const q = enqueueDecision(enqueueDecision([], mkDec("d1")), mkDec("d1"));
    expect(q.length).toBe(1);
  });
  it("resolve 置 resolved 记录选择，不改入参", () => {
    const q0 = enqueueDecision([], mkDec("d1"));
    const q1 = resolveDecision(q0, "d1", ["a"]);
    expect(q0[0].status).toBe("pending");
    expect(q1[0].status).toBe("resolved");
    expect(q1[0].resolvedChoice).toEqual(["a"]);
  });
  it("pendingCount/badge 只数 pending", () => {
    let q = enqueueDecision([], mkDec("d1"));
    q = enqueueDecision(q, mkDec("d2"));
    q = resolveDecision(q, "d1", ["a"]);
    expect(pendingCount(q)).toBe(1);
    expect(decisionsBadge(q)).toBe(1);
  });
  it("pendingForChannel 过滤频道", () => {
    let q = enqueueDecision([], mkDec("d1", { channelId: DECISIONS_CHANNEL_ID }));
    q = enqueueDecision(q, mkDec("d2", { channelId: "other" }));
    expect(pendingForChannel(q, DECISIONS_CHANNEL_ID).length).toBe(1);
  });
});

describe("Property 5 read cursor 派生", () => {
  it("cursor=null ⟹ 全未读", () => {
    const ch = mkChannel({ messages: [mkMsg({ id: "m1" }), mkMsg({ id: "m2" })], lastReadMessageId: null });
    expect(unreadCount(ch)).toBe(2);
  });
  it("cursor 指向最新 ⟹ 未读 0", () => {
    const ch = mkChannel({ messages: [mkMsg({ id: "m1" }), mkMsg({ id: "m2" })], lastReadMessageId: "m2" });
    expect(unreadCount(ch)).toBe(0);
  });
  it("advanceCursor 后未读归零；不改入参", () => {
    const ch = mkChannel({ messages: [mkMsg({ id: "m1" }), mkMsg({ id: "m2" })], lastReadMessageId: null });
    const ch2 = markChannelRead(ch);
    expect(unreadCount(ch)).toBe(2);
    expect(unreadCount(ch2)).toBe(0);
  });
  it("cursor 指向已裁剪的 id ⟹ 保守全未读", () => {
    const ch = mkChannel({ messages: [mkMsg({ id: "m2" })], lastReadMessageId: "m1_gone" });
    expect(unreadCount(ch)).toBe(1);
  });
  it("advanceCursor 到不存在的 id 原样返回", () => {
    const ch = mkChannel({ messages: [mkMsg({ id: "m1" })], lastReadMessageId: null });
    expect(advanceCursor(ch, "nope")).toBe(ch);
  });
});

describe("Property 7 路由确定", () => {
  it("decision→decisions / notice→notifications", () => {
    expect(routeMessage({ kind: "decision", source: "calibration" })).toBe(DECISIONS_CHANNEL_ID);
    expect(routeMessage({ kind: "notice", source: "reflect" })).toBe(NOTIFICATIONS_CHANNEL_ID);
  });
  it("user/wenlu → 当前用户频道，缺省 chat_default", () => {
    expect(routeMessage({ kind: "user", source: "chat" })).toBe(DEFAULT_USER_CHANNEL_ID);
    expect(routeMessage({ kind: "wenlu", source: "chat", currentUserChannelId: "chat_x" })).toBe("chat_x");
  });
  it("任意 kind 恒返回三频道之一（不变量）", () => {
    fc.assert(fc.property(
      fc.constantFrom("user", "wenlu", "decision", "notice"),
      fc.constantFrom("reflect", "debt", "event", "task", "calibration", "chat", "system"),
      (kind, source) => {
        const r = routeMessage({ kind: kind as never, source: source as never });
        expect([DECISIONS_CHANNEL_ID, NOTIFICATIONS_CHANNEL_ID, DEFAULT_USER_CHANNEL_ID]).toContain(r);
      },
    ));
  });
});
