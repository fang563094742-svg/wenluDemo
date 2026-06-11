/**
 * 问路 — 多用户网关（multiuser-pg-store 阶段二）。
 *
 * 职责：对外一个端口，鉴权(JWT) → 解析 userId → 按需唤起该用户的大脑进程(进程池) →
 * 把 HTTP / SSE / WebSocket 透明反代到该用户的大脑进程。每个用户的大脑进程完全隔离，
 * 跨用户绝不串数据。无有效身份一律 401（不回退到任何共享大脑）。
 *
 * 与既有 3210 单用户链路并存：3210 仍是 local 单脑（旧 UI/连接器直连）；网关是多用户新入口。
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken } from "../auth/jwt.js";
import { BrainProcessPool } from "./brainProcessPool.js";

const __dirname_gw = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname_gw, "..", "..");

/** 从请求解析 userId：Authorization: Bearer，或 ?token=（供 EventSource/WS 无法设头时用）。无效返回 null。 */
function userIdFromReq(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const p = verifyToken(auth.slice(7));
    if (p?.userId) return p.userId;
  }
  try {
    const u = new URL(req.url ?? "/", "http://x");
    const t = u.searchParams.get("token");
    if (t) {
      const p = verifyToken(t);
      if (p?.userId) return p.userId;
    }
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

export interface GatewayHandle {
  port: number;
  pool: BrainProcessPool;
  close(): Promise<void>;
}

export async function startGateway(opts?: { port?: number }): Promise<GatewayHandle> {
  const port = opts?.port ?? parseInt(process.env.WENLU_GATEWAY_PORT ?? "3200", 10);
  const pool = new BrainProcessPool({ repoRoot: REPO_ROOT });

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    // 网关自身健康/状态（不鉴权）。
    if (req.method === "GET" && url === "/gw/health") {
      sendJson(res, 200, { ok: true, service: "wenlu-gateway", procs: pool.list() });
      return;
    }

    const userId = userIdFromReq(req);
    if (!userId) { sendJson(res, 401, { ok: false, error: "未授权：缺少有效身份" }); return; }

    pool.acquire(userId).then((bp) => {
      bp.lastActiveAt = Date.now();
      const headers = { ...req.headers, host: `127.0.0.1:${bp.port}` };
      const up = httpRequest(
        { host: "127.0.0.1", port: bp.port, path: url, method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res); // SSE/分块流式透传：不缓冲
        },
      );
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad gateway" })); });
      req.pipe(up);
    }).catch((e) => {
      sendJson(res, 503, { ok: false, error: `大脑进程不可用：${e instanceof Error ? e.message : e}` });
    });
  });

  // WebSocket 反代（连接器 /connector/ws 等）。
  server.on("upgrade", (req, socket, head) => {
    const userId = userIdFromReq(req);
    if (!userId) { socket.destroy(); return; }
    pool.acquire(userId).then((bp) => {
      bp.lastActiveAt = Date.now();
      const up = netConnect(bp.port, "127.0.0.1", () => {
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
