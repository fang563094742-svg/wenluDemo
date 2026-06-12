/**
 * 轨迹环形缓冲（trajectoryBuffer）单元测试。
 *
 * 用注入式 mock `withUser` + 内存明细表模拟 PG，独立可跑（不连真实数据库）：
 *  - mock `withUser` 直接把同一个内存 client 交给回调（不做 RLS，仅验证数据访问/裁剪逻辑）；
 *  - mock client 按 SQL 关键字（INSERT/SELECT/DELETE）解释意图，在内存数组上模拟语义，
 *    从而真实验证 recordAction 追加、getRecent 排序取最近 N、pruneTrajectory 双条件并集裁剪。
 *
 * _Requirements: 3.1, 3.2, 3.6_
 */

import { describe, expect, it } from "vitest";

import {
  createTrajectoryBuffer,
  type TrajectoryClient,
  type WithUserFn,
} from "./trajectoryBuffer.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { TrajectoryEvent } from "./types.js";

/** 内存明细表行（与 trajectory_event 列对应）。 */
interface Row {
  id: number;
  user_id: string;
  cycle: number | null;
  task_id: string | null;
  action_name: string;
  args_summary: string | null;
  result_summary: string | null;
  ts: Date;
}

/**
 * 构造一个解释 SQL 意图的内存 client + withUser。
 * 仅识别本模块用到的三条语句（INSERT / SELECT 最近 N / DELETE 双条件裁剪）。
 */
function makeMemStore(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  // 最近排序：ts DESC, id DESC。
  const recentSorted = (userId: string) =>
    rows
      .filter((r) => r.user_id === userId)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id);

  const client: TrajectoryClient = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, " ").trim().toUpperCase();

      if (sql.startsWith("INSERT INTO TRAJECTORY_EVENT")) {
        const [user_id, cycle, task_id, action_name, args_summary, result_summary] = params as [
          string,
          number | null,
          string | null,
          string,
          string | null,
          string | null,
        ];
        rows.push({
          id: nextId++,
          user_id,
          cycle,
          task_id,
          action_name,
          args_summary,
          result_summary,
          ts: new Date(),
        });
        return { rows: [] as T[] };
      }

      if (sql.startsWith("SELECT")) {
        const [userId, limit] = params as [string, number];
        const picked = recentSorted(userId).slice(0, limit);
        return { rows: picked as unknown as T[] };
      }

      if (sql.startsWith("DELETE FROM TRAJECTORY_EVENT")) {
        const [userId, cutoffIso, keepN] = params as [string, string, number];
        const cutoff = new Date(cutoffIso).getTime();
        const keepIds = new Set(recentSorted(userId).slice(0, keepN).map((r) => r.id));
        const deleted: Row[] = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r.user_id !== userId) continue;
          const olderThanT = r.ts.getTime() < cutoff;
          const inRecentN = keepIds.has(r.id);
          if (olderThanT && !inRecentN) {
            deleted.push(r);
            rows.splice(i, 1);
          }
        }
        return { rows: deleted.map((r) => ({ id: r.id })) as unknown as T[] };
      }

      throw new Error(`未识别的 SQL: ${text}`);
    },
  };

  const withUser: WithUserFn = (_userId, fn) => fn(client);
  return { rows, withUser };
}

const cfg = (over: Partial<RefluxConfig>): RefluxConfig => ({ ...DEFAULT_REFLUX_CONFIG, ...over });

describe("trajectoryBuffer", () => {
  it("recordAction 追加写明细（append-only）", async () => {
    const store = makeMemStore();
    const buf = createTrajectoryBuffer({ withUser: store.withUser });

    const ev: TrajectoryEvent = {
      user_id: "u1",
      cycle: 7,
      task_id: "t-1",
      action_name: "run_command",
      args_summary: "ls",
    };
    await buf.recordAction(ev);
    await buf.recordAction({ user_id: "u1", action_name: "read_file" });

    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({
      user_id: "u1",
      cycle: 7,
      task_id: "t-1",
      action_name: "run_command",
      args_summary: "ls",
      result_summary: null,
    });
    expect(store.rows[1]).toMatchObject({ user_id: "u1", action_name: "read_file", cycle: null });
  });

  it("getRecent 按 ts DESC 取最近 N，且按 user 隔离", async () => {
    const base = Date.now();
    const seed: Row[] = [
      mkRow(1, "u1", base - 3000, "a"),
      mkRow(2, "u1", base - 2000, "b"),
      mkRow(3, "u1", base - 1000, "c"),
      mkRow(4, "u2", base - 500, "x"),
    ];
    const store = makeMemStore(seed);
    const buf = createTrajectoryBuffer({ withUser: store.withUser });

    const recent = await buf.getRecent("u1", 2);
    expect(recent.map((r) => r.action_name)).toEqual(["c", "b"]);
    // 返回值已映射：ts 为 ISO 字符串。
    expect(typeof recent[0].ts).toBe("string");

    // n 缺省时取 config.Traj_N。
    const all = await buf.getRecent("u1");
    expect(all.map((r) => r.action_name)).toEqual(["c", "b", "a"]);

    // n=0 直接返回空，不查询。
    expect(await buf.getRecent("u1", 0)).toEqual([]);
  });

  it("pruneTrajectory 保留「最近 N 条」∪「最近 T 小时」并集，删除超出部分", async () => {
    const base = Date.now();
    // 5 条：3 条在 T 小时内（新），2 条超过 T 小时（旧）。
    const seed: Row[] = [
      mkRow(1, "u1", base - 100 * 3600_000, "old-1"), // 100h 前（旧）
      mkRow(2, "u1", base - 90 * 3600_000, "old-2"), // 90h 前（旧）
      mkRow(3, "u1", base - 2 * 3600_000, "new-1"), // 2h 前（新）
      mkRow(4, "u1", base - 1 * 3600_000, "new-2"), // 1h 前（新）
      mkRow(5, "u1", base - 0.5 * 3600_000, "new-3"), // 0.5h 前（新）
    ];
    const store = makeMemStore(seed);
    // N=2、T=24h：最近 N 条 = {new-3,new-2}；最近 T 小时 = {new-1,new-2,new-3}。
    // 并集 = {new-1,new-2,new-3}；应删除两条旧记录 old-1/old-2。
    const buf = createTrajectoryBuffer({
      withUser: store.withUser,
      config: cfg({ Traj_N: 2, Traj_T_ms: 24 * 3600_000 }),
    });

    const deleted = await buf.pruneTrajectory("u1");
    expect(deleted).toBe(2);
    const left = store.rows.filter((r) => r.user_id === "u1").map((r) => r.action_name).sort();
    expect(left).toEqual(["new-1", "new-2", "new-3"]);
  });

  it("pruneTrajectory：最近 N 条即使超过 T 小时也保留（并集而非交集）", async () => {
    const base = Date.now();
    // 全部都超过 T 小时（旧），但 N=2 应强制保留最近 2 条。
    const seed: Row[] = [
      mkRow(1, "u1", base - 100 * 3600_000, "old-1"),
      mkRow(2, "u1", base - 90 * 3600_000, "old-2"),
      mkRow(3, "u1", base - 80 * 3600_000, "old-3"),
    ];
    const store = makeMemStore(seed);
    const buf = createTrajectoryBuffer({
      withUser: store.withUser,
      config: cfg({ Traj_N: 2, Traj_T_ms: 24 * 3600_000 }),
    });

    const deleted = await buf.pruneTrajectory("u1");
    // 最近 2 条（old-3,old-2）因命中「最近 N」保留；仅 old-1 被删。
    expect(deleted).toBe(1);
    const left = store.rows.map((r) => r.action_name).sort();
    expect(left).toEqual(["old-2", "old-3"]);
  });
});

function mkRow(id: number, user: string, tsMs: number, action: string): Row {
  return {
    id,
    user_id: user,
    cycle: null,
    task_id: null,
    action_name: action,
    args_summary: null,
    result_summary: null,
    ts: new Date(tsMs),
  };
}
