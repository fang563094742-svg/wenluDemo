/**
 * proactive-awareness-demo —— 本机 HTTP 服务（任务 15.3，R16.1/R16.3/R16.4）。
 *
 * 设计依据：design.md「7. Web 服务与对话界面（R16）→ Web_Server」与「安全要点 →
 * 本地服务安全提示」。
 *
 * 职责（仅限本任务）：
 *  - `start`：用 Node 内置 `http.createServer(createRequestHandler(...))` 监听，
 *    **默认绑定 `127.0.0.1`（仅本机可达）**；并以 `onUnhandled` 兜底服务 `public/`
 *    静态资源（`GET /` → `index.html`、`/app.js`、`/style.css` 等）。
 *  - **UI 就绪握手超时自毁（R16.3）**：`start` 成功监听后开启 `uiReadyTimeoutMs` 就绪
 *    计时器并置 `uiReady = false`；超时前未收到任何 SSE 连接（`onSseConnect`）或未收到
 *    `{ type: "ui-ready" }`（`onUiReady`）→ 判定 UI 初始化失败，调用 `shutdown` 关闭
 *    HTTP 服务并退出进程；收到则清除计时器、置 `uiReady = true`，进入正常工作态。
 *  - `shutdown`：关闭 `SseHub` 全部连接 + close HTTP server，干净退出进程。
 *  - 静态资源服务**限定在 `public/` 目录内**（规范化后判定，防 `../` 路径穿越）。
 *
 * 解耦：HTTP 请求分发（REST + SSE + ui-ready 握手）由 `routes.ts` 的
 * {@link createRequestHandler} 负责；SSE 连接管理与广播由 `sse.ts` 的 `SseHub` 负责。
 * 本模块只负责**监听/绑定地址、静态资源、就绪握手计时与自毁、优雅退出**。
 *
 * 安全（红线）：默认仅绑定 `127.0.0.1`，**拒绝绑定 `0.0.0.0` 等非回环地址**——这是
 * 单用户本机 demo、未引入鉴权，对外暴露将无访问控制（design「本地服务安全提示」）。
 * 本机执行：除调用 LLM API 外不向远程委托（R16.4）。
 *
 * _Requirements: 16.1, 16.3, 16.4_
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve as resolvePath, sep } from "node:path";

import { createRequestHandler } from "./routes.js";
import type { OrchestratorActions } from "./routes.js";
import type { SseHub } from "./sse.js";
import { uiReadyTimeoutMs as DEFAULT_UI_READY_TIMEOUT_MS } from "../config/config.js";

// ===========================================================================
// 配置常量
// ===========================================================================

/** 默认绑定地址：仅回环、仅本机可达（安全红线，R16.1/R16.4）。 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * 允许的回环绑定地址白名单。
 *
 * 安全红线：本服务未引入鉴权，**只允许绑定回环地址**；显式传入 `0.0.0.0` /
 * `::` 等通配地址会被 {@link HttpWebServer.start} 拒绝，防止无鉴权服务对外暴露。
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);

/** 静态资源默认根目录：相对启动工作目录的 `public/`（`npm start` / `启动.command` 均先切到仓库根）。 */
const DEFAULT_PUBLIC_DIR = resolvePath(process.cwd(), "public");

/** 扩展名 → Content-Type 映射（静态资源服务）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// ===========================================================================
// 类型
// ===========================================================================

/** {@link HttpWebServer.start} 入参。 */
export interface WebServerOptions {
  /** 监听端口（必填）。传 0 由系统分配空闲端口（便于测试）。 */
  port: number;
  /** 绑定地址，默认 {@link DEFAULT_HOST}；非回环地址将被拒绝（安全红线）。 */
  host?: string;
  /** UI 就绪握手超时（毫秒），默认取 `config.uiReadyTimeoutMs`（3000）。≤0 表示禁用自毁。 */
  uiReadyTimeoutMs?: number;
}

/** Web_Server 公共契约（design「Web_Server」）。 */
export interface WebServer {
  /** 启动 HTTP 服务并装配 REST + SSE；启动后开启 UI 就绪握手计时器。 */
  start(opts: WebServerOptions): Promise<void>;
  /** 主动关闭 HTTP 服务并退出进程（UI 初始化失败时调用，R16.3）。 */
  shutdown(reason: string): Promise<never>;
}

/** 进程退出函数（可注入，便于测试不真正杀进程）；默认 `process.exit`。 */
export type ProcessExit = (code: number) => never;

/** {@link HttpWebServer} 的依赖注入项。 */
export interface WebServerDeps {
  /** 闭环编排器（REST 端点经其推进状态机）。 */
  orchestrator: OrchestratorActions;
  /** SSE 推送通道（`GET /events` 转交、`shutdown` 时全部关闭）。 */
  sseHub: SseHub;
  /** 静态资源根目录，默认启动工作目录下的 `public/`。 */
  publicDir?: string;
  /** 进程退出函数，默认 `process.exit`（注入便于测试）。 */
  exit?: ProcessExit;
  /** 诊断日志函数，默认写 `console.error`（注入便于测试静默/断言）。 */
  log?: (message: string) => void;
}

// ===========================================================================
// 静态资源路径解析（纯函数，便于单测；防路径穿越）
// ===========================================================================

/**
 * 把请求 URL 解析为 `publicDir` 内的绝对文件路径；越界或非法编码返回 `null`。
 *
 * 规则：
 *  - 仅取 pathname（忽略查询串），`decodeURIComponent` 解码；解码失败 → `null`。
 *  - 目录请求（以 `/` 结尾或根 `/`）补 `index.html`。
 *  - 用 `path.resolve` 折叠 `..` 后，**必须仍落在 `publicDir` 之内**，否则视为
 *    路径穿越尝试 → `null`（限定在 public/ 目录内，R16.1 安全要点）。
 */
export function resolveStaticPath(publicDir: string, rawUrl: string): string | null {
  // 1) 提取 pathname（忽略查询串与 hash）。
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    pathname = (rawUrl.split("?")[0] ?? "/").split("#")[0] ?? "/";
  }

  // 2) 解码（防 %2e%2e 之类的编码穿越）；解码失败一律拒绝。
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // 3) NUL 字节等控制字符直接拒绝。
  if (decoded.includes("\0")) return null;

  // 4) 目录 / 根 → index.html。
  if (decoded === "" || decoded === "/") {
    decoded = "/index.html";
  } else if (decoded.endsWith("/")) {
    decoded = `${decoded}index.html`;
  }

  // 5) 规范化根目录与候选路径；候选必须仍在根之内。
  const rootAbs = resolvePath(publicDir);
  const relative = decoded.startsWith("/") ? `.${decoded}` : `./${decoded}`;
  const candidate = resolvePath(rootAbs, relative);

  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) {
    return null;
  }
  return candidate;
}

/** 按扩展名推断 Content-Type；未知类型回退为二进制流。 */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ===========================================================================
// HttpWebServer
// ===========================================================================

/**
 * 本机 HTTP 服务实现：监听 `127.0.0.1`、服务静态资源、UI 就绪握手超时自毁、优雅退出。
 *
 * 典型装配（composition root，任务 17.1）：
 * ```ts
 * const sseHub = new SseHub();
 * const orchestrator = new Orchestrator({ ..., notifier: sseHub.notifier() });
 * const server = new HttpWebServer({ orchestrator, sseHub });
 * await server.start({ port: 8787 });
 * ```
 */
export class HttpWebServer implements WebServer {
  private readonly orchestrator: OrchestratorActions;
  private readonly sseHub: SseHub;
  private readonly publicDir: string;
  private readonly exit: ProcessExit;
  private readonly log: (message: string) => void;

  /** 底层 HTTP server（监听后赋值，关闭后置空）。 */
  private server: Server | null = null;
  /** 是否已完成 UI 就绪握手（收到 ui-ready 即 true）。 */
  private uiReady = false;
  /** 是否已观察到至少一个 SSE 连接（用于自毁原因诊断）。 */
  private sawSseConnect = false;
  /** 就绪握手计时器；收到 ui-ready 或触发自毁后清空。 */
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** 防止重复关闭。 */
  private shuttingDown = false;

  constructor(deps: WebServerDeps) {
    this.orchestrator = deps.orchestrator;
    this.sseHub = deps.sseHub;
    this.publicDir = deps.publicDir ? resolvePath(deps.publicDir) : DEFAULT_PUBLIC_DIR;
    this.exit = deps.exit ?? ((code: number): never => process.exit(code));
    this.log = deps.log ?? ((message: string): void => console.error(message));
  }

  /**
   * 启动 HTTP 服务：监听 `host:port`（默认 `127.0.0.1`），装配请求处理器与静态资源兜底，
   * 监听成功后开启 UI 就绪握手计时器（R16.3）。
   *
   * @throws Error 当 `host` 不是回环地址（安全红线）或监听失败时。
   */
  async start(opts: WebServerOptions): Promise<void> {
    const host = opts.host ?? DEFAULT_HOST;
    // 安全红线：拒绝绑定非回环地址（无鉴权服务不得对外暴露）。
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `拒绝绑定非回环地址 "${host}"：本服务未引入鉴权，仅允许绑定回环地址（${[...LOOPBACK_HOSTS].join(
          " / ",
        )}）。若确需对外暴露，必须先加入访问控制。`,
      );
    }

    const timeoutMs = opts.uiReadyTimeoutMs ?? DEFAULT_UI_READY_TIMEOUT_MS;

    const handler = createRequestHandler({
      orchestrator: this.orchestrator,
      sseHub: this.sseHub,
      onUiReady: () => this.markUiReady(),
      onSseConnect: () => {
        this.sawSseConnect = true;
      },
      onUnhandled: (req, res) => {
        void this.serveStatic(req, res);
      },
    });

    const server = createServer(handler);
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        this.server = null;
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(opts.port, host);
    });

    const addr = this.address();
    const shownPort = addr ? addr.port : opts.port;
    this.log(`Web_Server 已监听 http://${host}:${shownPort}（仅本机可达）`);

    this.startReadyTimer(timeoutMs);
  }

  /**
   * 关闭 HTTP 服务并退出进程（R16.3）。
   *
   * 步骤：清除就绪计时器 → 关闭 `SseHub` 全部连接 → close HTTP server（强制断开残留连接）
   * → 调用注入的 `exit`。返回类型为 `Promise<never>`：正常路径下进程已退出，不会真正返回。
   *
   * @param reason 关闭原因（写入诊断日志）。
   * @param code   进程退出码，默认 1（UI 初始化失败属异常终止）。
   */
  async shutdown(reason: string, code = 1): Promise<never> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.log(`Web_Server 正在关闭并退出：${reason}`);
      this.clearReadyTimer();
      this.sseHub.closeAll();
      await this.closeServer();
    }
    return this.exit(code);
  }

  // -------------------------------------------------------------------------
  // 查询辅助（便于测试 / 诊断）
  // -------------------------------------------------------------------------

  /** 是否已完成 UI 就绪握手。 */
  isUiReady(): boolean {
    return this.uiReady;
  }

  /** 当前监听地址信息；未监听时为 `null`。 */
  address(): AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a : null;
  }

  // -------------------------------------------------------------------------
  // 内部：就绪握手
  // -------------------------------------------------------------------------

  /** 收到 ui-ready：清计时器、置就绪态（幂等）。 */
  private markUiReady(): void {
    if (this.uiReady) return;
    this.uiReady = true;
    this.clearReadyTimer();
    this.log("UI 就绪握手完成，服务进入正常工作态。");
  }

  /**
   * 开启就绪握手计时器：到点仍未就绪（`!uiReady`）即判定 UI 初始化失败并自毁（R16.3）。
   * `timeoutMs <= 0` 表示禁用自毁（如测试或特殊部署）。
   */
  private startReadyTimer(timeoutMs: number): void {
    if (timeoutMs <= 0) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.uiReady) return;
      const reason = this.sawSseConnect
        ? `UI 初始化失败：已建立 SSE 连接但 ${timeoutMs}ms 内未收到 ui-ready 就绪事件（前端脚本初始化中途失败）`
        : `UI 初始化失败：${timeoutMs}ms 内未收到任何 SSE 连接请求（浏览器未能加载/运行前端）`;
      // 自毁。注入的测试 exit 可能抛出以模拟退出，这里吞掉避免未处理拒绝。
      void this.shutdown(reason).catch(() => {});
    }, timeoutMs);
    // 计时器本身不应吊住进程（HTTP server 监听已使事件循环存活）。
    this.readyTimer.unref?.();
  }

  /** 清除就绪握手计时器。 */
  private clearReadyTimer(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // 内部：关闭 HTTP server
  // -------------------------------------------------------------------------

  /** 关闭底层 HTTP server，并强制断开残留连接（SSE 已由 closeAll 结束）。 */
  private closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      const server = this.server;
      if (!server) {
        resolve();
        return;
      }
      this.server = null;
      server.close(() => resolve());
      // Node 18.2+/v22：强制断开仍挂着的连接，使 close 回调尽快触发。
      server.closeAllConnections?.();
    });
  }

  // -------------------------------------------------------------------------
  // 内部：静态资源服务（限定 public/ 内，防穿越）
  // -------------------------------------------------------------------------

  /**
   * 服务 `public/` 静态资源（`routes` 未匹配时的兜底）。
   *  - 仅接受 `GET` / `HEAD`，其余 405。
   *  - 路径解析越界 → 403；文件不存在 → 404；正常 → 200 + 推断 Content-Type 流式回写。
   */
  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendPlain(res, 405, "Method Not Allowed");
      return;
    }

    const filePath = resolveStaticPath(this.publicDir, req.url ?? "/");
    if (filePath === null) {
      // 路径穿越尝试或非法编码。
      sendPlain(res, 403, "Forbidden");
      return;
    }

    let isFile = false;
    try {
      const stats = await stat(filePath);
      isFile = stats.isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      sendPlain(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      // demo 期禁缓存，避免 UI 资源陈旧。
      "Cache-Control": "no-cache",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => {
      // 读流中途出错：若头未发送可补 500，否则直接断开。
      if (!res.headersSent) {
        sendPlain(res, 500, "Internal Server Error");
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }
}

// ===========================================================================
// 响应辅助
// ===========================================================================

/** 写出一段纯文本响应。 */
function sendPlain(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}
