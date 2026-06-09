/**
 * 问路 — 数据库连接池。
 *
 * 职责：
 *  - 管理 PostgreSQL 连接池生命周期
 *  - 统一读取数据库配置（环境变量 → 默认值）
 *  - 提供 query / transaction helper
 */

import pg from "pg";
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
    database: process.env.WENLU_DB_NAME ?? "wenlu",
    user: process.env.WENLU_DB_USER ?? "wenlu",
    password: process.env.WENLU_DB_PASSWORD ?? "wenlu_dev",
    maxConnections: parseInt(process.env.WENLU_DB_MAX_CONN ?? "20", 10),
    idleTimeoutMs: parseInt(process.env.WENLU_DB_IDLE_TIMEOUT ?? "30000", 10),
    connectionTimeoutMs: parseInt(process.env.WENLU_DB_CONN_TIMEOUT ?? "5000", 10),
  };
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

// ---------------------------------------------------------------------------
// 初始化 schema（开发环境自动建表）
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 执行 schema.sql 初始化表结构（幂等）。 */
export async function initSchema(): Promise<void> {
  const schemaPath = resolve(__dirname, "schema.sql");
  const sql = await readFile(schemaPath, "utf-8");
  await query(sql);
  console.log("[DB] Schema 初始化完成");
}
