/**
 * 问路 — JWT 工具函数。
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "wenlu-dev-secret-change-in-prod";
const JWT_EXPIRES_IN: number = parseInt(
  process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || "2592000",
  10,
);

export interface JwtPayload {
  userId: string;
  phone?: string;
  openid?: string;
  sessionId: string;
  type: "access";
  exp?: number;
  iat?: number;
}

/** 签发 token。 */
export function signToken(payload: Omit<JwtPayload, "exp" | "iat">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** 返回 access token 过期时间。 */
export function getTokenExpiryDate(baseDate: Date = new Date()): Date {
  return new Date(baseDate.getTime() + JWT_EXPIRES_IN * 1000);
}

/** 验证并解码 token。失败返回 null。 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (decoded.type !== "access" || !decoded.sessionId) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
