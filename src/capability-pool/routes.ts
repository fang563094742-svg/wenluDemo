/**
 * 问路 — 能力共享池 API 路由。
 *
 * GET  /api/capabilities          — 获取公共能力列表（已审核通过的）
 * GET  /api/capabilities/stats    — 能力池统计
 * GET  /api/capabilities/pending  — 待审核列表（管理员）
 * POST /api/capabilities/review   — 审核通过/拒绝（管理员）
 * POST /api/capabilities/inherit  — 继承公共能力到自己的 mind
 * GET  /api/capabilities/mine     — 我已继承的能力
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import {
  getApprovedCapabilities,
  getPoolStats,
  getPendingCapabilities,
  reviewCapability,
  inheritCapabilities,
  getUserInheritedCapabilities,
} from "./repo.js";

export const capabilityRouter: Router = Router();

// 所有路由都需要登录
capabilityRouter.use(requireAuth);

/**
 * 获取所有已审核通过的公共能力。
 */
capabilityRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const caps = await getApprovedCapabilities();
    res.json({ capabilities: caps });
  } catch (err) {
    console.error("[capability-pool] list error:", err);
    res.status(500).json({ error: "获取能力列表失败" });
  }
});

/**
 * 能力池统计。
 */
capabilityRouter.get("/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getPoolStats();
    res.json(stats);
  } catch (err) {
    console.error("[capability-pool] stats error:", err);
    res.status(500).json({ error: "获取统计失败" });
  }
});

/**
 * 待审核列表（管理员）。
 * 经 `requireAdmin` 管理员鉴权（Req 10.10）：非管理员的已登录用户调用 → 403，且不读取队列。
 */
capabilityRouter.get("/pending", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const pending = await getPendingCapabilities();
    res.json({ pending });
  } catch (err) {
    console.error("[capability-pool] pending error:", err);
    res.status(500).json({ error: "获取待审列表失败" });
  }
});

/**
 * 审核能力。
 * 经 `requireAdmin` 管理员鉴权（Req 10.10）：非管理员的已登录用户调用 → 403，且不执行审核动作。
 * Body: { capabilityId: string, decision: "approved" | "rejected", note?: string }
 */
capabilityRouter.post("/review", requireAdmin, async (req: Request, res: Response) => {
  const { capabilityId, decision, note } = req.body as {
    capabilityId?: string;
    decision?: string;
    note?: string;
  };

  if (!capabilityId || !decision || !["approved", "rejected"].includes(decision)) {
    res.status(400).json({ error: "参数不合法：需要 capabilityId + decision(approved/rejected)" });
    return;
  }

  try {
    await reviewCapability(
      capabilityId,
      decision as "approved" | "rejected",
      req.user!.userId,
      note,
    );
    res.json({ success: true, capabilityId, decision });
  } catch (err) {
    console.error("[capability-pool] review error:", err);
    res.status(500).json({ error: "审核失败" });
  }
});

/**
 * 继承公共能力。
 * Body: { capabilityIds?: string[] }  — 不传则继承全部已审核能力
 */
capabilityRouter.post("/inherit", async (req: Request, res: Response) => {
  const { capabilityIds } = req.body as { capabilityIds?: string[] };
  try {
    const inherited = await inheritCapabilities(req.user!.userId, capabilityIds);
    res.json({
      success: true,
      count: inherited.length,
      capabilities: inherited.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    });
  } catch (err) {
    console.error("[capability-pool] inherit error:", err);
    res.status(500).json({ error: "继承能力失败" });
  }
});

/**
 * 获取我已继承的能力。
 */
capabilityRouter.get("/mine", async (req: Request, res: Response) => {
  try {
    const mine = await getUserInheritedCapabilities(req.user!.userId);
    res.json({ capabilities: mine });
  } catch (err) {
    console.error("[capability-pool] mine error:", err);
    res.status(500).json({ error: "获取我的能力失败" });
  }
});
