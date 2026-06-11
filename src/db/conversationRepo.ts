/**
 * 问路 — ConversationRepo：对话历史权威表（按 user_id + channel_id 隔离，append-only）。
 *
 * 大脑对话从 mind JSONB 移出到 conversation_message 表，作为该数据的唯一事实源；
 * 大脑取上下文 = recent(limit)，前端历史 = history(beforeId)。所有读写经 withUser → RLS。
 */

import { withUser } from "./pool.js";

export type ConvRole = "user" | "wenlu" | "system";

export interface ConvMessage {
  id: number;
  user_id: string;
  channel_id: string;
  role: ConvRole;
  text: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** 追加一条消息。 */
export async function appendMessage(
  userId: string,
  channelId: string,
  role: ConvRole,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<ConvMessage> {
  return withUser(userId, async (client) => {
    const r = await client.query<ConvMessage>(
      `INSERT INTO conversation_message (user_id, channel_id, role, text, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, channelId, role, text, JSON.stringify(metadata ?? {})],
    );
    return r.rows[0];
  });
}

/** 取某频道最近 N 条（按时间倒序取出后，返回时间正序，供大脑上下文）。 */
export async function recentMessages(
  userId: string,
  channelId: string,
  limit: number,
): Promise<ConvMessage[]> {
  return withUser(userId, async (client) => {
    const r = await client.query<ConvMessage>(
      `SELECT * FROM conversation_message
       WHERE user_id = $1 AND channel_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [userId, channelId, limit],
    );
    return r.rows.reverse();
  });
}

/** 历史翻页：取某频道在 beforeId 之前的较旧消息（时间正序返回）。 */
export async function historyMessages(
  userId: string,
  channelId: string,
  beforeId?: number,
  limit = 100,
): Promise<ConvMessage[]> {
  return withUser(userId, async (client) => {
    if (beforeId != null) {
      const r = await client.query<ConvMessage>(
        `SELECT * FROM conversation_message
         WHERE user_id = $1 AND channel_id = $2 AND id < $3
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [userId, channelId, beforeId, limit],
      );
      return r.rows.reverse();
    }
    const r = await client.query<ConvMessage>(
      `SELECT * FROM conversation_message
       WHERE user_id = $1 AND channel_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [userId, channelId, limit],
    );
    return r.rows.reverse();
  });
}
