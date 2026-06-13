/**
 * 问路 — 单一入口网关（per-user-brain 方案 B 终态）。
 *
 * 一个对外端口即整站入口，自给自足（不再依赖独立的 3210 平台进程）：
 *  - 静态资源（wenluDemoWeb）          → 网关自己托管。
 *  - `/api/*`（认证/会员/支付/能力池/反哺）→ 网关内挂载的 Express(createApp) 直接处理（账号级、无状态）。
 *  - **大脑端点**(/say /events /history /state /tasks /channels /decisions /memory /ui-ready
 *    /attention /riverbed-summary /connector/ws /connector/status /health)
 *      → 鉴权(cookie/Bearer/?token) 解析 userId → 按需唤起该用户的独立大脑进程(brainProcessPool) →
 *        透明反代 HTTP/SSE/WebSocket。无有效身份一律 401（不回退到任何共享大脑）。
 *
 * 因此对外只有「一个端口 + N 个内部大脑子进程」：登录前的公共内容由网关自身服务，
 * 登录后的私人大脑落到每用户专属进程。彻底取代旧的「3210 平台 + 3200 网关」两端口并存。
 *
 * 鉴权：authenticateHeaders（Bearer + httpOnly cookie wenlu_access_token）+ `?token=`（SSE/WS 用）。
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as resolvePath, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken, initJwtSecret } from "../auth/jwt.js";
import { authenticateHeaders } from "../auth/httpAuth.js";
import { bootstrapDb } from "../db/pool.js";
import { createApp } from "../api/app.js";
import { BrainProcessPool } from "./brainProcessPool.js";

const __dirname_gw = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname_gw, "..", "..");

/** 前端静态目录：并列的 ../wenluDemoWeb，回退工程内 public/。 */
const PUBLIC_DIR = (() => {
  const sibling = resolvePath(REPO_ROOT, "..", "wenluDemoWeb");
  if (existsSync(sibling)) return sibling;
  return resolvePath(REPO_ROOT, "public");
})();
const CT: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".exe": "application/octet-stream", ".dmg": "application/octet-stream",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let p: string;
  try { p = new URL(req.url ?? "/", "http://x").pathname; } catch { p = "/"; }
  if (p === "/" || !p) p = "/index.html";
  const root = resolvePath(PUBLIC_DIR);
  const f = resolvePath(PUBLIC_DIR, "." + p);
  if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
  let ok = false;
  try { ok = (await stat(f)).isFile(); } catch { ok = false; }
  if (!ok) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": CT[extname(f).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(f).pipe(res);
}

/** 大脑端点前缀：按 userId 路由到该用户的独立大脑进程；其余走网关自身（静态 / /api）。 */
const BRAIN_PREFIXES = [
  "/say", "/events", "/history", "/state", "/tasks", "/task/",
  "/channels", "/decisions", "/memory", "/ui-ready", "/attention",
  "/riverbed-summary", "/connector/ws", "/connector/status", "/health",
];

function isBrainPath(url: string): boolean {
  const path = url.split("?")[0];
  return BRAIN_PREFIXES.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(p + "/")));
}

/** 从请求解析 userId：cookie/Bearer（authenticateHeaders）优先，再尝试 `?token=`。无效返回 null。 */
function userIdFromReq(req: IncomingMessage): string | null {
  const payload = authenticateHeaders(req.headers);
  if (payload?.userId) return payload.userId;
  try {
    const u = new URL(req.url ?? "/", "http://x");
    const t = u.searchParams.get("token");
    if (t) { const p = verifyToken(t); if (p?.userId) return p.userId; }
  } catch { /* ignore */ }
  return null;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const b = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(b);
}

function flattenHeaderValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(", ");
  return v ?? "";
}

/** 透明反代一个 HTTP 请求到 host:port（SSE/分块流式透传，不缓冲）。 */
function proxyHttp(req: IncomingMessage, res: ServerResponse, host: string, port: number): void {
  const headers = { ...req.headers, host: `${host}:${port}` };
  const up = httpRequest({ host, port, path: req.url, method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad gateway" })); });
  req.pipe(up);
}

/** 透明反代一个 WS upgrade 到 host:port。 */
function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, host: string, port: number): void {
  const up = netConnect(port, host, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${flattenHeaderValue(v as string | string[])}\r\n`;
    raw += "\r\n";
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

export interface GatewayHandle {
  port: number;
  pool: BrainProcessPool;
  close(): Promise<void>;
}

export async function startGateway(opts?: { port?: number }): Promise<GatewayHandle> {
  const port = opts?.port ?? parseInt(process.env.WENLU_GATEWAY_PORT ?? "3200", 10);

  // 网关即平台：自身需要 DB（/api 账号/会员/支付）+ JWT 密钥（鉴权/签发）。
  await bootstrapDb();
  initJwtSecret();

  const pool = new BrainProcessPool({ repoRoot: REPO_ROOT });
  const expressApp = createApp(); // 处理 /api/*（认证/会员/支付/能力池/反哺）

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    // 网关自身健康（不鉴权）。
    if (req.method === "GET" && path === "/gw/health") {
      sendJson(res, 200, { ok: true, service: "wenlu-gateway", procs: pool.list() });
      return;
    }

    // 大脑端点 → 按 userId 路由到该用户独立进程（无身份 401，不回退共享脑）。
    if (isBrainPath(url)) {
      const userId = userIdFromReq(req);
      if (!userId) { sendJson(res, 401, { ok: false, error: "未授权：缺少有效身份" }); return; }
      pool.acquire(userId).then((bp) => {
        bp.lastActiveAt = Date.now();
        proxyHttp(req, res, "127.0.0.1", bp.port);
      }).catch((e) => sendJson(res, 503, { ok: false, error: `大脑进程不可用：${e instanceof Error ? e.message : e}` }));
      return;
    }

    // /api/* → 网关内置 Express（账号级，无需 per-user 进程）。
    if (path === "/api" || path.startsWith("/api/")) { expressApp(req, res); return; }

    // 其余 → 网关自托管静态资源（wenluDemoWeb）。
    void serveStatic(req, res);
  });

  // WebSocket：仅大脑端点（含连接器 /connector/ws?token=）按 userId 路由到该用户进程；其余拒绝。
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    if (!isBrainPath(url)) { socket.destroy(); return; }
    const userId = userIdFromReq(req);
    if (!userId) { socket.destroy(); return; }
    pool.acquire(userId).then((bp) => {
      bp.lastActiveAt = Date.now();
      proxyUpgrade(req, socket, head, "127.0.0.1", bp.port);
    }).catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => { server.removeAllListeners("error"); resolve(); });
    server.listen(port, "0.0.0.0");
  });

  const close = async (): Promise<void> => {
    await pool.shutdownAll();
    await new Promise<void>((r) => server.close(() => r()));
  };

  process.on("SIGINT", () => { void close().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void close().then(() => process.exit(0)); });

  return { port, pool, close };
}
