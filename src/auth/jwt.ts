/**
 * 问路 — JWT 工具函数。
 */

import jwt from "jsonwebtoken";

const JWT_EXPIRES_IN: number = parseInt(
  process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || "2592000",
  10,
);

/**
 * JWT 签名密钥。**不再有硬编码默认值**——缺失即拒绝工作（L1 Phase 1.5）。
 *
 * 取值策略：显式 `initJwtSecret()`（启动期、在 L1 擦除 env 之前调用）把 env 里的
 * JWT_SECRET 捕获进闭包；之后即使 process.env.JWT_SECRET 被擦除，签发/校验仍可用。
 * 若未显式初始化（如 gateway 进程），`secret()` 退化为首用时从 env 读取并缓存。
 * 两条路径都拿不到非空值时抛错——绝不退回任何默认密钥。
 */
let _jwtSecret: string | null = null;

/** 启动期显式捕获 JWT_SECRET（应在擦除 env 之前调用）。缺失即抛错，拒绝启动。 */
export function initJwtSecret(env: NodeJS.ProcessEnv = process.env): void {
  const s = typeof env.JWT_SECRET === "string" ? env.JWT_SECRET.trim() : "";
  if (!s) {
    throw new Error(
      "JWT_SECRET 未配置：拒绝以默认密钥启动。请在 .env 设置一个强随机 JWT_SECRET（绝不入库、绝不用默认值）。",
    );
  }
  _jwtSecret = s;
}

/** 取签名密钥：优先已捕获值；否则首用时从 env 读并缓存；都没有则抛错（不回退默认）。 */
function secret(): string {
  if (_jwtSecret !== null) return _jwtSecret;
  const s = typeof process.env.JWT_SECRET === "string" ? process.env.JWT_SECRET.trim() : "";
  if (!s) {
    throw new Error("JWT_SECRET 未配置或已被擦除且未经 initJwtSecret 初始化——拒绝签发/校验。");
  }
  _jwtSecret = s;
  return _jwtSecret;
}

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
  return jwt.sign(payload, secret(), { expiresIn: JWT_EXPIRES_IN });
}

/** 返回 access token 过期时间。 */
export function getTokenExpiryDate(baseDate: Date = new Date()): Date {
  return new Date(baseDate.getTime() + JWT_EXPIRES_IN * 1000);
}

/** 验证并解码 token。失败返回 null。 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret()) as JwtPayload;
    if (decoded.type !== "access" || !decoded.sessionId) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
