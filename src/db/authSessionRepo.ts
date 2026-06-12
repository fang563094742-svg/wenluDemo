/**
 * 问路 — 长期认证会话仓储。
 */

import type pg from "pg";
import { query, type QueryResult } from "./pool.js";

export interface AuthDeviceSession {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  device_id: string | null;
  device_name: string | null;
  platform: string | null;
  user_agent: string | null;
  last_ip: string | null;
  refresh_expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

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

export interface CreateAuthDeviceSessionInput {
  userId: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  userAgent?: string;
  lastIp?: string;
}

export interface UpdateAuthDeviceSessionRefreshInput {
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  lastSeenAt?: Date;
  lastIp?: string;
  userAgent?: string;
}

export async function createAuthDeviceSession(
  input: CreateAuthDeviceSessionInput,
  executor?: Queryable,
): Promise<AuthDeviceSession> {
  const result = await db(executor).query<AuthDeviceSession>(
    `INSERT INTO auth_device_sessions (
       user_id,
       refresh_token_hash,
       device_id,
       device_name,
       platform,
       user_agent,
       last_ip,
       refresh_expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.userId,
      input.refreshTokenHash,
      input.deviceId ?? null,
      input.deviceName ?? null,
      input.platform ?? null,
      input.userAgent ?? null,
      input.lastIp ?? null,
      input.refreshExpiresAt,
    ],
  );
  return result.rows[0];
}

export async function findActiveAuthDeviceSessionByRefreshTokenHash(
  refreshTokenHash: string,
  executor?: Queryable,
): Promise<AuthDeviceSession | null> {
  const result = await db(executor).query<AuthDeviceSession>(
    `SELECT *
       FROM auth_device_sessions
      WHERE refresh_token_hash = $1
        AND revoked_at IS NULL
        AND refresh_expires_at > NOW()`,
    [refreshTokenHash],
  );
  return result.rows[0] ?? null;
}

export async function updateAuthDeviceSessionRefresh(
  sessionId: string,
  input: UpdateAuthDeviceSessionRefreshInput,
  executor?: Queryable,
): Promise<AuthDeviceSession | null> {
  const result = await db(executor).query<AuthDeviceSession>(
    `UPDATE auth_device_sessions
        SET refresh_token_hash = $2,
            refresh_expires_at = $3,
            last_seen_at = COALESCE($4, NOW()),
            last_ip = COALESCE($5, last_ip),
            user_agent = COALESCE($6, user_agent),
            updated_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL
      RETURNING *`,
    [
      sessionId,
      input.refreshTokenHash,
      input.refreshExpiresAt,
      input.lastSeenAt ?? null,
      input.lastIp ?? null,
      input.userAgent ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function touchAuthDeviceSession(
  sessionId: string,
  executor?: Queryable,
): Promise<void> {
  await db(executor).query(
    `UPDATE auth_device_sessions
        SET last_seen_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function revokeAuthDeviceSessionById(
  sessionId: string,
  executor?: Queryable,
): Promise<boolean> {
  const result = await db(executor).query(
    `UPDATE auth_device_sessions
        SET revoked_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeAuthDeviceSessionByRefreshTokenHash(
  refreshTokenHash: string,
  executor?: Queryable,
): Promise<boolean> {
  const result = await db(executor).query(
    `UPDATE auth_device_sessions
        SET revoked_at = NOW(),
            updated_at = NOW()
      WHERE refresh_token_hash = $1
        AND revoked_at IS NULL`,
    [refreshTokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}
