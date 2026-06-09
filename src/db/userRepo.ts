/**
 * 问路 — 用户表 CRUD。
 */

import { query } from "./pool.js";

export interface User {
  id: string;
  phone: string | null;
  nickname: string | null;
  avatar_url: string | null;
  wechat_openid: string | null;
  wechat_unionid: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 按手机号查找用户。 */
export async function findUserByPhone(phone: string): Promise<User | null> {
  const result = await query<User>(
    "SELECT * FROM users WHERE phone = $1",
    [phone],
  );
  return result.rows[0] ?? null;
}

/** 按 ID 查找用户。 */
export async function findUserById(id: string): Promise<User | null> {
  const result = await query<User>(
    "SELECT * FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

/** 创建用户（注册时调用，返回新用户）。 */
export async function createUser(phone: string, nickname?: string): Promise<User> {
  const result = await query<User>(
    `INSERT INTO users (phone, nickname) VALUES ($1, $2) RETURNING *`,
    [phone, nickname ?? null],
  );
  return result.rows[0];
}

/** 更新用户信息。 */
export async function updateUser(
  id: string,
  fields: { nickname?: string; avatar_url?: string },
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (fields.nickname !== undefined) {
    sets.push(`nickname = $${idx++}`);
    params.push(fields.nickname);
  }
  if (fields.avatar_url !== undefined) {
    sets.push(`avatar_url = $${idx++}`);
    params.push(fields.avatar_url);
  }
  if (sets.length === 0) return findUserById(id);

  sets.push(`updated_at = NOW()`);
  params.push(id);

  const result = await query<User>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/** 查找或创建用户（登录时：有则返回，无则注册）。 */
export async function findOrCreateUser(phone: string): Promise<User> {
  const existing = await findUserByPhone(phone);
  if (existing) return existing;
  return createUser(phone);
}

// ---------------------------------------------------------------------------
// 微信登录相关
// ---------------------------------------------------------------------------

/** 按微信 openid 查找用户。 */
export async function findUserByOpenid(openid: string): Promise<User | null> {
  const result = await query<User>(
    "SELECT * FROM users WHERE wechat_openid = $1",
    [openid],
  );
  return result.rows[0] ?? null;
}

/** 创建微信用户（无手机号场景）。 */
export async function createWechatUser(opts: {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}): Promise<User> {
  const result = await query<User>(
    `INSERT INTO users (wechat_openid, wechat_unionid, nickname, avatar_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [opts.openid, opts.unionid ?? null, opts.nickname ?? null, opts.avatarUrl ?? null],
  );
  return result.rows[0];
}

/** 微信登录：查找或创建。 */
export async function findOrCreateWechatUser(opts: {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}): Promise<{ user: User; isNew: boolean }> {
  const existing = await findUserByOpenid(opts.openid);
  if (existing) {
    // 更新昵称/头像（如果微信端改了）
    if (opts.nickname || opts.avatarUrl) {
      const updated = await updateUser(existing.id, {
        nickname: opts.nickname ?? existing.nickname ?? undefined,
        avatar_url: opts.avatarUrl ?? existing.avatar_url ?? undefined,
      });
      return { user: updated ?? existing, isNew: false };
    }
    return { user: existing, isNew: false };
  }
  const user = await createWechatUser(opts);
  return { user, isNew: true };
}
