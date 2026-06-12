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

/**
 * 读取可配置的 admin userId 名单（环境变量 `WENLU_ADMIN_USER_IDS`，逗号分隔）。
 *
 * 说明：当前 `JwtPayload` 尚无角色字段，故先用「可配置 admin 名单」做最小可用的管理员判定；
 * 后续接入正式角色系统（如 JwtPayload.role）后，可在 `requireAdmin` 内改判角色字段，
 * 本函数与名单可随之下线。每次读取实时解析环境变量，便于测试与运行时配置生效。
 */
export function getAdminUserIds(): Set<string> {
  const raw = process.env.WENLU_ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * 管理员鉴权中间件：在 `requireAuth` 之后使用。
 *
 * 行为：
 *  - 未登录（`req.user` 缺失，通常意味着未先经 `requireAuth`）→ 401 未登录；
 *  - 已登录但不在 admin 名单 → 403 无管理员权限（不执行任何后续处理）；
 *  - 已登录且在 admin 名单 → 放行。
 *
 * 判定依据：可配置的 admin userId 名单（`WENLU_ADMIN_USER_IDS`）。后续可换成正式角色系统。
 * 注意：不改变 `requireAuth` 既有行为，需作为其后置中间件链式使用。
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  // 防御性：若未先经 requireAuth（req.user 缺失），视为未登录。
  if (!req.user) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  const admins = getAdminUserIds();
  if (!admins.has(req.user.userId)) {
    res.status(403).json({ error: "无管理员权限" });
    return;
  }
  next();
}
