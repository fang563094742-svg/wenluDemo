import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as resolvePath, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

import { verifyToken, initJwtSecret } from "../auth/jwt.js";
import { authenticateHeaders } from "../auth/httpAuth.js";
import { bootstrapDb } from "../db/pool.js";
import { findUserById } from "../db/userRepo.js";
import { createApp } from "../api/app.js";
import { BrainProcessPool } from "./brainProcessPool.js";

const __dirnameGw = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirnameGw, "..", "..");

const PUBLIC_DIR = (() => {
  const sibling = resolvePath(REPO_ROOT, "..", "wenluDemoWeb");
  if (existsSync(sibling)) return sibling;
  return resolvePath(REPO_ROOT, "public");
})();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".exe": "application/octet-stream",
  ".dmg": "application/octet-stream",
};

const BRAIN_PREFIXES = [
  "/say",
  "/events",
  "/history",
  "/state",
  "/tasks",
  "/task/",
  "/channels",
  "/decisions",
  "/memory",
  "/ui-ready",
  "/attention",
  "/riverbed-summary",
  "/connector/ws",
  "/connector/status",
  "/health",
];

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    pathname = "/";
  }
  if (pathname === "/" || !pathname) pathname = "/index.html";

  const root = resolvePath(PUBLIC_DIR);
  const filePath = resolvePath(PUBLIC_DIR, "." + pathname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }

  let ok = false;
  try {
    ok = (await stat(filePath)).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function isBrainPath(url: string): boolean {
  const path = url.split("?")[0];
  return BRAIN_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(prefix + "/"));
}

function userIdFromReq(req: IncomingMessage): string | null {
  const payload = authenticateHeaders(req.headers);
  if (payload?.userId) return payload.userId;
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const token = url.searchParams.get("token");
    if (token) {
      const decoded = verifyToken(token);
      if (decoded?.userId) return decoded.userId;
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveExistingUserId(req: IncomingMessage): Promise<string | null> {
  const userId = userIdFromReq(req);
  if (!userId) return null;
  const user = await findUserById(userId);
  return user?.id ?? null;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function flattenHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, host: string, port: number): void {
  const headers = { ...req.headers, host: `${host}:${port}` };
  const upstream = httpRequest({ host, port, path: req.url, method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ ok: false, error: "bad gateway" }));
  });
  req.pipe(upstream);
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, host: string, port: number): void {
  const upstream = netConnect(port, host, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(req.headers)) {
      raw += `${key}: ${flattenHeaderValue(value as string | string[])}\r\n`;
    }
    raw += "\r\n";
    upstream.write(raw);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export interface GatewayHandle {
  port: number;
  pool: BrainProcessPool;
  close(): Promise<void>;
}

export async function startGateway(opts?: { port?: number }): Promise<GatewayHandle> {
  const port = opts?.port ?? parseInt(process.env.WENLU_GATEWAY_PORT ?? "3200", 10);

  await bootstrapDb();
  initJwtSecret();

  const pool = new BrainProcessPool({ repoRoot: REPO_ROOT });
  const expressApp = createApp();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (req.method === "GET" && path === "/gw/health") {
      sendJson(res, 200, { ok: true, service: "wenlu-gateway", procs: pool.list() });
      return;
    }

    if (isBrainPath(url)) {
      void resolveExistingUserId(req)
        .then((userId) => {
          if (!userId) {
            sendJson(res, 401, { ok: false, error: "登录已失效，请重新登录" });
            return;
          }
          pool.acquire(userId)
            .then((bp) => {
              bp.lastActiveAt = Date.now();
              proxyHttp(req, res, "127.0.0.1", bp.port);
            })
            .catch((error) => {
              sendJson(res, 503, {
                ok: false,
                error: `大脑进程不可用：${error instanceof Error ? error.message : error}`,
              });
            });
        })
        .catch(() => {
          sendJson(res, 503, { ok: false, error: "大脑路由前置校验失败" });
        });
      return;
    }

    if (path === "/api" || path.startsWith("/api/")) {
      expressApp(req, res);
      return;
    }

    void serveStatic(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    if (!isBrainPath(url)) {
      socket.destroy();
      return;
    }

    void resolveExistingUserId(req)
      .then((userId) => {
        if (!userId) {
          try {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          } catch {}
          socket.destroy();
          return;
        }
        pool.acquire(userId)
          .then((bp) => {
            bp.lastActiveAt = Date.now();
            proxyUpgrade(req, socket, head, "127.0.0.1", bp.port);
          })
          .catch(() => socket.destroy());
      })
      .catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.removeAllListeners("error");
      resolve();
    });
    server.listen(port, "0.0.0.0");
  });

  const close = async (): Promise<void> => {
    await pool.shutdownAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  process.on("SIGINT", () => { void close().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void close().then(() => process.exit(0)); });

  return { port, pool, close };
}
