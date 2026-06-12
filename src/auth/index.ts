/**
 * 问路 — 认证模块统一导出。
 */

export { authRouter } from "./routes.js";
export { requireAuth, optionalAuth } from "./middleware.js";
export { signToken, verifyToken, getTokenExpiryDate, type JwtPayload } from "./jwt.js";
export { codeToToken, getWechatUserInfo, isMockMode } from "./wechatService.js";
export {
  getGeeTestClientConfig,
  parseGeeTestPayload,
  registerGeeTest,
  verifyGeeTest,
  type GeeTestRegisterPayload,
  type GeeTestValidationPayload,
  type GeeTestValidationResult,
} from "./geetestService.js";
export * from "./authSessionService.js";
export * from "./passwordService.js";
