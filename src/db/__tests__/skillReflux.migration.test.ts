/**
 * 006_skill_reflux 增量迁移测试（skill-reflux 任务 2.4）。
 *
 * 两部分：
 *  1) 平台值归一纯逻辑单测（始终运行，不依赖 DB）——Req 1.2/1.4 读路径归一。
 *  2) 迁移幂等性集成测试（仅在本机 PG 可连时运行）——Req 1.4：二次应用不改变 schema 状态。
 *     连不上 PG 则自动跳过（保留测试，不让 CI/本地无库时失败）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  normalizePlatform,
  normalizeVariantOs,
  normalizePlatformList,
} from "../platformNormalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1) 平台值归一纯逻辑（Req 1.2：win32→win、darwin→mac，统一枚举）
// ---------------------------------------------------------------------------
describe("平台值归一（读路径双重保证）", () => {
  it("旧值归一：win32→win、darwin→mac", () => {
    expect(normalizePlatform("win32")).toBe("win");
    expect(normalizePlatform("darwin")).toBe("mac");
  });

  it("大小写/空白不敏感", () => {
    expect(normalizePlatform("  WIN32 ")).toBe("win");
    expect(normalizePlatform("Darwin")).toBe("mac");
    expect(normalizePlatform("LINUX")).toBe("linux");
  });

  it("统一枚举原样保留", () => {
    expect(normalizePlatform("mac")).toBe("mac");
    expect(normalizePlatform("win")).toBe("win");
    expect(normalizePlatform("linux")).toBe("linux");
    expect(normalizePlatform("any")).toBe("any");
  });

  it("空/未知值兜底为 any", () => {
    expect(normalizePlatform(null)).toBe("any");
    expect(normalizePlatform(undefined)).toBe("any");
    expect(normalizePlatform("solaris")).toBe("any");
  });

  it("可执行变体平台：any/未知返回 null", () => {
    expect(normalizeVariantOs("win32")).toBe("win");
    expect(normalizeVariantOs("darwin")).toBe("mac");
    expect(normalizeVariantOs("any")).toBeNull();
    expect(normalizeVariantOs(undefined)).toBeNull();
  });

  it("平台数组归一并去重", () => {
    expect(normalizePlatformList(["win32", "win", "darwin"]).sort()).toEqual(["mac", "win"]);
    expect(normalizePlatformList([])).toEqual(["any"]);
    expect(normalizePlatformList(null)).toEqual(["any"]);
  });
});

// ---------------------------------------------------------------------------
// 2) 迁移幂等性（Req 1.4）：连本机 PG 才跑
// ---------------------------------------------------------------------------

/** 反哺迁移新增的表清单，用于快照比对。 */
const REFLUX_TABLES = [
  "skill",
  "skill_platform_variant",
  "skill_candidate",
  "skill_harvest_queue",
  "skill_contributor",
  "user_skill",
  "trajectory_event",
  "skill_invocation_event",
  "onboarding_state",
  "render_hint_template",
];

async function tryConnect(): Promise<pg.Client | null> {
  const client = new pg.Client({
    host: process.env.WENLU_DB_HOST ?? "127.0.0.1",
    port: parseInt(process.env.WENLU_DB_PORT ?? "5432", 10),
    database: process.env.WENLU_DB_NAME ?? "wenlu",
    user: process.env.WENLU_DB_USER ?? "postgres",
    password: process.env.WENLU_DB_PASSWORD ?? "Wenlu@Pg2026",
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    try { await client.end(); } catch { /* ignore */ }
    return null;
  }
}

/** 抓取反哺各表的列定义快照（表名 + 列名 + 类型 + 默认值 + 可空），用于比对 schema 是否变化。 */
async function snapshotSchema(client: pg.Client): Promise<string> {
  const r = await client.query(
    `SELECT table_name, column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [REFLUX_TABLES],
  );
  return JSON.stringify(r.rows);
}

let client: pg.Client | null = null;
let migrationSql = "";

beforeAll(async () => {
  migrationSql = await readFile(resolve(__dirname, "../migrations/006_skill_reflux.sql"), "utf-8");
  client = await tryConnect();
});

afterAll(async () => {
  if (client) {
    try { await client.end(); } catch { /* ignore */ }
  }
});

describe("006_skill_reflux 迁移幂等性（需本机 PG）", () => {
  it("二次应用不改变 schema 状态，且不半截写入", async () => {
    if (!client) {
      console.warn("[skip] 未连上本机 PG，跳过 006 迁移幂等性集成测试");
      return;
    }
    const db = client;
    // 在事务内执行，结束 ROLLBACK，不污染真实库。
    await db.query("BEGIN");
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // 第一次应用 → 快照 A
      await db.query(migrationSql);
      const snapA = await snapshotSchema(db);

      // 第二次应用 → 快照 B（幂等：应与 A 完全一致）
      await db.query(migrationSql);
      const snapB = await snapshotSchema(db);

      expect(snapB).toEqual(snapA);
      // 反哺新增的 10 张表均应存在
      const present = JSON.parse(snapA) as Array<{ table_name: string }>;
      const names = new Set(present.map((row) => row.table_name));
      for (const t of REFLUX_TABLES) {
        expect(names.has(t), `缺少表 ${t}`).toBe(true);
      }
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
