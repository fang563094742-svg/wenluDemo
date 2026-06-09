/**
 * 问路 — 认证路由。
 *
 * POST /api/auth/send-code   — 发送验证码
 * POST /api/auth/login       — 验证码登录/自动注册
 * GET  /api/auth/me          — 获取当前用户信息
 */

import { Router, type Request, type Response } from "express";
import { sendSmsCode, verifySmsCode } from "./smsService.js";
import { signToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";
import { findUserByPhone, createUser, findUserById, findOrCreateWechatUser } from "../db/userRepo.js";
import { inheritCapabilities } from "../capability-pool/repo.js";
import { codeToToken, getWechatUserInfo, isMockMode } from "./wechatService.js";

export const authRouter: Router = Router();

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

    // 查找或创建用户
    let user = await findUserByPhone(phone);
    let isNewUser = false;
    if (!user) {
      user = await createUser(phone);
      isNewUser = true;
    }

    // 新用户自动继承公共能力池
    if (isNewUser) {
      try {
        const inherited = await inheritCapabilities(user.id);
        if (inherited.length > 0) {
          console.log(`[auth] 新用户 ${user.id} 自动继承了 ${inherited.length} 个公共能力`);
        }
      } catch (inheritErr) {
        // 继承失败不阻塞登录
        console.warn("[auth] 自动继承公共能力失败:", inheritErr);
      }
    }

    const token = signToken({ userId: user.id, phone: user.phone ?? undefined });

    res.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error("[auth] login error:", err);
    res.status(500).json({ error: "登录失败，请稍后重试" });
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
    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error("[auth] me error:", err);
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

// ---------------------------------------------------------------------------
// 微信登录
// ---------------------------------------------------------------------------

/**
 * 微信登录。
 * Body: { code: string }
 *
 * 流程：
 *  1. iOS App 端拉起微信 SDK 拿到 code
 *  2. POST /api/auth/wechat { code }
 *  3. 服务端换 token、查找或创建用户、签发 JWT
 *
 * Mock 模式下：任意 code 都能通过，code 被直接当作 openid 后缀
 */
authRouter.post("/wechat", async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };

  if (!code) {
    res.status(400).json({ error: "缺少微信授权 code" });
    return;
  }

  try {
    // 1. code → token + openid
    const tokenResult = await codeToToken(code);

    // 2. 拉取用户信息（昵称/头像）
    const wxUser = await getWechatUserInfo(tokenResult.accessToken, tokenResult.openid);

    // 3. 查找或创建用户
    const { user, isNew } = await findOrCreateWechatUser({
      openid: tokenResult.openid,
      unionid: tokenResult.unionid,
      nickname: wxUser.nickname,
      avatarUrl: wxUser.avatarUrl,
    });

    // 4. 新用户自动继承公共能力池
    if (isNew) {
      try {
        const inherited = await inheritCapabilities(user.id);
        if (inherited.length > 0) {
          console.log(`[auth/wechat] 新用户 ${user.id} 自动继承了 ${inherited.length} 个公共能力`);
        }
      } catch (inheritErr) {
        console.warn("[auth/wechat] 自动继承公共能力失败:", inheritErr);
      }
    }

    // 5. 签发 JWT
    const token = signToken({
      userId: user.id,
      phone: user.phone ?? undefined,
      openid: tokenResult.openid,
    });

    res.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at,
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
