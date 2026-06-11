/**
 * 任务 15.3：本机 HTTP 服务单元测试（vitest，非 property）。
 *
 * 覆盖 `HttpWebServer` 的关键行为：
 *  - `start` 默认绑定 `127.0.0.1`（仅本机可达，安全红线）；拒绝绑定非回环地址（如 0.0.0.0）。
 *  - 静态资源服务：`GET /` → public/index.html、`/app.js`；越界路径（`../`/编码穿越）→ 403；缺失 → 404。
 *  - UI 就绪握手超时自毁（R16.3）：超时未收到 ui-ready → shutdown 关闭服务并退出进程；
 *    收到 ui-ready 则清除计时器、不自毁。
 *  - `shutdown`：关闭 SseHub 全部连接 + close HTTP server + 调用注入的 exit。
 *  - `resolveStaticPath` 纯函数的穿越防御。
 *
 * 用真实回环 HTTP server（port=0 系统分配）+ 真实 http 请求，注入 fake exit 不真正杀进程。
 *
 * _Requirements: 16.1, 16.3, 16.4_
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpWebServer,
  resolveStaticPath,
  contentTypeFor,
  DEFAULT_HOST,
  LOOPBACK_HOSTS,
} from "../../src/server/webServer.js";
import type { OrchestratorActions } from "../../src/server/routes.js";
import { SseHub } from "../../src/server/sse.js";
import { SessionState } from "../../src/orchestrator/session.js";
import type { ActionResult } from "../../src/orchestrator/orchestrator.js";

// ---------------------------------------------------------------------------
// 测试替身与辅助
// ---------------------------------------------------------------------------

/** 最小 Orchestrator 替身：所有动作回固定 ActionResult；webServer 静态/握手路径用不到它。 */
function makeOrch(): OrchestratorActions {
  const ok: ActionResult = { ok: true, state: SessionState.Idle };
  const noop = (): ActionResult => ok;
  const anoop = async (): Promise<ActionResult> => ok;
  return {
    getState: () => SessionState.Idle,
    getSessionSnapshot: () => ({ state: SessionState.Idle, awarenessItems: [], clarifier: undefined, workingDir: undefined } as any),
    scan: anoop,
    acceptAwareness: anoop,
    dismissAwareness: noop,
    answer: anoop,
    confirmUnderstanding: anoop,
    supplementUnderstanding: noop,
    impasseChoice: anoop,
    confirmScope: noop,
    startExecution: anoop,
    confirmBackupSize: anoop,
    cancelBackupSize: noop,
    confirmRisk: noop,
    replyBlocking: noop,
    acceptDelivery: noop,
    recoverFromError: noop,
  };
}

/** 模拟进程退出的信号异常：注入的 fake exit 抛出它以中断后续、贴近 `never` 语义。 */
class ProcessExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/** 发起一次本机 HTTP 请求，resolve 状态码 + 文本体。 */
function httpGet(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let tmpPublic: string;
let servers: HttpWebServer[];

beforeEach(() => {
  tmpPublic = mkdtempSync(join(tmpdir(), "pad-public-"));
  writeFileSync(join(tmpPublic, "index.html"), "<h1>hello</h1>", "utf8");
  writeFileSync(join(tmpPublic, "app.js"), "console.log('ui')", "utf8");
  writeFileSync(join(tmpPublic, "secret.txt"), "should be reachable inside public", "utf8");
  servers = [];
});

afterEach(async () => {
  // 关闭仍在监听的 server（用一个不退出进程的 exit）。
  for (const s of servers) {
    try {
      await s.shutdown("test cleanup", 0).catch(() => {});
    } catch {
      /* exit 抛 ProcessExitSignal，忽略 */
    }
  }
  rmSync(tmpPublic, { recursive: true, force: true });
});

/** 启动一个测试 server（port=0 系统分配，禁用自毁除非显式给 timeout）。 */
async function startServer(opts: {
  uiReadyTimeoutMs?: number;
  exit?: (code: number) => never;
}): Promise<{ server: HttpWebServer; sseHub: SseHub; port: number; exitCalls: number[] }> {
  const sseHub = new SseHub({ heartbeatMs: 0 });
  const exit = opts.exit ?? (((c: number) => {
    throw new ProcessExitSignal(c);
  }) as (code: number) => never);
  const exitCalls: number[] = [];
  const wrappedExit = ((c: number): never => {
    exitCalls.push(c);
    return exit(c);
  }) as (code: number) => never;

  const server = new HttpWebServer({
    orchestrator: makeOrch(),
    sseHub,
    publicDir: tmpPublic,
    exit: wrappedExit,
    log: () => {},
  });
  servers.push(server);
  await server.start({ port: 0, uiReadyTimeoutMs: opts.uiReadyTimeoutMs ?? 0 });
  const addr = server.address() as AddressInfo;
  return { server, sseHub, port: addr.port, exitCalls };
}

// ---------------------------------------------------------------------------
// 绑定地址（安全红线）
// ---------------------------------------------------------------------------

describe("HttpWebServer — 绑定地址（安全红线 R16.1/R16.4）", () => {
  it("默认绑定 127.0.0.1（仅本机可达）", async () => {
    const { server } = await startServer({});
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("拒绝绑定非回环地址（如 0.0.0.0）", async () => {
    const server = new HttpWebServer({
      orchestrator: makeOrch(),
      sseHub: new SseHub({ heartbeatMs: 0 }),
      publicDir: tmpPublic,
      exit: (() => {
        throw new Error("should not exit");
      }) as (code: number) => never,
      log: () => {},
    });
    servers.push(server);
    await expect(server.start({ port: 0, host: "0.0.0.0" })).rejects.toThrow(/非回环地址/);
    expect(LOOPBACK_HOSTS.has("0.0.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 静态资源服务
// ---------------------------------------------------------------------------

describe("HttpWebServer — 静态资源服务（限定 public/ 内）", () => {
  it("GET / → index.html", async () => {
    const { port } = await startServer({});
    const r = await httpGet(port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("hello");
    expect(r.contentType).toContain("text/html");
  });

  it("GET /app.js → app.js（正确 Content-Type）", async () => {
    const { port } = await startServer({});
    const r = await httpGet(port, "/app.js");
    expect(r.status).toBe(200);
    expect(r.body).toContain("ui");
    expect(r.contentType).toContain("javascript");
  });

  it("编码斜杠穿越尝试（%2f 绕过 URL 规范化）→ 403", async () => {
    const { port } = await startServer({});
    // %2e%2e%2f 解码为 ../，且编码斜杠能绕过 WHATWG URL 的点段折叠，真正触达越界守卫。
    const r = await httpGet(port, "/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect(r.status).toBe(403);
  });

  it("明文 ../ 被 URL 规范化中和（落回 public 内）→ 404", async () => {
    const { port } = await startServer({});
    // 明文 ../ 在 HTTP 层即被 URL 解析折叠为 /etc/passwd，落在 public 内、不存在 → 404（纵深防御）。
    const r = await httpGet(port, "/../../etc/passwd");
    expect(r.status).toBe(404);
  });

  it("public 内不存在的文件 → 404", async () => {
    const { port } = await startServer({});
    const r = await httpGet(port, "/nope.js");
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// UI 就绪握手超时自毁（R16.3）
// ---------------------------------------------------------------------------

describe("HttpWebServer — UI 就绪握手超时自毁（R16.3）", () => {
  it("超时前未收到 ui-ready → shutdown 并退出进程", async () => {
    const { exitCalls, server } = await startServer({ uiReadyTimeoutMs: 50 });
    expect(server.isUiReady()).toBe(false);
    // 等待超过超时窗口。
    await vi.waitFor(
      () => {
        if (exitCalls.length === 0) throw new Error("not exited yet");
      },
      { timeout: 1000 },
    );
    expect(exitCalls[0]).toBe(1);
  });

  it("收到 ui-ready → 清除计时器、置就绪态、不自毁", async () => {
    const { port, server, exitCalls } = await startServer({ uiReadyTimeoutMs: 200 });
    // 发就绪握手。
    const r = await postJson(port, "/ui-ready", { type: "ui-ready" });
    expect(r.status).toBe(200);
    expect(server.isUiReady()).toBe(true);
    // 等待超过原超时窗口，确认未自毁。
    await new Promise((res) => setTimeout(res, 350));
    expect(exitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe("HttpWebServer — shutdown", () => {
  it("关闭 SseHub 全部连接 + close server + 调用 exit", async () => {
    const { server, sseHub, exitCalls } = await startServer({});
    const closeAllSpy = vi.spyOn(sseHub, "closeAll");
    try {
      await server.shutdown("manual", 0);
    } catch {
      /* exit 抛信号，忽略 */
    }
    expect(closeAllSpy).toHaveBeenCalledOnce();
    expect(exitCalls).toContain(0);
    expect(server.address()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 纯函数：resolveStaticPath / contentTypeFor
// ---------------------------------------------------------------------------

describe("resolveStaticPath — 路径穿越防御", () => {
  const root = "/srv/public";

  it("根 / 映射为 index.html", () => {
    expect(resolveStaticPath(root, "/")).toBe("/srv/public/index.html");
  });

  it("目录请求补 index.html", () => {
    expect(resolveStaticPath(root, "/sub/")).toBe("/srv/public/sub/index.html");
  });

  it("普通文件落在根内", () => {
    expect(resolveStaticPath(root, "/app.js")).toBe("/srv/public/app.js");
  });

  it("明文 ../ 被 URL 规范化折叠后落回根内（不越界）", () => {
    // resolveStaticPath 内部用 new URL 先做点段折叠：明文 ../ 在此阶段即被中和。
    expect(resolveStaticPath(root, "/../etc/passwd")).toBe("/srv/public/etc/passwd");
    expect(resolveStaticPath(root, "/../../secret")).toBe("/srv/public/secret");
  });

  it("编码斜杠穿越（%2f 绕过点段折叠）解码后越界 → null", () => {
    // %2f 编码斜杠能绕过 URL 折叠，解码后形成 ../ 真正越界，被容器校验拒绝。
    expect(resolveStaticPath(root, "/%2e%2e%2f%2e%2e%2fsecret")).toBeNull();
  });

  it("查询串被忽略", () => {
    expect(resolveStaticPath(root, "/app.js?v=2")).toBe("/srv/public/app.js");
  });

  it("NUL 字节 → null", () => {
    expect(resolveStaticPath(root, "/app%00.js")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("已知扩展名映射正确", () => {
    expect(contentTypeFor("/x/index.html")).toContain("text/html");
    expect(contentTypeFor("/x/app.js")).toContain("javascript");
    expect(contentTypeFor("/x/s.css")).toContain("text/css");
  });
  it("未知扩展名回退二进制流", () => {
    expect(contentTypeFor("/x/data.bin")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// 辅助：POST JSON
// ---------------------------------------------------------------------------

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
