/**
 * 技能反哺（Skill Reflux）· 轨迹环形缓冲（trajectoryBuffer.ts）
 * ------------------------------------------------------------------
 * 对应 design.md「轨迹与调用事件表（明细表方案，见 ADR-3）」与表 `trajectory_event`。
 *
 * 职责（Req 3.1/3.2/3.6）：
 *  - `recordAction`：追加写 `trajectory_event`（明细表 append-only，每次 executeTool 一行）。
 *  - `getRecent`：按 `(user_id, ts DESC)` 取最近 N 条。
 *  - `pruneTrajectory`：裁剪清理任务——每用户保留「最近 N 条」∪「最近 T 小时」（双条件并集），
 *    删除两者都不命中的超出部分。N/T 取自 `config.ts` 的 `Traj_N`/`Traj_T_ms`。
 *
 * 持久化与一致性（Req 3.6）：
 *  - 轨迹以**明细表**（append-only）持久化在 PostgreSQL，而非「每用户一行 JSON」内存态，
 *    因此进程重启后可直接从 PG 恢复历史轨迹，无需额外回放逻辑；
 *  - 多进程/多副本并发写同一用户轨迹时，各自只做 INSERT 追加，明细表天然无写冲突，
 *    读路径以 `(user_id, ts DESC)` 排序取最近 N，故多进程一致性由明细表结构天然满足。
 *
 * 多用户隔离（multiuser-pg-store A3 / 005_rls.sql）：
 *  - 所有读写均经 `src/db/pool.ts` 的 `withUser` 入口，设置会话变量 `app.current_user_id`
 *    使 Row-Level Security 生效（缺失会话变量时 RLS fail-closed，查询返回空 / 写入被拒）。
 *
 * 注意：表 `trajectory_event` 的建表由任务 2 的增量迁移（006_skill_reflux.sql）负责，
 * 本模块**只写数据访问 / 裁剪逻辑，不重复建表**；代码按「表已由迁移创建」假设编写。
 *
 * _Requirements: 3.1, 3.2, 3.6_
 */

import { withUser as defaultWithUser } from "../db/pool.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { TrajectoryEvent } from "./types.js";

// ── 依赖抽象（便于单测注入 mock query / withUser，不必连真实 PG） ──

/** 最小化的「带 query 的客户端」抽象（与 pg.PoolClient 结构兼容）。 */
export interface TrajectoryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** 用户作用域执行入口抽象（默认实现为 pool.ts 的 `withUser`）。 */
export type WithUserFn = <T>(
  userId: string,
  fn: (client: TrajectoryClient) => Promise<T>,
) => Promise<T>;

/** 轨迹缓冲依赖（全部可选，默认走真实 PG + 默认配置）。 */
export interface TrajectoryBufferDeps {
  /** 用户作用域执行入口；默认 `src/db/pool.ts` 的 `withUser`（启用 RLS）。 */
  withUser?: WithUserFn;
  /** 反哺配置（取 `Traj_N`/`Traj_T_ms`）；默认 `DEFAULT_REFLUX_CONFIG`。 */
  config?: RefluxConfig;
}

/** 轨迹环形缓冲对外接口。 */
export interface TrajectoryBuffer {
  /** 追加写一条轨迹明细（append-only）。 */
  recordAction(ev: TrajectoryEvent): Promise<void>;
  /** 按 (user_id, ts DESC) 取最近 n 条（n 缺省取 config.Traj_N）。 */
  getRecent(userId: string, n?: number): Promise<TrajectoryEvent[]>;
  /** 裁剪清理：保留「最近 N 条」∪「最近 T 小时」，删除超出部分，返回删除行数。 */
  pruneTrajectory(userId: string): Promise<number>;
}

// ── 行 → TrajectoryEvent 映射（timestamptz 统一转 ISO 字符串，null → undefined） ──

interface TrajectoryRow {
  id: number | string;
  user_id: string;
  cycle: number | null;
  task_id: string | null;
  action_name: string;
  args_summary: string | null;
  result_summary: string | null;
  ts: Date | string;
  // 满足 TrajectoryClient.query 的 `T extends Record<string, unknown>` 约束。
  [key: string]: unknown;
}

function toIso(ts: Date | string): string {
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

function mapRow(row: TrajectoryRow): TrajectoryEvent {
  return {
    id: typeof row.id === "string" ? Number(row.id) : row.id,
    user_id: row.user_id,
    cycle: row.cycle ?? undefined,
    task_id: row.task_id ?? undefined,
    action_name: row.action_name,
    args_summary: row.args_summary ?? undefined,
    result_summary: row.result_summary ?? undefined,
    ts: toIso(row.ts),
  };
}

// ── 工厂：创建轨迹缓冲实例（可注入依赖做单测） ──

/**
 * 创建轨迹环形缓冲实例。
 * @param deps 可选依赖；不传则默认走真实 PG（`withUser`）+ 默认配置。
 */
export function createTrajectoryBuffer(deps: TrajectoryBufferDeps = {}): TrajectoryBuffer {
  // 默认 withUser 包一层，把 pg.PoolClient 适配为 TrajectoryClient（结构兼容）。
  const withUser: WithUserFn =
    deps.withUser ??
    ((userId, fn) => defaultWithUser(userId, (client) => fn(client as unknown as TrajectoryClient)));
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;

  return {
    async recordAction(ev: TrajectoryEvent): Promise<void> {
      // append-only：每次 executeTool 追加一行明细，ts 缺省由 DB 默认 now() 落库。
      await withUser(ev.user_id, async (client) => {
        await client.query(
          `INSERT INTO trajectory_event
             (user_id, cycle, task_id, action_name, args_summary, result_summary)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ev.user_id,
            ev.cycle ?? null,
            ev.task_id ?? null,
            ev.action_name,
            ev.args_summary ?? null,
            ev.result_summary ?? null,
          ],
        );
      });
    },

    async getRecent(userId: string, n: number = config.Traj_N): Promise<TrajectoryEvent[]> {
      // 取最近 n 条：(user_id, ts DESC)，同 ts 以 id DESC 兜底稳定排序。
      const limit = Math.max(0, Math.floor(n));
      if (limit === 0) return [];
      return withUser(userId, async (client) => {
        const res = await client.query<TrajectoryRow>(
          `SELECT id, user_id, cycle, task_id, action_name, args_summary, result_summary, ts
             FROM trajectory_event
            WHERE user_id = $1
            ORDER BY ts DESC, id DESC
            LIMIT $2`,
          [userId, limit],
        );
        return res.rows.map(mapRow);
      });
    },

    async pruneTrajectory(userId: string): Promise<number> {
      // 保留策略 = 「最近 N 条」∪「最近 T 小时」：
      //   - 命中最近 N 条（id ∈ 子查询）→ 保留；
      //   - 或 ts ≥ now()-T（cutoff）→ 保留；
      //   - 仅当两者都不命中（ts < cutoff 且不在最近 N 条）才删除。
      const keepN = Math.max(0, Math.floor(config.Traj_N));
      const cutoffIso = new Date(Date.now() - config.Traj_T_ms).toISOString();
      return withUser(userId, async (client) => {
        const res = await client.query<{ id: number | string }>(
          `DELETE FROM trajectory_event
            WHERE user_id = $1
              AND ts < $2
              AND id NOT IN (
                SELECT id FROM trajectory_event
                 WHERE user_id = $1
                 ORDER BY ts DESC, id DESC
                 LIMIT $3
              )
          RETURNING id`,
          [userId, cutoffIso, keepN],
        );
        return res.rows.length;
      });
    },
  };
}

// ── 默认实例（绑定真实 PG）：供生产代码直接调用 ──

const defaultBuffer = createTrajectoryBuffer();

/** 追加写一条轨迹明细（默认实例，走真实 PG）。 */
export function recordAction(ev: TrajectoryEvent): Promise<void> {
  return defaultBuffer.recordAction(ev);
}

/** 按 (user_id, ts DESC) 取最近 n 条（默认实例，走真实 PG）。 */
export function getRecent(userId: string, n?: number): Promise<TrajectoryEvent[]> {
  return defaultBuffer.getRecent(userId, n);
}

/** 裁剪清理：保留「最近 N 条」∪「最近 T 小时」，删除超出部分（默认实例，走真实 PG）。 */
export function pruneTrajectory(userId: string): Promise<number> {
  return defaultBuffer.pruneTrajectory(userId);
}
