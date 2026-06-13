/**
 * 技能反哺 API 路由与 auth 接入单元测试（任务 16）。
 *
 * 覆盖：
 *  - `requireAdmin` 中间件（16.2）：放行 admin、拒绝非 admin（403）、未登录（401）；不依赖网络。
 *  - 路由身份接入（16.1）：`/api/skills`（list/expand/inherit/mine）与 `/api/reflux`
 *    （onboard/stats/pending）整体经 `requireAuth`，无身份拒绝（401）。
 *  - 人工审核入口保护（16.2）：`/api/reflux/pending` 经 `requireAdmin`——非管理员 403 且不读取队列；
 *    管理员放行并读取队列。
 *
 * 路由集成测试用真实 express + 临时 http server + 注入 mock 依赖（不连真实 PG / LLM）。
 *
 * _Requirements: 14.1, 14.3, 14.4, 17.10, 10.9, 10.10_
 */

import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "../../auth/middleware.js";
import { signToken, initJwtSecret } from "../../auth/jwt.js";
import { createRefluxRouters, type RefluxRoutesDeps } from "../routes.js";

// ── requireAdmin 单元测试（直接驱动中间件，不经网络） ──
describe("requireAdmin 中间件", () => {
  const ORIG = process.env.WENLU_ADMIN_USER_IDS;
  afterEach(() => {
    process.env.WENLU_ADMIN_USER_IDS = ORIG;
  });

  function mockRes() {
    const res: { statusCode?: number; body?: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    return res;
  }

  it("放行 admin（命中 WENLU_ADMIN_USER_IDS 名单）", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1, admin-2";
    const req = { user: { userId: "admin-2" } } as never;
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("拒绝非 admin 的已登录用户（403，且不放行）", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1";
    const req = { user: { userId: "normal-user" } } as never;
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("空名单时任何用户都不是 admin（403）", () => {
    process.env.WENLU_ADMIN_USER_IDS = "";
    const req = { user: { userId: "anyone" } } as never;
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("未登录（req.user 缺失）→ 401", () => {
    process.env.WENLU_ADMIN_USER_IDS = "admin-1";
    const req = {} as never;
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

// ── 路由集成测试（真实 express + 临时 server + 注入 mock 依赖） ──
describe("reflux 路由身份接入与 admin 保护", () => {
  const ADMIN_ID = "admin-user";
  const NORMAL_ID = "normal-user";
  const ORIG = process.env.WENLU_ADMIN_USER_IDS;
  // 整合后 auth 收紧：jwt 不再有默认密钥，签发/校验前必须配置 JWT_SECRET（见 src/auth/jwt.ts）。
  const ORIG_JWT = process.env.JWT_SECRET;

  let server: Server;
  let baseUrl: string;
  let deps: Required<Pick<RefluxRoutesDeps, "dispatcher" | "onboarding" | "listMine" | "stats" | "getPending">>;

  const adminToken = () => signToken({ userId: ADMIN_ID, sessionId: "test-admin-session", type: "access" });
  const userToken = () => signToken({ userId: NORMAL_ID, sessionId: "test-user-session", type: "access" });

  beforeEach(async () => {
    process.env.WENLU_ADMIN_USER_IDS = ADMIN_ID;
    // 为测试签发/校验 JWT 提供密钥（auth 收紧后无默认密钥，须显式初始化）。
    process.env.JWT_SECRET = "test-jwt-secret-routes";
    initJwtSecret();

    deps = {
      dispatcher: {
        retrieve: vi.fn().mockResolvedValue([{ summary: { id: "s1" } }]),
        expand: vi.fn().mockResolvedValue({ id: "s1", title: "技能1" }),
        inherit: vi.fn().mockResolvedValue({ inherited: ["s1"], count: 1 }),
        settleRenderedVariant: vi.fn(),
      } as never,
      onboarding: {
        onboard: vi.fn().mockResolvedValue({
          userId: NORMAL_ID,
          status: "soft_done",
          inherited: ["s1"],
          starterSkillIds: ["s1"],
          alreadyOnboarded: false,
        }),
        topUpOnConnector: vi.fn(),
      } as never,
      listMine: vi.fn().mockResolvedValue([{ skill_id: "s1" }]),
      stats: vi.fn().mockResolvedValue({
        total_skills: 1,
        active_skills: 1,
        retired_skills: 0,
        total_uses: 0,
        avg_success_rate: 0,
      }),
      getPending: vi.fn().mockResolvedValue([{ id: "p1" }]),
    };

    const { skillRouter, refluxRouter } = createRefluxRouters(deps);
    const app = express();
    app.use(express.json());
    app.use("/api/skills", skillRouter);
    app.use("/api/reflux", refluxRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    process.env.WENLU_ADMIN_USER_IDS = ORIG;
    if (ORIG_JWT === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIG_JWT;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    return fetch(`${baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  // ── 无身份拒绝（Req 14.4） ──
  it("GET /api/skills 无 token → 401", async () => {
    const res = await call("/api/skills");
    expect(res.status).toBe(401);
    expect(deps.dispatcher.retrieve).not.toHaveBeenCalled();
  });

  it("POST /api/reflux/onboard 无 token → 401", async () => {
    const res = await call("/api/reflux/onboard", { method: "POST", body: {} });
    expect(res.status).toBe(401);
    expect(deps.onboarding.onboard).not.toHaveBeenCalled();
  });

  // ── 已登录用户可访问普通端点 ──
  it("GET /api/skills/mine 已登录 → 200 且以自身 userId 查询", async () => {
    const res = await call("/api/skills/mine", { token: userToken() });
    expect(res.status).toBe(200);
    expect(deps.listMine).toHaveBeenCalledWith(NORMAL_ID);
  });

  it("POST /api/skills/inherit 已登录 → 200 且以自身 userId 继承", async () => {
    const res = await call("/api/skills/inherit", {
      method: "POST",
      token: userToken(),
      body: { skillIds: ["s1"] },
    });
    expect(res.status).toBe(200);
    expect(deps.dispatcher.inherit).toHaveBeenCalledWith(NORMAL_ID, ["s1"]);
  });

  it("POST /api/reflux/onboard 已登录 → 200 且以自身 userId 冷启动", async () => {
    const res = await call("/api/reflux/onboard", {
      method: "POST",
      token: userToken(),
      body: { platform: "win" },
    });
    expect(res.status).toBe(200);
    expect(deps.onboarding.onboard).toHaveBeenCalledWith(NORMAL_ID, "win");
  });

  it("GET /api/reflux/stats 已登录 → 200", async () => {
    const res = await call("/api/reflux/stats", { token: userToken() });
    expect(res.status).toBe(200);
    expect(deps.stats).toHaveBeenCalledOnce();
  });

  // ── 人工审核入口 admin 保护（Req 10.10） ──
  it("GET /api/reflux/pending 无 token → 401，不读取队列", async () => {
    const res = await call("/api/reflux/pending");
    expect(res.status).toBe(401);
    expect(deps.getPending).not.toHaveBeenCalled();
  });

  it("GET /api/reflux/pending 非管理员已登录 → 403，不读取队列", async () => {
    const res = await call("/api/reflux/pending", { token: userToken() });
    expect(res.status).toBe(403);
    expect(deps.getPending).not.toHaveBeenCalled();
  });

  it("GET /api/reflux/pending 管理员 → 200 且读取队列", async () => {
    const res = await call("/api/reflux/pending", { token: adminToken() });
    expect(res.status).toBe(200);
    expect(deps.getPending).toHaveBeenCalledOnce();
  });
});
