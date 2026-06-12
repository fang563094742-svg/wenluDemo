/**
 * 问路 — 长期认证/刷新服务。
 */

import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { signToken, getTokenExpiryDate } from "./jwt.js";
import { findUserById, type User } from "../db/userRepo.js";
import {
  createAuthDeviceSession,
  findActiveAuthDeviceSessionByRefreshTokenHash,
  touchAuthDeviceSession,
  revokeAuthDeviceSessionById,
  revokeAuthDeviceSessionByRefreshTokenHash,
  updateAuthDeviceSessionRefresh,
} from "../db/authSessionRepo.js";
import { transaction } from "../db/pool.js";

const REFRESH_TOKEN_TTL_SECONDS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || "15552000", 10);

export interface AuthTokens {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  sessionId: string;
}

interface DeviceContext {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  userAgent?: string;
  ip?: string;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

function getRequestIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || undefined;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  return req.ip || undefined;
}

export function getDeviceContext(req: Request): DeviceContext {
  const deviceIdHeader = req.headers["x-device-id"];
  const deviceNameHeader = req.headers["x-device-name"];
  const platformHeader = req.headers["x-client-platform"];
  const userAgent = req.headers["user-agent"];

  return {
    deviceId: typeof deviceIdHeader === "string" ? deviceIdHeader : undefined,
    deviceName: typeof deviceNameHeader === "string" ? deviceNameHeader : undefined,
    platform: typeof platformHeader === "string" ? platformHeader : undefined,
    userAgent: typeof userAgent === "string" ? userAgent : undefined,
    ip: getRequestIp(req),
  };
}

function buildAccessToken(user: User, sessionId: string): AuthTokens {
  const accessToken = signToken({
    userId: user.id,
    phone: user.phone ?? undefined,
    openid: user.wechat_openid ?? undefined,
    sessionId,
    type: "access",
  });
  const expiresAt = getTokenExpiryDate();
  return {
    token: accessToken,
    accessToken,
    refreshToken: "",
    expiresAt: expiresAt.toISOString(),
    refreshExpiresAt: "",
    sessionId,
  };
}

export async function createAuthSessionForUser(user: User, req: Request): Promise<AuthTokens> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshExpiresAt = addSeconds(new Date(), REFRESH_TOKEN_TTL_SECONDS);
  const device = getDeviceContext(req);

  const session = await createAuthDeviceSession({
    userId: user.id,
    refreshTokenHash,
    refreshExpiresAt,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    platform: device.platform,
    userAgent: device.userAgent,
    lastIp: device.ip,
  });

  const tokens = buildAccessToken(user, session.id);
  tokens.refreshToken = refreshToken;
  tokens.refreshExpiresAt = refreshExpiresAt.toISOString();
  return tokens;
}

export async function refreshAuthSession(refreshToken: string, req: Request): Promise<{ user: User; tokens: AuthTokens }> {
  const currentHash = hashRefreshToken(refreshToken);
  const device = getDeviceContext(req);

  return transaction(async (client) => {
    const currentSession = await findActiveAuthDeviceSessionByRefreshTokenHash(currentHash, client);
    if (!currentSession) {
      throw new Error("INVALID_REFRESH_TOKEN");
    }

    const user = await findUserById(currentSession.user_id);
    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }

    const nextRefreshToken = generateRefreshToken();
    const nextRefreshTokenHash = hashRefreshToken(nextRefreshToken);
    const nextRefreshExpiresAt = addSeconds(new Date(), REFRESH_TOKEN_TTL_SECONDS);
    const updatedSession = await updateAuthDeviceSessionRefresh(
      currentSession.id,
      {
        refreshTokenHash: nextRefreshTokenHash,
        refreshExpiresAt: nextRefreshExpiresAt,
        lastSeenAt: new Date(),
        lastIp: device.ip,
        userAgent: device.userAgent,
      },
      client,
    );

    if (!updatedSession) {
      throw new Error("SESSION_ROTATE_FAILED");
    }

    const tokens = buildAccessToken(user, updatedSession.id);
    tokens.refreshToken = nextRefreshToken;
    tokens.refreshExpiresAt = nextRefreshExpiresAt.toISOString();

    return { user, tokens };
  });
}

export async function logoutAuthSession(options: {
  sessionId?: string;
  refreshToken?: string;
}): Promise<boolean> {
  let revoked = false;

  if (options.refreshToken) {
    revoked = (await revokeAuthDeviceSessionByRefreshTokenHash(hashRefreshToken(options.refreshToken))) || revoked;
  }

  if (options.sessionId) {
    revoked = (await revokeAuthDeviceSessionById(options.sessionId)) || revoked;
  }

  return revoked;
}

export async function touchAuthSession(sessionId: string): Promise<void> {
  await touchAuthDeviceSession(sessionId);
}
