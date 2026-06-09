/**
 * 问路 — 认证模块统一导出。
 */

export { authRouter } from "./routes.js";
export { requireAuth, optionalAuth } from "./middleware.js";
export { signToken, verifyToken, type JwtPayload } from "./jwt.js";
export { codeToToken, getWechatUserInfo, isMockMode } from "./wechatService.js";
