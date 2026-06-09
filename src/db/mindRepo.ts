/**
 * 问路 — 用户 mind 存储（多用户隔离版）。
 */

import { query } from "./pool.js";

export interface UserMind {
  id: string;
  user_id: string;
  mind_data: Record<string, unknown>;
  updated_at: Date;
}

/** 获取用户的 mind 数据。 */
export async function getUserMind(userId: string): Promise<Record<string, unknown> | null> {
  const result = await query<UserMind>(
    "SELECT * FROM user_minds WHERE user_id = $1",
    [userId],
  );
  if (!result.rows[0]) return null;
  return result.rows[0].mind_data;
}

/** 保存/更新用户的 mind 数据（upsert）。 */
export async function saveUserMind(
  userId: string,
  mindData: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO user_minds (user_id, mind_data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       mind_data = $2,
       updated_at = NOW()`,
    [userId, JSON.stringify(mindData)],
  );
}
