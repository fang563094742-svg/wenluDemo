/**
 * 问路 — 用户表 CRUD。
 */

import type pg from "pg";
import { query, type QueryResult } from "./pool.js";

export interface User {
  id: string;
  phone: string | null;
  username: string | null;
  password_hash: string | null;
  nickname: string | null;
  avatar_url: string | null;
  extra_business_message_credits: number;
  wechat_openid: string | null;
  wechat_unionid: string | null;
  invite_code: string | null;
  invited_by_user_id: string | null;
  invited_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 迁移期系统保留用户 UUID。
 *
 * 外部用户体系对接约定：
 * - 真实用户绝不能占用这个 UUID；
 * - 若未来需要保留一个系统默认用户，只能通过专门的系统初始化逻辑使用它。
 */
export const RESERVED_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type QueryExecutor = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

type Queryable = {
  query: QueryExecutor;
};

function db(executor?: Queryable): Queryable {
  return executor ?? { query };
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isReservedSystemUserId(id: string | null | undefined): boolean {
  return (id ?? "").trim() === RESERVED_SYSTEM_USER_ID;
}

function normalizeExplicitUserId(id: string | null | undefined): string | null {
  const normalized = (id ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (isReservedSystemUserId(normalized)) {
    throw new Error("RESERVED_SYSTEM_USER_ID_FORBIDDEN");
  }
  return normalized;
}

/** 按手机号查找用户。 */
export async function findUserByPhone(phone: string, executor?: Queryable): Promise<User | null> {
  const result = await db(executor).query<User>(
    "SELECT * FROM users WHERE phone = $1",
    [phone],
  );
  return result.rows[0] ?? null;
}

/** 按用户名查找用户。 */
export async function findUserByUsername(username: string, executor?: Queryable): Promise<User | null> {
  const normalized = normalizeUsername(username);
  const result = await db(executor).query<User>(
    "SELECT * FROM users WHERE username = $1",
    [normalized],
  );
  return result.rows[0] ?? null;
}

/** 按 ID 查找用户。 */
export async function findUserById(id: string, executor?: Queryable): Promise<User | null> {
  const result = await db(executor).query<User>(
    "SELECT * FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

/** 创建手机号用户（注册时调用，返回新用户）。 */
export async function createUser(
  phone: string,
  nickname?: string,
  executor?: Queryable,
  explicitUserId?: string | null,
): Promise<User> {
  const normalizedId = normalizeExplicitUserId(explicitUserId);
  const result = await db(executor).query<User>(
    normalizedId
      ? `INSERT INTO users (id, phone, nickname) VALUES ($1, $2, $3) RETURNING *`
      : `INSERT INTO users (phone, nickname) VALUES ($1, $2) RETURNING *`,
    normalizedId
      ? [normalizedId, phone, nickname ?? null]
      : [phone, nickname ?? null],
  );
  return result.rows[0];
}

/** 创建账号密码用户。 */
export async function createPasswordUser(input: {
  id?: string | null;
  username: string;
  passwordHash: string;
  nickname?: string;
}, executor?: Queryable): Promise<User> {
  const normalizedId = normalizeExplicitUserId(input.id);
  const result = await db(executor).query<User>(
    normalizedId
      ? `INSERT INTO users (id, username, password_hash, nickname)
         VALUES ($1, $2, $3, $4)
         RETURNING *`
      : `INSERT INTO users (username, password_hash, nickname)
         VALUES ($1, $2, $3)
         RETURNING *`,
    normalizedId
      ? [normalizedId, normalizeUsername(input.username), input.passwordHash, input.nickname ?? null]
      : [normalizeUsername(input.username), input.passwordHash, input.nickname ?? null],
  );
  return result.rows[0];
}

export interface EnsureExternalMirrorUserInput {
  id: string;
  phone?: string | null;
  username?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
}

/**
 * 为“外部用户体系”预留的最小镜像接入钩子：
 * - 直接使用外部系统给定的 UUID 作为问路用户主键；
 * - 若该 UUID 已存在，则只做字段补齐/刷新，不改用户 id；
 * - 这样未来外部登录系统接入时，问路所有 user_id 隔离逻辑都不需要重写。
 */
export async function ensureExternalMirrorUser(
  input: EnsureExternalMirrorUserInput,
  executor?: Queryable,
): Promise<User> {
  const normalizedId = normalizeExplicitUserId(input.id);
  if (!normalizedId) {
    throw new Error("EXTERNAL_USER_ID_REQUIRED");
  }

  const existing = await findUserById(normalizedId, executor);
  const normalizedUsername =
    typeof input.username === "string" && input.username.trim()
      ? normalizeUsername(input.username)
      : null;

  if (!existing) {
    const result = await db(executor).query<User>(
      `INSERT INTO users (id, phone, username, nickname, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        normalizedId,
        input.phone ?? null,
        normalizedUsername,
        input.nickname ?? null,
        input.avatarUrl ?? null,
      ],
    );
    return result.rows[0];
  }

  const nextFields: {
    nickname?: string;
    avatar_url?: string;
    username?: string | null;
  } = {};

  if (input.nickname && input.nickname !== existing.nickname) {
    nextFields.nickname = input.nickname;
  }
  if (input.avatarUrl && input.avatarUrl !== existing.avatar_url) {
    nextFields.avatar_url = input.avatarUrl;
  }
  if (normalizedUsername && normalizedUsername !== existing.username) {
    nextFields.username = normalizedUsername;
  }

  if (Object.keys(nextFields).length > 0) {
    return (await updateUser(existing.id, nextFields, executor)) ?? existing;
  }

  return existing;
}

/** 更新用户信息。 */
export async function updateUser(
  id: string,
  fields: { nickname?: string; avatar_url?: string; username?: string | null; password_hash?: string | null },
  executor?: Queryable,
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
  if (fields.username !== undefined) {
    sets.push(`username = $${idx++}`);
    params.push(fields.username === null ? null : normalizeUsername(fields.username));
  }
  if (fields.password_hash !== undefined) {
    sets.push(`password_hash = $${idx++}`);
    params.push(fields.password_hash);
  }
  if (sets.length === 0) return findUserById(id, executor);

  sets.push(`updated_at = NOW()`);
  params.push(id);

  const result = await db(executor).query<User>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/** 给用户增加额外业务次数余额。 */
export async function addUserBusinessMessageCredits(
  userId: string,
  credits: number,
  executor?: Queryable,
): Promise<User | null> {
  const normalizedCredits = Math.trunc(credits);
  if (!Number.isFinite(normalizedCredits) || normalizedCredits <= 0) {
    throw new Error("EXTRA_BUSINESS_CREDITS_MUST_BE_POSITIVE");
  }

  const result = await db(executor).query<User>(
    `UPDATE users
        SET extra_business_message_credits = extra_business_message_credits + $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [userId, normalizedCredits],
  );
  return result.rows[0] ?? null;
}

/** 查找或创建用户（登录时：有则返回，无则注册）。 */
export async function findOrCreateUser(phone: string, executor?: Queryable): Promise<User> {
  const existing = await findUserByPhone(phone, executor);
  if (existing) return existing;
  return createUser(phone, undefined, executor);
}

// ---------------------------------------------------------------------------
// 微信登录相关
// ---------------------------------------------------------------------------

/** 按微信 openid 查找用户。 */
export async function findUserByOpenid(openid: string, executor?: Queryable): Promise<User | null> {
  const result = await db(executor).query<User>(
    "SELECT * FROM users WHERE wechat_openid = $1",
    [openid],
  );
  return result.rows[0] ?? null;
}

/** 创建微信用户（无手机号场景）。 */
export async function createWechatUser(opts: {
  id?: string | null;
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}, executor?: Queryable): Promise<User> {
  const normalizedId = normalizeExplicitUserId(opts.id);
  const result = await db(executor).query<User>(
    normalizedId
      ? `INSERT INTO users (id, wechat_openid, wechat_unionid, nickname, avatar_url)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`
      : `INSERT INTO users (wechat_openid, wechat_unionid, nickname, avatar_url)
         VALUES ($1, $2, $3, $4) RETURNING *`,
    normalizedId
      ? [normalizedId, opts.openid, opts.unionid ?? null, opts.nickname ?? null, opts.avatarUrl ?? null]
      : [opts.openid, opts.unionid ?? null, opts.nickname ?? null, opts.avatarUrl ?? null],
  );
  return result.rows[0];
}

/** 微信登录：查找或创建。 */
export async function findOrCreateWechatUser(opts: {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}, executor?: Queryable): Promise<{ user: User; isNew: boolean }> {
  const existing = await findUserByOpenid(opts.openid, executor);
  if (existing) {
    // 更新昵称/头像（如果微信端改了）
    if (opts.nickname || opts.avatarUrl) {
      const updated = await updateUser(existing.id, {
        nickname: opts.nickname ?? existing.nickname ?? undefined,
        avatar_url: opts.avatarUrl ?? existing.avatar_url ?? undefined,
      }, executor);
      return { user: updated ?? existing, isNew: false };
    }
    return { user: existing, isNew: false };
  }
  const user = await createWechatUser(opts, executor);
  return { user, isNew: true };
}
