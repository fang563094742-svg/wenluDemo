/**
 * 问路 — Express 认证中间件。
 *
 * 从 Authorization: Bearer <token> 提取 JWT，挂载到 req.user。
 */

import type { Request, Response, NextFunction } from "express";
import { verifyToken, type JwtPayload } from "./jwt.js";

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
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "登录已过期，请重新登录" });
    return;
  }

  req.user = payload;
  next();
}

/**
 * 可选认证中间件：有 token 就解析，没有也放行。
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}
