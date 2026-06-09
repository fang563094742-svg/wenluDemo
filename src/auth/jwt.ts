/**
 * 问路 — JWT 工具函数。
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "wenlu-dev-secret-change-in-prod";
const JWT_EXPIRES_IN: number = parseInt(process.env.JWT_EXPIRES_IN || "2592000", 10); // 秒，默认 30 天

export interface JwtPayload {
  userId: string;
  phone?: string;     // 微信登录可能没手机号
  openid?: string;    // 微信 openid
}

/** 签发 token。 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** 验证并解码 token。失败返回 null。 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}
