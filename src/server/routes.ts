/**
 * proactive-awareness-demo —— REST 触发端点路由（任务 15.2，R16.1/R16.2）。
 *
 * 设计依据：design.md「7. Web 服务与对话界面」之 Web_Server / 前端 app.js 行为要点，
 * 以及「设计决策 → 前后端通信：REST 触发动作 + SSE 单向推送」。
 *
 * 职责（仅限本任务）：
 *  - 用 Node 内置 `http` 把每个用户离散动作端点（`POST /scan`、`/accept`、`/answer` …）
 *    **接到 `Orchestrator` 对应方法**，解析请求体 JSON、调用方法、把 {@link ActionResult}
 *    序列化为 JSON 响应。
 *  - `GET /events`：SSE 订阅端点，转交 {@link SseHub.addClient} 建立单向推送长连接；
 *    并触发 `onSseConnect` 回调（供 webServer 的就绪超时自毁判定，任务 15.3）。
 *  - `POST /ui-ready`：前端就绪握手——收到 `{ type: "ui-ready" }` 即触发 `onUiReady`
 *    回调（供 webServer 清除就绪计时器、置 `uiReady = true`，任务 15.3）。
 *
 * 解耦：本模块**不持有** HTTP server、不负责监听/绑定地址、不做静态资源服务，
 * 也不实现就绪超时自毁本身——这些属 webServer（任务 15.3）。本模块只产出一个
 * `(req, res) => void` 的请求处理器，并通过回调把"SSE 连接已建立""收到 ui-ready"
 * 两个信号交给 webServer 订阅。
 *
 * 安全：本服务是单用户本机 demo，**默认仅绑定 `127.0.0.1`、未引入鉴权**（绑定由 webServer
 * 负责，见 design「本地服务安全提示」）。这里的所有路由因此假定仅本机可达；若日后改为
 * 非 localhost 绑定，必须先加入访问控制。
 *
 * _Requirements: 1.1, 1.2, 1.3, 7.2, 8.11, 9.1, 9.3, 10.1, 10.4, 11.2, 13.1, 13.3, 13.4, 15.3, 15.5_
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { SessionState } from "../orchestrator/session.js";
import type { ActionResult } from "../orchestrator/orchestrator.js";
import type { UserAnswer } from "../clarifier/types.js";
import type { SseHub } from "./sse.js";

// ===========================================================================
// Orchestrator 调用契约 —— 路由仅依赖这组方法（便于测试替身注入）
// ===========================================================================

/**
 * 路由所需的 `Orchestrator` 最小调用契约（结构与 `orchestrator/orchestrator.ts` 的
 * `Orchestrator` 类公共方法一致）。经接口注入以便单测替身，无需构造完整编排器。
 *
 * 每个方法对应 design.md「server/routes.ts」的一个 REST 端点。
 */
export interface OrchestratorActions {
  /** 当前会话状态（用于 `/answer` 的二义性分流：澄清答复 vs 阻断性问题答复）。 */
  getState(): SessionState;

  /** `POST /scan`（R1.1/R1.2）。 */
  scan(): Promise<ActionResult>;
  /** `POST /accept`（R7.2/R8.1）：接受某条 Awareness_Item。 */
  acceptAwareness(itemId: string): Promise<ActionResult>;
  /** `POST /dismiss`（R7.3）：忽略全部察觉，回到 idle。 */
  dismissAwareness(): ActionResult;
  /** `POST /answer`（澄清中，R8.6-8.12）：提交一次澄清答复。 */
  answer(userAnswer: UserAnswer): Promise<ActionResult>;
  /** `POST /confirm-understanding`（R8.11）：对"可以开始执行吗"作肯定确认。 */
  confirmUnderstanding(): Promise<ActionResult>;
  /** `POST /supplement-understanding`（R8.11 反向）：补充/否定当前理解，退回澄清。 */
  supplementUnderstanding(): ActionResult;
  /** `POST /impasse-choice`（R8.12）：软上限僵局三选一。 */
  impasseChoice(
    choice: "supplement" | "force_execute" | "abandon",
  ): Promise<ActionResult>;
  /** `POST /confirm-scope`（R9.1/R9.3/R9.4）：落定最终 Working_Directory。 */
  confirmScope(userChosenPath: string): ActionResult;
  /** `POST /start-execution`（R10.1-10.4）：最终确认开始执行。 */
  startExecution(): Promise<ActionResult>;
  /** `POST /confirm-backup-size`（R11.2）：备份体积超阈值时的二次确认。 */
  confirmBackupSize(): Promise<ActionResult>;
  /** `POST /cancel-backup-size`（R11.2）：取消体积二次确认，中止本次执行。 */
  cancelBackupSize(): ActionResult;
  /** `POST /confirm-risk`（R13.1/R13.3/R13.4）：高危动作放行/跳过。 */
  confirmRisk(decision: "confirm" | "reject"): ActionResult;
  /** `POST /answer`（执行中阻断性问题，R14.4）：答复后恢复执行。 */
  replyBlocking(answerText: string): ActionResult;
  /** `POST /accept-delivery`（R15.5）：用户"确认完成"验收。 */
  acceptDelivery(): ActionResult;
  /** `POST /recover`（R1.6/R5.6）：从 error 恢复回 idle。 */
  recoverFromError(): ActionResult;
}

// ===========================================================================
// 路由依赖项
// ===========================================================================

/** {@link createRequestHandler} 的依赖注入项。 */
export interface RouteDeps {
  /** 闭环编排器（端点经其推进状态机）。 */
  orchestrator: OrchestratorActions;
  /** SSE 推送通道（`GET /events` 转交其 `addClient`）。 */
  sseHub: SseHub;
  /**
   * 收到合法 `POST /ui-ready`（`{ type: "ui-ready" }`）时触发。
   * 供 webServer 清除就绪计时器、置 `uiReady = true`（任务 15.3，R16.3）。
   */
  onUiReady?: () => void;
  /**
   * 每次 `GET /events` 建立 SSE 连接时触发。
   * 供 webServer 判定"超时前是否收到任何 SSE 连接请求"（任务 15.3，R16.3）。
   */
  onSseConnect?: () => void;
  /**
   * 未匹配任何 API/SSE 路由时的兜底处理器（供 webServer 服务静态资源，如
   * `GET /` → index.html、`/app.js`）。缺省则回 404 JSON。
   */
  onUnhandled?: (req: IncomingMessage, res: ServerResponse) => void;
  /** 请求体最大字节数，默认 1 MiB（防滥用）。 */
  maxBodyBytes?: number;
}

// ===========================================================================
// 常量
// ===========================================================================

/** 请求体默认上限：1 MiB。 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** SSE 订阅端点路径。 */
const EVENTS_PATH = "/events";
/** 就绪握手端点路径。 */
const UI_READY_PATH = "/ui-ready";

// ===========================================================================
// 请求体解析（纯异步辅助）
// ===========================================================================

/** 请求体解析结果：成功携带已解析对象，失败携带原因（用于 400）。 */
type BodyParse =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * 读取并解析请求体为 JSON。
 *  - 空体视为 `{}`（多数动作无需载荷）。
 *  - 超过 `maxBytes` 立即判失败（防滥用）。
 *  - 非法 JSON 判失败（交由调用方回 400）。
 */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BodyParse> {
  return await new Promise<BodyParse>((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (result: BodyParse): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        finish({ ok: false, reason: `请求体超过上限（${maxBytes} 字节）` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, reason: "请求体不是合法 JSON" });
      }
    });

    req.on("error", (err) => {
      finish({ ok: false, reason: `读取请求体失败：${describe(err)}` });
    });
  });
}

/** 从对象安全取出字符串字段。 */
function strField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** 把未知错误转为可读字符串。 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// 响应辅助
// ===========================================================================

/** 以 JSON 形式写出响应。 */
function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/**
 * 把一次动作结果写为响应：被接受 → 200，被拒绝（非法转移/校验失败）→ 409。
 * 两者都回完整的 {@link ActionResult} 体，前端据 `ok` 字段处理。
 */
function sendActionResult(res: ServerResponse, result: ActionResult): void {
  sendJson(res, result.ok ? 200 : 409, result);
}

// ===========================================================================
// POST 动作分发表
// ===========================================================================

/** 一个 POST 动作处理器：接收已解析请求体，返回 ActionResult（可能异步）。 */
type PostAction = (
  body: unknown,
  orch: OrchestratorActions,
) => ActionResult | Promise<ActionResult>;

/** 构造一个"被拒绝"的 ActionResult（携带当前状态与原因，用于载荷校验失败）。 */
function reject(orch: OrchestratorActions, reason: string): ActionResult {
  return { ok: false, state: orch.getState(), reason };
}

/**
 * 路径 → 动作 的分发表。覆盖 design「server/routes.ts」列出的全部端点，
 * 并把已存在于 Orchestrator 的 dismiss / supplement / impasse-choice /
 * cancel-backup-size / recover 一并暴露。
 */
const POST_ACTIONS: Record<string, PostAction> = {
  "/scan": (_body, orch) => orch.scan(),

  "/accept": (body, orch) => {
    const itemId = strField(body, "itemId");
    if (!itemId) return reject(orch, "缺少 itemId");
    return orch.acceptAwareness(itemId);
  },

  "/dismiss": (_body, orch) => orch.dismissAwareness(),

  // `/answer` 二义：clarifying 阶段为澄清答复；blocked_on_user 阶段为阻断性问题答复。
  "/answer": (body, orch) => {
    if (orch.getState() === SessionState.BlockedOnUser) {
      return orch.replyBlocking(strField(body, "text") ?? "");
    }
    const questionId = strField(body, "questionId");
    if (!questionId) return reject(orch, "缺少 questionId");
    const answer: UserAnswer = { questionId };
    const text = strField(body, "text");
    if (text !== undefined) answer.text = text;
    const accepted = (body as Record<string, unknown>)?.acceptedDefaultFor;
    if (Array.isArray(accepted) && accepted.every((x) => typeof x === "string")) {
      answer.acceptedDefaultFor = accepted as string[];
    }
    return orch.answer(answer);
  },

  "/confirm-understanding": (_body, orch) => orch.confirmUnderstanding(),

  "/supplement-understanding": (_body, orch) => orch.supplementUnderstanding(),

  "/impasse-choice": (body, orch) => {
    const choice = strField(body, "choice");
    if (choice !== "supplement" && choice !== "force_execute" && choice !== "abandon") {
      return reject(orch, "choice 必须是 supplement | force_execute | abandon");
    }
    return orch.impasseChoice(choice);
  },

  "/confirm-scope": (body, orch) => {
    // 前端主用 `path`；兼容 `userChosenPath` 别名。
    const path = strField(body, "path") ?? strField(body, "userChosenPath");
    if (!path) return reject(orch, "缺少 path");
    return orch.confirmScope(path);
  },

  "/start-execution": (_body, orch) => orch.startExecution(),

  "/confirm-backup-size": (_body, orch) => orch.confirmBackupSize(),

  "/cancel-backup-size": (_body, orch) => orch.cancelBackupSize(),

  "/confirm-risk": (body, orch) => {
    const decision = strField(body, "decision");
    if (decision !== "confirm" && decision !== "reject") {
      return reject(orch, "decision 必须是 confirm | reject");
    }
    return orch.confirmRisk(decision);
  },

  "/accept-delivery": (_body, orch) => orch.acceptDelivery(),

  "/recover": (_body, orch) => orch.recoverFromError(),
};

// ===========================================================================
// 请求处理器
// ===========================================================================

/**
 * 构造 Node `http` 的请求处理器：把 REST 端点接到 {@link OrchestratorActions}，
 * 把 `GET /events` 接到 {@link SseHub}，把 `POST /ui-ready` 接到就绪握手回调。
 *
 * 用法（webServer，任务 15.3）：
 * ```ts
 * const handler = createRequestHandler({ orchestrator, sseHub, onUiReady, onSseConnect });
 * http.createServer(handler).listen(port, "127.0.0.1");
 * ```
 */
export function createRequestHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return (req: IncomingMessage, res: ServerResponse): void => {
    // 解析路径（忽略查询串）；缺省主机仅用于解析，不影响仅本机可达的语义。
    const pathname = parsePathname(req.url ?? "/");
    const method = (req.method ?? "GET").toUpperCase();

    // 1) SSE 订阅：GET /events → 交由 SseHub 建连，并通知 webServer "已收到 SSE 连接"。
    if (pathname === EVENTS_PATH) {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, reason: "请使用 GET 订阅 /events" });
        return;
      }
      deps.sseHub.addClient(res);
      deps.onSseConnect?.();
      return;
    }

    // 2) 就绪握手：POST /ui-ready → 校验 { type: "ui-ready" } 后触发回调。
    if (pathname === UI_READY_PATH) {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, reason: "请使用 POST /ui-ready" });
        return;
      }
      void readJsonBody(req, maxBodyBytes).then((parsed) => {
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, reason: parsed.reason });
          return;
        }
        const type = strField(parsed.value, "type");
        if (type !== "ui-ready") {
          sendJson(res, 400, { ok: false, reason: 'body 必须为 { type: "ui-ready" }' });
          return;
        }
        deps.onUiReady?.();
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    // 3) REST 动作端点。
    const action = POST_ACTIONS[pathname];
    if (action) {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, reason: `请使用 POST ${pathname}` });
        return;
      }
      void handlePostAction(req, res, action, deps.orchestrator, maxBodyBytes);
      return;
    }

    // 4) 未匹配：交给兜底（静态资源由 webServer 处理），否则 404。
    if (deps.onUnhandled) {
      deps.onUnhandled(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, reason: `未找到路由 ${method} ${pathname}` });
  };
}

/** 读取请求体并执行一个 POST 动作，写回 ActionResult；解析失败回 400，动作抛错回 500。 */
async function handlePostAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: PostAction,
  orch: OrchestratorActions,
  maxBodyBytes: number,
): Promise<void> {
  const parsed = await readJsonBody(req, maxBodyBytes);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, reason: parsed.reason });
    return;
  }
  try {
    const result = await action(parsed.value, orch);
    sendActionResult(res, result);
  } catch (err) {
    // 编排层方法理应不抛（非致命错误转 lastError）；此处为最后防线，保持服务运行。
    sendJson(res, 500, { ok: false, reason: `动作执行异常：${describe(err)}` });
  }
}

/** 从原始 URL 提取 pathname（去查询串与末尾斜杠归一，根路径保留 `/`）。 */
function parsePathname(rawUrl: string): string {
  // 用占位主机解析相对 URL；只取 pathname。
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    pathname = rawUrl.split("?")[0] ?? "/";
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}
