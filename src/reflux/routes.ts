/**
 * 技能反哺（Skill Reflux）· API 路由与 auth 接入（routes.ts）
 * ------------------------------------------------------------------
 * 对应 design.md「Integration Points · capability-pool 路由扩展」：
 *   - `/api/skills`（list / expand / inherit / mine）
 *   - `/api/reflux`（onboard / stats / pending）
 *
 * 身份接入（Req 14.1/14.3/14.4）：两组路由整体经 `requireAuth`，无有效身份一律拒绝（401）。
 * 归属（Req 17.10）：A3 已确认 per-user 隔离式——每个产生技能的用户即贡献者，直接采用
 * per-user `req.user.userId` 写入 `contributor_id`；迁移期 System_User 固定为 `local`
 * （UUID `00000000-0000-0000-0000-000000000000`，见 `harvester.SYSTEM_USER_LOCAL`），
 * 当前路由读写均以登录用户自身 `userId` 为准。
 *
 * 人工审核入口（Req 10.9/10.10）：`/api/reflux/pending` 暴露既有人工审核队列
 * （`getPendingCapabilities`），额外经 `requireAdmin` 管理员鉴权——非管理员的已登录用户
 * 调用一律 403、且不读取队列。技能审核动作复用既有 `POST /api/capabilities/review`
 * （已在 capability-pool/routes.ts 经 `requireAdmin` 保护），本模块不另建审核写入端点。
 *
 * 依赖注入：`repo`（SkillRepo）/ `dispatcher` / `onboarding` / `listMine` / `stats` /
 * `getPending` 全部可注入，便于单测脱离真实 PG。缺省走 PG 实现。
 *
 * _Requirements: 14.1, 14.3, 14.4, 17.10, 10.9, 10.10_
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { query as defaultQuery } from "../db/pool.js";
import {
  getPendingCapabilities as defaultGetPendingCapabilities,
  type CapabilityPoolRow,
} from "../capability-pool/repo.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { createOnboarding, type Onboarding } from "./onboarding.js";
import { createPgSkillRepo, type SkillRepo } from "./skillRepo.js";
import type { SkillPlatform } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// 出参类型
// ─────────────────────────────────────────────────────────────────

/** 「我已继承的技能」单条视图。 */
export interface MineSkillRow {
  skill_id: string;
  title: string;
  description: string;
  category: string;
  kind: string;
  enabled: boolean;
  acquired_at: string;
  last_used_at: string | null;
}

/** 反哺整体统计概览（最小实现；详细度量见任务 18）。 */
export interface RefluxStats {
  /** 公共技能总数（active + retired）。 */
  total_skills: number;
  /** 可分发的 active 技能数。 */
  active_skills: number;
  /** 已淘汰 retired 技能数。 */
  retired_skills: number;
  /** 总复用次数（sum use_count）。 */
  total_uses: number;
  /** 平均成功率（active 技能 success_rate 均值，无 active 时为 0）。 */
  avg_success_rate: number;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入
// ─────────────────────────────────────────────────────────────────

/** 反哺路由依赖（全部可选，缺省走 PG 实现）。 */
export interface RefluxRoutesDeps {
  /** 技能数据访问层；缺省 `createPgSkillRepo()`。 */
  repo?: SkillRepo;
  /** 检索分发器；缺省基于 `repo` 构造。 */
  dispatcher?: Dispatcher;
  /** 冷启动继承；缺省基于 `repo` 构造。 */
  onboarding?: Onboarding;
  /** 列出用户已继承技能（mine）；缺省走 PG `user_skill ⋈ skill`。 */
  listMine?: (userId: string) => Promise<MineSkillRow[]>;
  /** 反哺整体统计；缺省走 PG 聚合 `skill` 表。 */
  stats?: () => Promise<RefluxStats>;
  /** 人工审核队列（admin）；缺省复用 `capability-pool.getPendingCapabilities`。 */
  getPending?: () => Promise<CapabilityPoolRow[]>;
}

/** 两组路由器（分别挂载到 `/api/skills` 与 `/api/reflux`）。 */
export interface RefluxRouters {
  skillRouter: Router;
  refluxRouter: Router;
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 实现：mine / stats
// ─────────────────────────────────────────────────────────────────

/** 默认「我已继承的技能」查询（PG `user_skill ⋈ skill`）。 */
async function defaultListMine(userId: string): Promise<MineSkillRow[]> {
  const res = await defaultQuery<{
    skill_id: string;
    title: string;
    description: string;
    category: string;
    kind: string;
    enabled: boolean;
    acquired_at: Date | string;
    last_used_at: Date | string | null;
  }>(
    `SELECT us.skill_id, s.title, s.description, s.category, s.kind,
            us.enabled, us.acquired_at, us.last_used_at
       FROM user_skill us
       JOIN skill s ON s.id = us.skill_id
      WHERE us.user_id = $1
      ORDER BY us.acquired_at DESC`,
    [userId],
  );
  return res.rows.map((r) => ({
    skill_id: r.skill_id,
    title: r.title,
    description: r.description,
    category: r.category,
    kind: r.kind,
    enabled: r.enabled,
    acquired_at: r.acquired_at instanceof Date ? r.acquired_at.toISOString() : String(r.acquired_at),
    last_used_at:
      r.last_used_at == null
        ? null
        : r.last_used_at instanceof Date
          ? r.last_used_at.toISOString()
          : String(r.last_used_at),
  }));
}

/** 默认反哺统计（PG 聚合 `skill` 表）。 */
async function defaultStats(): Promise<RefluxStats> {
  const res = await defaultQuery<{
    total_skills: string | number;
    active_skills: string | number;
    retired_skills: string | number;
    total_uses: string | number;
    avg_success_rate: string | number | null;
  }>(
    `SELECT
       COUNT(*)                                            AS total_skills,
       COUNT(*) FILTER (WHERE status = 'active')           AS active_skills,
       COUNT(*) FILTER (WHERE status = 'retired')          AS retired_skills,
       COALESCE(SUM(use_count), 0)                         AS total_uses,
       COALESCE(AVG(success_rate) FILTER (WHERE status = 'active'), 0) AS avg_success_rate
     FROM skill`,
  );
  const row = res.rows[0];
  return {
    total_skills: Number(row?.total_skills ?? 0),
    active_skills: Number(row?.active_skills ?? 0),
    retired_skills: Number(row?.retired_skills ?? 0),
    total_uses: Number(row?.total_uses ?? 0),
    avg_success_rate: Number(row?.avg_success_rate ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────
// 工具：解析平台查询参数（仅接受 mac/win/linux/any）
// ─────────────────────────────────────────────────────────────────

function parsePlatform(raw: unknown): SkillPlatform | undefined {
  if (typeof raw !== "string") return undefined;
  return raw === "mac" || raw === "win" || raw === "linux" || raw === "any"
    ? (raw as SkillPlatform)
    : undefined;
}

function parseTags(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.length > 0) return raw.split(",").map((s) => s.trim());
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// 路由工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建反哺 API 路由器。
 * @param deps 依赖（全部可选，缺省走 PG 实现 / 基于 repo 构造 dispatcher、onboarding）。
 */
export function createRefluxRouters(deps: RefluxRoutesDeps = {}): RefluxRouters {
  const repo = deps.repo ?? createPgSkillRepo();
  const dispatcher = deps.dispatcher ?? createDispatcher({ repo });
  const onboarding = deps.onboarding ?? createOnboarding({ repo });
  const listMine = deps.listMine ?? defaultListMine;
  const stats = deps.stats ?? defaultStats;
  const getPending = deps.getPending ?? defaultGetPendingCapabilities;

  // ── /api/skills ──────────────────────────────────────────────
  const skillRouter: Router = Router();
  skillRouter.use(requireAuth); // 无身份拒绝（Req 14.4）

  /**
   * 检索公共技能（list）：category + tags + platform 筛选 → 渐进加载摘要（仅 active）。
   * Query: ?category=&tags=a,b&platform=win&topK=&query=
   */
  skillRouter.get("/", async (req: Request, res: Response) => {
    try {
      const results = await dispatcher.retrieve({
        userId: req.user!.userId,
        query: typeof req.query.query === "string" ? req.query.query : undefined,
        category: typeof req.query.category === "string" ? req.query.category : undefined,
        tags: parseTags(req.query.tags),
        platform: parsePlatform(req.query.platform),
        topK: req.query.topK ? Number(req.query.topK) : undefined,
      });
      res.json({ skills: results });
    } catch (err) {
      console.error("[reflux/skills] list error:", err);
      res.status(500).json({ error: "检索技能失败" });
    }
  });

  /**
   * 我已继承的技能（mine）。
   */
  skillRouter.get("/mine", async (req: Request, res: Response) => {
    try {
      const mine = await listMine(req.user!.userId);
      res.json({ skills: mine });
    } catch (err) {
      console.error("[reflux/skills] mine error:", err);
      res.status(500).json({ error: "获取我的技能失败" });
    }
  });

  /**
   * 继承公共技能（inherit）：幂等（同 (user, skill) 只继承一次）。
   * Body: { skillIds?: string[] }  — 不传则继承全部 active 公共技能。
   */
  skillRouter.post("/inherit", async (req: Request, res: Response) => {
    const { skillIds } = (req.body ?? {}) as { skillIds?: string[] };
    try {
      const result = await dispatcher.inherit(req.user!.userId, skillIds);
      res.json({ success: true, count: result.count, inherited: result.inherited });
    } catch (err) {
      console.error("[reflux/skills] inherit error:", err);
      res.status(500).json({ error: "继承技能失败" });
    }
  });

  /**
   * 渐进加载第二段（expand）：展开完整 exec_steps / 各平台变体。
   */
  skillRouter.get("/:id/expand", async (req: Request, res: Response) => {
    try {
      const skill = await dispatcher.expand(String(req.params.id), req.user!.userId);
      if (!skill) {
        res.status(404).json({ error: "技能不存在" });
        return;
      }
      res.json({ skill });
    } catch (err) {
      console.error("[reflux/skills] expand error:", err);
      res.status(500).json({ error: "展开技能失败" });
    }
  });

  // ── /api/reflux ──────────────────────────────────────────────
  const refluxRouter: Router = Router();
  refluxRouter.use(requireAuth); // 无身份拒绝（Req 14.4）

  /**
   * 冷启动继承（onboard）：经唯一约束保证最多一次，并发/重复返回既有结果。
   * Body: { platform?: "mac"|"win"|"linux"|"any" }
   */
  refluxRouter.post("/onboard", async (req: Request, res: Response) => {
    const platform = parsePlatform((req.body ?? {}).platform);
    try {
      const result = await onboarding.onboard(req.user!.userId, platform);
      res.json(result);
    } catch (err) {
      console.error("[reflux] onboard error:", err);
      res.status(500).json({ error: "冷启动继承失败" });
    }
  });

  /**
   * 反哺整体统计（stats）。
   */
  refluxRouter.get("/stats", async (_req: Request, res: Response) => {
    try {
      const s = await stats();
      res.json(s);
    } catch (err) {
      console.error("[reflux] stats error:", err);
      res.status(500).json({ error: "获取统计失败" });
    }
  });

  /**
   * 人工审核队列（pending，admin）：暴露既有人工审核队列。
   * 经 `requireAdmin` 管理员鉴权（Req 10.10）——非管理员的已登录用户调用 → 403，且不读取队列。
   */
  refluxRouter.get("/pending", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const pending = await getPending();
      res.json({ pending });
    } catch (err) {
      console.error("[reflux] pending error:", err);
      res.status(500).json({ error: "获取待审列表失败" });
    }
  });

  return { skillRouter, refluxRouter };
}
