/**
 * 问路 — 认证路由。
 *
 * POST /api/auth/send-code           — 发送验证码
 * POST /api/auth/login               — 验证码登录/自动注册
 * POST /api/auth/password/register   — 用户名密码注册
 * POST /api/auth/password/login      — 用户名密码登录
 * POST /api/auth/refresh             — 刷新 access token + refresh token
 * POST /api/auth/logout              — 注销当前设备会话
 * GET  /api/auth/me                  — 获取当前用户信息
 * POST /api/auth/external/mirror     — 外部用户 UUID 镜像接入
 */

import { Router, type Request, type Response } from "express";
import { sendSmsCode, verifySmsCode } from "./smsService.js";
import { optionalAuth, requireAuth } from "./middleware.js";
import { applyAuthCookies, clearAuthCookies, getRefreshTokenFromHeaders } from "./httpAuth.js";
import {
  findUserByPhone,
  createUser,
  findUserById,
  findOrCreateWechatUser,
  findUserByUsername,
  createPasswordUser,
  ensureExternalMirrorUser,
  addUserBusinessMessageCredits,
} from "../db/userRepo.js";
import { transaction } from "../db/pool.js";
import { inheritCapabilities } from "../capability-pool/repo.js";
import { codeToToken, getWechatUserInfo, isMockMode } from "./wechatService.js";
import { createAuthSessionForUser, logoutAuthSession, refreshAuthSession } from "./authSessionService.js";
import { hashPassword, validatePassword, validateUsername, verifyPassword } from "./passwordService.js";
import { getBusinessAccessSnapshot } from "../membership/accessService.js";
import {
  consumeCaptchaTicket,
  createCaptchaChallenge,
  getCaptchaChallengeDebugState,
  getCaptchaClientConfig,
  verifyCaptchaChallenge,
} from "./captchaService.js";
import { getPasswordPublicKeyPayload, resolveSubmittedPassword } from "./passwordCryptoService.js";
import {
  bindUserToInviterByCode,
  getUserInvitationSummary,
  getUserInviteRewardSummary,
  listInvitedUsers,
} from "../db/inviteRepo.js";
import { awardInviteRewards } from "../invite/rewardService.js";

export const authRouter: Router = Router();

type ExistingUser = Awaited<ReturnType<typeof findUserById>> extends infer T ? Exclude<T, null> : never;

function toUserView(user: ExistingUser) {
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    createdAt: user.created_at,
  };
}

async function buildUserProfileResponse(user: ExistingUser) {
  const [membership, invite, invitedUsers, inviteReward] = await Promise.all([
    getBusinessAccessSnapshot(user.id),
    getUserInvitationSummary(user.id),
    listInvitedUsers(user.id, 10),
    getUserInviteRewardSummary(user.id),
  ]);

  return {
    ...toUserView(user),
    membership,
    invite: {
      code: invite.inviteCode,
      invitedByUserId: invite.invitedByUserId,
      invitedAt: invite.invitedAt,
      invitedCount: invite.invitedCount,
      inviter: invite.inviter,
      recentInvitedUsers: invitedUsers,
      rewardSummary: inviteReward,
    },
  };
}

function normalizeRemoteAddress(address: string | null | undefined): string {
  return String(address ?? "")
    .trim()
    .toLowerCase()
    .split("%")[0]!;
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) {
    return false;
  }
  if (normalized === "::1" || normalized.startsWith("127.")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  return false;
}

function isCaptchaDebugEnabled(req: Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return false;
  }

  const explicit = String(process.env.AUTH_CAPTCHA_DEBUG_ENABLED ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "yes") {
    return true;
  }

  return String(process.env.NODE_ENV ?? "")
    .trim()
    .toLowerCase() !== "production";
}

function extractCaptchaTicket(req: Request): { scene: string; ticket: string } {
  const body = (req.body ?? {}) as {
    captcha?: {
      scene?: string;
      ticket?: string;
    };
  };
  const captcha = body.captcha ?? {};
  return {
    scene: typeof captcha.scene === "string" ? captcha.scene : "",
    ticket: typeof captcha.ticket === "string" ? captcha.ticket : "",
  };
}

function ensureCaptchaTicket(req: Request, res: Response, expectedScene: string): boolean {
  const config = getCaptchaClientConfig(expectedScene);
  if (!config.enabled) {
    return true;
  }

  const payload = extractCaptchaTicket(req);
  const result = consumeCaptchaTicket(payload.scene || expectedScene, payload.ticket);
  if (!result.ok) {
    res.status(403).json({ error: result.message });
    return false;
  }
  return true;
}

function resolvePasswordOrThrow(body: {
  password?: unknown;
  passwordEncrypted?: unknown;
  passwordKeyId?: unknown;
}): string {
  return resolveSubmittedPassword(body);
}

async function applyNewUserCapabilities(userId: string, logPrefix: string): Promise<void> {
  try {
    const inherited = await inheritCapabilities(userId);
    if (inherited.length > 0) {
      console.log(`${logPrefix} 新用户 ${userId} 自动继承了 ${inherited.length} 个公共能力`);
    }
  } catch (inheritErr) {
    console.warn(`${logPrefix} 自动继承公共能力失败:`, inheritErr);
  }
}

authRouter.get("/geetest/config", (_req: Request, res: Response) => {
  res.json({ success: true, geetest: { enabled: false } });
});

authRouter.get("/captcha/config", (req: Request, res: Response) => {
  const scene = typeof req.query.scene === "string" ? req.query.scene : "login";
  res.json({
    success: true,
    captcha: getCaptchaClientConfig(scene),
  });
});

authRouter.get("/captcha/data", async (req: Request, res: Response) => {
  try {
    const scene = typeof req.query.scene === "string" ? req.query.scene : "login";
    const config = getCaptchaClientConfig(scene);
    if (!config.enabled) {
      res.json({
        code: 200,
        data: null,
        message: "captcha disabled",
      });
      return;
    }
    const challenge = await createCaptchaChallenge(scene);
    res.json({
      code: 200,
      data: challenge,
      message: "ok",
    });
  } catch (err) {
    console.error("[auth] captcha data error:", err);
    res.status(500).json({ code: 500, message: "验证码加载失败，请稍后重试" });
  }
});

authRouter.get("/captcha/debug", (req: Request, res: Response) => {
  if (!isCaptchaDebugEnabled(req)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const key = typeof req.query.key === "string" ? req.query.key : "";
  const challenge = getCaptchaChallengeDebugState(key);
  if (!challenge) {
    res.status(404).json({ error: "验证码调试信息不存在或已过期" });
    return;
  }

  res.json({
    success: true,
    challenge: {
      key: challenge.key,
      scene: challenge.scene,
      tileX: challenge.tileX,
      tileY: challenge.tileY,
      targetX: challenge.targetX,
      targetY: challenge.targetY,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      used: challenge.used,
    },
  });
});

authRouter.post("/captcha/verify", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    scene?: string;
    key?: string;
    captchaKey?: string;
    value?: string;
    captchaValue?: string;
  };

  const result = verifyCaptchaChallenge({
    scene: body.scene,
    key: body.key ?? body.captchaKey,
    value: body.value ?? body.captchaValue,
  });

  if (!result.ok || !result.ticket) {
    res.status(403).json({
      code: 403,
      message: result.message,
    });
    return;
  }

  res.json({
    code: 200,
    data: {
      ticket: result.ticket,
      verifiedAt: result.verifiedAt,
    },
    message: "ok",
  });
});

authRouter.get("/password/public-key", (_req: Request, res: Response) => {
  res.json({
    success: true,
    key: getPasswordPublicKeyPayload(),
  });
});

/**
 * 发送验证码。
 * Body: { phone: string }
 */
authRouter.post("/send-code", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: string };

  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    res.status(400).json({ error: "请输入正确的手机号" });
    return;
  }

  try {
    const result = await sendSmsCode(phone);
    if (!result.success) {
      res.status(429).json({ error: result.message });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[auth] send-code error:", err);
    res.status(500).json({ error: "验证码发送失败，请稍后重试" });
  }
});

/**
 * 验证码登录（不存在用户时自动注册）。
 * Body: { phone: string, code: string }
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: string; code?: string };

  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    res.status(400).json({ error: "请输入正确的手机号" });
    return;
  }
  if (!code || code.length !== 6) {
    res.status(400).json({ error: "请输入6位验证码" });
    return;
  }

  try {
    const valid = await verifySmsCode(phone, code);
    if (!valid) {
      res.status(401).json({ error: "验证码错误或已过期" });
      return;
    }

    let user = await findUserByPhone(phone);
    const isNewUser = !user;
    if (!user) {
      user = await createUser(phone);
    }

    if (isNewUser) {
      await applyNewUserCapabilities(user.id, "[auth]");
    }

    const tokens = await createAuthSessionForUser(user, req);
    applyAuthCookies(res, tokens);

    res.json({
      ...tokens,
      isNewUser,
      user: toUserView(user),
    });
  } catch (err) {
    console.error("[auth] login error:", err);
    res.status(500).json({ error: "登录失败，请稍后重试" });
  }
});

/**
 * 用户名密码注册。
 * Body: { username: string, password: string, nickname?: string, geetest?: object }
 */
authRouter.post("/password/register", async (req: Request, res: Response) => {
  const { username, nickname, inviteCode } = req.body as {
    username?: string;
    nickname?: string;
    inviteCode?: string;
  };

  const usernameError = username ? validateUsername(username) : "用户名不能为空";
  if (usernameError) {
    res.status(400).json({ error: usernameError });
    return;
  }

  let password = "";
  try {
    password = resolvePasswordOrThrow(req.body as {
      password?: unknown;
      passwordEncrypted?: unknown;
      passwordKeyId?: unknown;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "PASSWORD_DECRYPT_FAILED";
    const userMessage =
      message === "PASSWORD_KEY_ID_MISMATCH"
        ? "密码加密密钥已更新，请刷新页面后重试"
        : "密码安全校验失败，请刷新页面后重试";
    res.status(400).json({ error: userMessage });
    return;
  }

  const passwordError = password ? validatePassword(password) : "密码不能为空";
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  if (!ensureCaptchaTicket(req, res, "register")) {
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    const normalizedInviteCode = typeof inviteCode === "string" ? inviteCode.trim() : "";
    const user = await transaction(async (client) => {
      const existing = await findUserByUsername(username!, client);
      if (existing) {
        throw new Error("USERNAME_EXISTS");
      }

      const createdUser = await createPasswordUser({
        username: username!,
        passwordHash,
        nickname: nickname?.trim() || undefined,
      }, client);

      if (normalizedInviteCode) {
        const inviter = await bindUserToInviterByCode(createdUser.id, normalizedInviteCode, client);
        // 邀请奖励：每成功邀请一位新用户注册，给邀请人 +10 条额外业务指令次数。
        // 该额度在每日免费额度用完后才动用，且试用到期会先被拦截 → 余额随试用失效。
        await addUserBusinessMessageCredits(inviter.id, 10, client);
        await awardInviteRewards({
          inviterUserId: inviter.id,
          inviteeUserId: createdUser.id,
          grantedBy: "register_invite",
          executor: client,
        });
      }

      return createdUser;
    });

    await applyNewUserCapabilities(user.id, "[auth/password/register]");

    const tokens = await createAuthSessionForUser(user, req);
    applyAuthCookies(res, tokens);

    res.status(201).json({
      ...tokens,
      isNewUser: true,
      user: toUserView(user),
    });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "USERNAME_EXISTS") {
        res.status(409).json({ error: "用户名已存在" });
        return;
      }
      if (err.message === "INVITE_CODE_NOT_FOUND") {
        res.status(400).json({ error: "邀请码不存在" });
        return;
      }
      if (err.message === "SELF_INVITE_NOT_ALLOWED") {
        res.status(400).json({ error: "不能填写自己的邀请码" });
        return;
      }
      if (err.message === "ALREADY_INVITED") {
        res.status(400).json({ error: "该账号已绑定邀请码" });
        return;
      }
      if (err.message === "INVITE_CODE_REQUIRED") {
        res.status(400).json({ error: "邀请码不能为空" });
        return;
      }
    }
    console.error("[auth/password/register] error:", err);
    res.status(500).json({ error: "注册失败，请稍后重试" });
  }
});

/**
 * 用户名密码登录。
 * Body: { username: string, password: string, geetest?: object }
 */
authRouter.post("/password/login", async (req: Request, res: Response) => {
  const { username } = req.body as {
    username?: string;
  };

  const usernameError = username ? validateUsername(username) : "用户名不能为空";
  if (usernameError) {
    res.status(400).json({ error: usernameError });
    return;
  }

  let password = "";
  try {
    password = resolvePasswordOrThrow(req.body as {
      password?: unknown;
      passwordEncrypted?: unknown;
      passwordKeyId?: unknown;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "PASSWORD_DECRYPT_FAILED";
    const userMessage =
      message === "PASSWORD_KEY_ID_MISMATCH"
        ? "密码加密密钥已更新，请刷新页面后重试"
        : "密码安全校验失败，请刷新页面后重试";
    res.status(400).json({ error: userMessage });
    return;
  }

  const passwordError = password ? validatePassword(password) : "密码不能为空";
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  if (!ensureCaptchaTicket(req, res, "login")) {
    return;
  }

  try {
    const user = await findUserByUsername(username!);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }

    const tokens = await createAuthSessionForUser(user, req);
    applyAuthCookies(res, tokens);

    res.json({
      ...tokens,
      isNewUser: false,
      user: toUserView(user),
    });
  } catch (err) {
    console.error("[auth/password/login] error:", err);
    res.status(500).json({ error: "登录失败，请稍后重试" });
  }
});

/**
 * 刷新认证。
 * Body: { refreshToken: string }
 */
authRouter.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken: bodyRefreshToken } = (req.body ?? {}) as { refreshToken?: string };
  const refreshToken = bodyRefreshToken || getRefreshTokenFromHeaders(req.headers);

  if (!refreshToken) {
    res.status(400).json({ error: "缺少 refreshToken" });
    return;
  }

  try {
    const { user, tokens } = await refreshAuthSession(refreshToken, req);
    applyAuthCookies(res, tokens);
    res.json({
      ...tokens,
      isNewUser: false,
      user: toUserView(user),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVALID_REFRESH_TOKEN") {
      res.status(401).json({ error: "refreshToken 无效或已过期，请重新登录" });
      return;
    }
    console.error("[auth] refresh error:", err);
    res.status(500).json({ error: "刷新登录态失败" });
  }
});

/**
 * 注销当前设备会话。
 * Body: { refreshToken?: string }
 */
authRouter.post("/logout", optionalAuth, async (req: Request, res: Response) => {
  const { refreshToken: bodyRefreshToken } = (req.body ?? {}) as { refreshToken?: string };
  const refreshToken = bodyRefreshToken || getRefreshTokenFromHeaders(req.headers);
  const sessionId = req.user?.sessionId;

  if (!refreshToken && !sessionId) {
    res.status(400).json({ error: "缺少可注销的会话凭证" });
    return;
  }

  try {
    await logoutAuthSession({ sessionId, refreshToken });
    clearAuthCookies(res);
    res.json({ success: true });
  } catch (err) {
    console.error("[auth] logout error:", err);
    res.status(500).json({ error: "注销失败" });
  }
});

/**
 * 获取当前用户信息（需要认证）。
 */
authRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await findUserById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    res.json(await buildUserProfileResponse(user));
  } catch (err) {
    console.error("[auth] me error:", err);
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

authRouter.post("/external/mirror", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    userId?: unknown;
    externalUserId?: unknown;
    uuid?: unknown;
    phone?: unknown;
    username?: unknown;
    nickname?: unknown;
    avatarUrl?: unknown;
  };

  const headerUserId =
    (req.headers["x-external-user-id"] as string | string[] | undefined) ??
    (req.headers["x-wenlu-external-user-id"] as string | string[] | undefined);
  const resolvedHeaderUserId = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId;
  const externalUserId =
    typeof body.userId === "string" && body.userId.trim()
      ? body.userId.trim()
      : typeof body.externalUserId === "string" && body.externalUserId.trim()
        ? body.externalUserId.trim()
        : typeof body.uuid === "string" && body.uuid.trim()
          ? body.uuid.trim()
          : String(resolvedHeaderUserId ?? "").trim();

  if (!externalUserId) {
    res.status(400).json({ error: "缺少外部用户 UUID" });
    return;
  }

  try {
    const existedBefore = await findUserById(externalUserId);
    const user = await ensureExternalMirrorUser({
      id: externalUserId,
      phone: typeof body.phone === "string" ? body.phone.trim() || null : null,
      username: typeof body.username === "string" ? body.username.trim() || null : null,
      nickname: typeof body.nickname === "string" ? body.nickname.trim() || null : null,
      avatarUrl: typeof body.avatarUrl === "string" ? body.avatarUrl.trim() || null : null,
    });

    if (!existedBefore) {
      await applyNewUserCapabilities(user.id, "[auth/external/mirror]");
    }

    res.json({
      ...(await buildUserProfileResponse(user)),
      mirrored: true,
      source: "external-user-system",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "EXTERNAL_MIRROR_FAILED";
    if (message === "RESERVED_SYSTEM_USER_ID_FORBIDDEN") {
      res.status(400).json({ error: "该 UUID 为系统保留值，不能用于真实用户" });
      return;
    }
    if (message === "EXTERNAL_USER_ID_REQUIRED") {
      res.status(400).json({ error: "缺少外部用户 UUID" });
      return;
    }
    console.error("[auth/external/mirror] error:", err);
    res.status(500).json({ error: "外部用户镜像失败" });
  }
});

// ---------------------------------------------------------------------------
// 微信登录
// ---------------------------------------------------------------------------

/**
 * 微信登录。
 * Body: { code: string }
 */
authRouter.post("/wechat", async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };

  if (!code) {
    res.status(400).json({ error: "缺少微信授权 code" });
    return;
  }

  try {
    const tokenResult = await codeToToken(code);
    const wxUser = await getWechatUserInfo(tokenResult.accessToken, tokenResult.openid);
    const { user, isNew } = await findOrCreateWechatUser({
      openid: tokenResult.openid,
      unionid: tokenResult.unionid,
      nickname: wxUser.nickname,
      avatarUrl: wxUser.avatarUrl,
    });

    if (isNew) {
      await applyNewUserCapabilities(user.id, "[auth/wechat]");
    }

    const tokens = await createAuthSessionForUser(user, req);
    applyAuthCookies(res, tokens);

    res.json({
      ...tokens,
      isNewUser: isNew,
      user: {
        ...toUserView(user),
        isNew,
      },
      mock: isMockMode(),
    });
  } catch (err) {
    console.error("[auth/wechat] login error:", err);
    const message = err instanceof Error ? err.message : "微信登录失败";
    res.status(500).json({ error: message });
  }
});
