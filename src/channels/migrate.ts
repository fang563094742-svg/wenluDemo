/**
 * 频道与上下文隔离 · 迁移器（migrate.ts）
 * ------------------------------------------------------------------
 * 同时吃两个旧源：mind.conversation（单流）+ topics.json（旧频道存储），无损落入新 channels。
 * 幂等（Property 6）：schemaVersion>=1 直接原样；旧消息补确定性 id（基于 channelId+time+index 哈希），
 * 重复运行不重复灌入、不丢失。
 * 规则：
 *  - topics.json 的 calibration 频道里的提问 → decisions 频道 + 重建 PendingDecision。
 *  - topics.json 的 reflect/debt/event → notifications 频道（带 source tag）。
 *  - topics.json 的 default/user 频道 → user-chat（default→chat_default）。
 *  - 裸 mind.conversation（无 topics）→ chat_default。
 * _Requirements: 6.2, 6.3, 6.4_
 */

import { createHash } from "node:crypto";
import {
  type Channel,
  type Message,
  type MessageKind,
  type MessageSource,
  type PendingDecision,
  CHANNELS_SCHEMA_VERSION,
  DECISIONS_CHANNEL_ID,
  NOTIFICATIONS_CHANNEL_ID,
  DEFAULT_USER_CHANNEL_ID,
} from "./channel-types.js";
import { emptyChannels } from "./channel-store.js";
import { ensureSystemChannels, defaultUserChannel } from "./channel-config.js";

type LegacyMsg = { role: "user" | "wenlu"; text: string; time: string };

export interface LegacyTopicsData {
  active?: string;
  topics?: Array<{ id: string; title?: string; category?: string }>;
  conversations?: Record<string, LegacyMsg[]>;
}

export interface MigrateInput {
  schemaVersion?: number;
  legacyConversation?: LegacyMsg[];
  legacyTopics?: LegacyTopicsData | null;
}

export interface MigrateResult {
  channels: Channel[];
  pendingDecisions: PendingDecision[];
  schemaVersion: number;
}

/** 确定性 id：同输入恒同输出，保证幂等不重复灌入。 */
function deterministicMsgId(channelId: string, time: string, index: number, text: string): string {
  const h = createHash("sha1").update(`${channelId}|${time}|${index}|${text}`).digest("hex").slice(0, 16);
  return `msg_mig_${h}`;
}

/** 旧 topics category → 新频道 id + 消息 kind/source。 */
function mapLegacyChannel(topicId: string, category: string | undefined): {
  channelId: string;
  kind: MessageKind;
  source: MessageSource;
} {
  const cat = category ?? (topicId === "default" ? "system" : "user");
  switch (cat) {
    case "calibration":
      return { channelId: DECISIONS_CHANNEL_ID, kind: "decision", source: "calibration" };
    case "reflect":
      return { channelId: NOTIFICATIONS_CHANNEL_ID, kind: "notice", source: "reflect" };
    case "debt":
      return { channelId: NOTIFICATIONS_CHANNEL_ID, kind: "notice", source: "debt" };
    case "event":
      return { channelId: NOTIFICATIONS_CHANNEL_ID, kind: "notice", source: "event" };
    case "system":
      // 旧 default 共享上下文 → 默认用户频道（对话类，按 role 定 kind）
      return { channelId: DEFAULT_USER_CHANNEL_ID, kind: "user", source: "chat" };
    default:
      // 用户自建话题 → 保留其 id 作 user-chat
      return { channelId: topicId, kind: "user" as MessageKind, source: "chat" };
  }
}

function legacyMsgToMessage(
  m: LegacyMsg,
  channelId: string,
  fallbackKind: MessageKind,
  source: MessageSource,
  index: number,
): Message {
  // 对话消息按 role 定 kind；通知/裁决按映射定 kind。
  let kind: MessageKind = fallbackKind;
  if (fallbackKind === "user" || fallbackKind === "wenlu") {
    kind = m.role === "user" ? "user" : "wenlu";
  }
  return {
    id: deterministicMsgId(channelId, m.time ?? "", index, m.text ?? ""),
    channelId,
    kind,
    source,
    role: m.role,
    text: m.text ?? "",
    time: m.time ?? new Date().toISOString(),
  };
}

/**
 * 迁移主函数。幂等无损。
 */
export function migrateLegacyConversation(input: MigrateInput): MigrateResult {
  try {
    // 已是新版：不重复迁移。
    if ((input.schemaVersion ?? 0) >= CHANNELS_SCHEMA_VERSION) {
      return { channels: emptyChannels(), pendingDecisions: [], schemaVersion: CHANNELS_SCHEMA_VERSION };
    }

    const now = new Date().toISOString();
    let channels: Channel[] = ensureSystemChannels([defaultUserChannel(now)], now);
    const pendingDecisions: PendingDecision[] = [];

    const ensureUserChannel = (id: string, title: string) => {
      if (!channels.find((c) => c.id === id)) {
        channels.push({
          id,
          title: title || "对话",
          kind: "user-chat",
          origin: "user",
          messages: [],
          lastReadMessageId: null,
          archived: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    };

    const pushMsg = (msg: Message) => {
      channels = channels.map((c) =>
        c.id === msg.channelId
          ? (c.messages.find((x) => x.id === msg.id) ? c : { ...c, messages: [...c.messages, msg], updatedAt: msg.time })
          : c,
      );
    };

    // ── 源1：topics.json ──
    const topics = input.legacyTopics;
    if (topics?.conversations) {
      const topicMeta = new Map((topics.topics ?? []).map((t) => [t.id, t]));
      for (const [topicId, msgs] of Object.entries(topics.conversations)) {
        const meta = topicMeta.get(topicId);
        const map = mapLegacyChannel(topicId, meta?.category);
        if (map.channelId !== DECISIONS_CHANNEL_ID && map.channelId !== NOTIFICATIONS_CHANNEL_ID && map.channelId !== DEFAULT_USER_CHANNEL_ID) {
          ensureUserChannel(map.channelId, meta?.title ?? "对话");
        }
        (msgs ?? []).forEach((m, i) => {
          const msg = legacyMsgToMessage(m, map.channelId, map.kind, map.source, i);
          // calibration 旧提问 → 重建 PendingDecision（已 resolved，因历史无从知选择）。
          if (map.channelId === DECISIONS_CHANNEL_ID && m.role === "wenlu") {
            const decId = `dec_mig_${msg.id}`;
            msg.kind = "decision";
            msg.decisionId = decId;
            pendingDecisions.push({
              id: decId,
              channelId: DECISIONS_CHANNEL_ID,
              messageId: msg.id,
              question: m.text ?? "",
              options: [],
              multi: false,
              status: "resolved", // 历史裁决视为已结（不再打扰用户）
              createdAt: m.time ?? now,
              resolvedAt: m.time ?? now,
            });
          }
          pushMsg(msg);
        });
      }
    }

    // ── 源2：裸 mind.conversation（落 chat_default）──
    const conv = input.legacyConversation;
    if (Array.isArray(conv) && conv.length > 0) {
      conv.forEach((m, i) => {
        const msg = legacyMsgToMessage(m, DEFAULT_USER_CHANNEL_ID, "user", "chat", i);
        pushMsg(msg);
      });
    }

    return { channels, pendingDecisions, schemaVersion: CHANNELS_SCHEMA_VERSION };
  } catch {
    // fail-open：迁移异常 → 保底空 channels（旧源在 mind 中仍冻结保留，不丢）。
    return { channels: emptyChannels(), pendingDecisions: [], schemaVersion: CHANNELS_SCHEMA_VERSION };
  }
}
