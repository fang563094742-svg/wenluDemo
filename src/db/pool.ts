/**
 * 问路 — 数据库连接池。
 *
 * 职责：
 *  - 管理 PostgreSQL 连接池生命周期
 *  - 统一读取数据库配置（环境变量 → 默认值）
 *  - 提供 query / transaction / withUser helper
 *  - ensureDatabase：业务库不存在则创建（幂等）
 *  - initSchema：按迁移追踪表顺序应用 schema.sql + migrations/*.sql（幂等）
 */

import pg from "pg";
import { existsSync } from "node:fs";
const { Pool } = pg;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

function loadDbConfig(): DbConfig {
  return {
    host: process.env.WENLU_DB_HOST ?? "127.0.0.1",
    port: parseInt(process.env.WENLU_DB_PORT ?? "5432", 10),
    // 决策 A1：业务库 wenlu，账号 postgres
    database: process.env.WENLU_DB_NAME ?? "wenlu",
    user: process.env.WENLU_DB_USER ?? "postgres",
    password: process.env.WENLU_DB_PASSWORD ?? "Wenlu@Pg2026",
    maxConnections: parseInt(process.env.WENLU_DB_MAX_CONN ?? "20", 10),
    idleTimeoutMs: parseInt(process.env.WENLU_DB_IDLE_TIMEOUT ?? "30000", 10),
    connectionTimeoutMs: parseInt(process.env.WENLU_DB_CONN_TIMEOUT ?? "5000", 10),
  };
}

/** 维护期/建库用的管理库（默认连 postgres 库执行 CREATE DATABASE）。 */
function adminDatabaseName(): string {
  return process.env.WENLU_DB_ADMIN_NAME ?? "postgres";
}

// ---------------------------------------------------------------------------
// 连接池单例
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = loadDbConfig();
    pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      max: cfg.maxConnections,
      idleTimeoutMillis: cfg.idleTimeoutMs,
      connectionTimeoutMillis: cfg.connectionTimeoutMs,
    });
    pool.on("error", (err) => {
      console.error("[DB] 连接池异常:", err.message);
    });
  }
  return pool;
}

/** 优雅关闭连接池（进程退出时调用）。 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// 通用 query helper
// ---------------------------------------------------------------------------

export type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;

/** 执行 SQL 查询。 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** 事务 helper：自动 BEGIN / COMMIT，出错 ROLLBACK。 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 用户作用域执行：取连接 → 设置 RLS 会话变量 app.current_user_id → 执行 fn → 释放。
 *
 * 所有「个人数据」读写都必须经此入口，使数据库 Row-Level Security 生效：
 * 缺失会话变量时 RLS 策略判 false（fail-closed），查询返回空 / 写入被拒。
 *
 * 注意：SET LOCAL 仅在事务内有效，故此处包一层事务。
 */
export async function withUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // set_config(name, value, is_local=true)：仅当前事务有效，随连接归还自动失效。
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 建库（ensureDatabase）
// ---------------------------------------------------------------------------

/**
 * 确保业务库存在：连管理库（postgres）检查目标库，不存在则创建。
 * CREATE DATABASE 不能在事务内执行，故用独立一次性 Client。幂等。
 */
export async function ensureDatabase(): Promise<void> {
  const cfg = loadDbConfig();
  const admin = adminDatabaseName();
  if (cfg.database === admin) return; // 直接用管理库则无需建库

  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: admin,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: cfg.connectionTimeoutMs,
  });
  await client.connect();
  try {
    const exists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [cfg.database],
    );
    if (exists.rows.length === 0) {
      // 库名来自配置（非用户输入），用标识符引号防注入。
      await client.query(`CREATE DATABASE "${cfg.database.replace(/"/g, '""')}"`);
      console.log(`[DB] 已创建业务库 ${cfg.database}`);
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// 初始化 schema（基础 schema.sql + migrations/*.sql，迁移追踪表保证幂等）
// ---------------------------------------------------------------------------

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 执行 schema 初始化（幂等）：
 *  1. 建迁移追踪表 schema_migrations。
 *  2. 跑基础 schema.sql（全 IF NOT EXISTS / ON CONFLICT，可重复执行）。
 *  3. 按文件名顺序应用 migrations/*.sql 中尚未记录的迁移，每个在事务内执行并登记。
 */
export async function initSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 基础 schema（账号/会话/付费/分享等，全部幂等）。
  const baseSql = await readFile(resolve(__dirname, "schema.sql"), "utf-8");
  await query(baseSql);

  // 迁移目录：按文件名升序应用未登记者。
  const migrationsDir = resolve(__dirname, "migrations");
  let files: string[] = [];
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    files = [];
  }

  const applied = await query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(resolve(migrationsDir, file), "utf-8");
    await transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    });
    console.log(`[DB] 已应用迁移 ${file}`);
  }

  console.log("[DB] Schema 初始化完成");
}

// ---------------------------------------------------------------------------
// 启动引导（ensureDatabase → initSchema → 连通自检）
// ---------------------------------------------------------------------------

/**
 * 启动期数据库引导：建库 → 应用 schema/迁移 → 连通自检。
 * 任一步失败即抛错；调用方（riverMain 启动序列）应据此显式失败并退出，
 * 严禁以「无持久化 / 文件回退」的降级方式继续运行（Requirements 11.3）。
 */
export async function bootstrapDb(): Promise<void> {
  await ensureDatabase();
  await initSchema();
  // 连通自检：确认业务库可读。
  const r = await query<{ ok: number }>("SELECT 1 AS ok");
  if (r.rows[0]?.ok !== 1) {
    throw new Error("[DB] 连通自检失败：SELECT 1 未返回预期结果");
  }
  console.log("[DB] 启动引导完成，PostgreSQL 就绪");
}
