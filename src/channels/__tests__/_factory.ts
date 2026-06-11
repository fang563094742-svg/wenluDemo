/**
 * 测试工厂：构造 Message / Channel。
 */
import { type Message, type Channel, type MessageKind, type MessageSource, newMessageId } from "../channel-types.js";

export function mkMsg(over: Partial<Message> = {}): Message {
  const base: Message = {
    id: over.id ?? newMessageId(),
    channelId: over.channelId ?? "chat_default",
    kind: (over.kind ?? "user") as MessageKind,
    source: (over.source ?? "chat") as MessageSource,
    role: over.role ?? "user",
    text: over.text ?? "hello",
    time: over.time ?? new Date().toISOString(),
    decisionId: over.decisionId,
  };
  return base;
}

export function mkChannel(over: Partial<Channel> = {}): Channel {
  const now = new Date().toISOString();
  return {
    id: over.id ?? "chat_test",
    title: over.title ?? "测试频道",
    kind: over.kind ?? "user-chat",
    origin: over.origin ?? "user",
    messages: over.messages ?? [],
    lastReadMessageId: over.lastReadMessageId ?? null,
    archived: over.archived ?? false,
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  };
}
