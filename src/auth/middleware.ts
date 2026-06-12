/**
 * 问路 — Express 认证中间件。
 *
 * 从 Authorization: Bearer <token> 提取 JWT，挂载到 req.user。
 */

import type { Request, Response, NextFunction } from "express";
import { authenticateHeaders, getAccessTokenFromHeaders } from "./httpAuth.js";
import type { JwtPayload } from "./jwt.js";
import { touchAuthSession } from "./authSessionService.js";

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * 强制认证中间件：无 token 或 token 无效返回 401。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const rawToken = getAccessTokenFromHeaders(req.headers);
  if (!rawToken) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  const payload = authenticateHeaders(req.headers);
  if (!payload) {
    res.status(401).json({ error: "登录已过期，请重新登录" });
    return;
  }

  req.user = payload;
  void touchAuthSession(payload.sessionId).catch((err) => {
    console.warn("[auth] touch session failed:", err);
  });
  next();
}

/**
 * 可选认证中间件：有 token 就解析，没有也放行。
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const payload = authenticateHeaders(req.headers);
  if (payload) {
    req.user = payload;
    void touchAuthSession(payload.sessionId).catch((err) => {
      console.warn("[auth] touch session failed:", err);
    });
  }
  next();
}
