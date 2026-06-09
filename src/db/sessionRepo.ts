/**
 * 问路 — 会话 + 消息 CRUD。
 */

import { query } from "./pool.js";

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  user_id: string;
  title: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** 创建新会话。 */
export async function createSession(userId: string, title?: string): Promise<Session> {
  const result = await query<Session>(
    `INSERT INTO sessions (user_id, title) VALUES ($1, $2) RETURNING *`,
    [userId, title ?? null],
  );
  return result.rows[0];
}

/** 获取用户的活跃会话列表（最新在前）。 */
export async function listUserSessions(userId: string, limit = 20): Promise<Session[]> {
  const result = await query<Session>(
    `SELECT * FROM sessions
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

/** 按 ID 获取会话（含权限校验用 user_id）。 */
export async function getSession(sessionId: string, userId: string): Promise<Session | null> {
  const result = await query<Session>(
    "SELECT * FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  return result.rows[0] ?? null;
}

/** 更新会话标题。 */
export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await query(
    "UPDATE sessions SET title = $1, updated_at = NOW() WHERE id = $2",
    [title, sessionId],
  );
}

/** 软删除会话。 */
export async function archiveSession(sessionId: string): Promise<void> {
  await query(
    "UPDATE sessions SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
    [sessionId],
  );
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  session_id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** 保存消息。 */
export async function saveMessage(
  sessionId: string,
  userId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown>,
): Promise<Message> {
  const result = await query<Message>(
    `INSERT INTO messages (session_id, user_id, role, content, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [sessionId, userId, role, content, JSON.stringify(metadata ?? {})],
  );
  // 同时更新会话的 updated_at
  await query("UPDATE sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
  return result.rows[0];
}

/** 获取会话的消息列表（时间正序）。 */
export async function getSessionMessages(
  sessionId: string,
  limit = 100,
  beforeId?: string,
): Promise<Message[]> {
  if (beforeId) {
    const result = await query<Message>(
      `SELECT * FROM messages
       WHERE session_id = $1 AND created_at < (SELECT created_at FROM messages WHERE id = $2)
       ORDER BY created_at ASC
       LIMIT $3`,
      [sessionId, beforeId, limit],
    );
    return result.rows;
  }
  const result = await query<Message>(
    `SELECT * FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [sessionId, limit],
  );
  return result.rows;
}

/** 统计用户今日消息数（用于配额检查）。 */
export async function countUserMessagesToday(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM messages
     WHERE user_id = $1 AND role = 'user'
     AND created_at >= CURRENT_DATE`,
    [userId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}
