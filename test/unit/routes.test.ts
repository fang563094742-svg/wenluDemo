/**
 * 任务 15.2：REST 端点路由单元测试（vitest，非 property）。
 *
 * 覆盖 `createRequestHandler` 把端点接到 Orchestrator + SSE + 就绪握手的行为：
 *  - `POST /scan` 等动作：解析 JSON 体、调用对应方法、回 ActionResult JSON；
 *    被接受 → 200、被拒绝（非法转移/校验失败）→ 409。
 *  - `POST /accept`、`/confirm-scope`、`/impasse-choice`、`/confirm-risk` 的载荷校验。
 *  - `POST /answer` 二义分流：clarifying → answer()；blocked_on_user → replyBlocking()。
 *  - `GET /events`：转交 SseHub.addClient 并触发 onSseConnect。
 *  - `POST /ui-ready`：合法握手触发 onUiReady 并回 200；非法体回 400。
 *  - 非法 JSON → 400；未知路由 → 404 或交兜底；方法不符 → 405。
 *
 * 不接真实 http server：用最小 Fake req/res 替身（仅模拟被测所需的事件/写入行为）。
 *
 * _Requirements: 1.1, 1.2, 1.3, 7.2, 8.11, 9.1, 9.3, 10.1, 10.4, 11.2, 13.1, 13.3, 13.4, 15.3, 15.5_
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRequestHandler } from "../../src/server/routes.js";
import type { OrchestratorActions } from "../../src/server/routes.js";
import type { SseHub } from "../../src/server/sse.js";
import { SessionState } from "../../src/orchestrator/session.js";
import type { ActionResult } from "../../src/orchestrator/orchestrator.js";

// ---------------------------------------------------------------------------
// 测试替身：最小 req / res
// ---------------------------------------------------------------------------

/** 最小 IncomingMessage：用 EventEmitter 模拟 data/end/error 流。 */
class FakeRequest extends EventEmitter {
  constructor(
    public method: string,
    public url: string,
  ) {
    super();
  }
  destroy(): void {}
  /** 异步喂入请求体并结束（模拟网络分片到达）。 */
  feed(body?: string): void {
    queueMicrotask(() => {
      if (body) this.emit("data", Buffer.from(body, "utf8"));
      this.emit("end");
    });
  }
}

/** 最小 ServerResponse：捕获状态码 / 头 / 写出文本。 */
class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  ended = false;
  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = { ...headers };
    return this;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
}

function asReq(f: FakeRequest): IncomingMessage {
  return f as unknown as IncomingMessage;
}
function asRes(f: FakeResponse): ServerResponse {
  return f as unknown as ServerResponse;
}

/** 构造一个可定制状态、所有方法皆为 spy 的 Orchestrator 替身。 */
function makeOrch(
  state: SessionState = SessionState.Idle,
): OrchestratorActions & { _spies: Record<string, ReturnType<typeof vi.fn>> } {
  const ok = (s = state): ActionResult => ({ ok: true, state: s });
  const spies = {
    scan: vi.fn(async () => ok(SessionState.AwarenessPresented)),
    acceptAwareness: vi.fn(async (_id: string) => ok(SessionState.Clarifying)),
    dismissAwareness: vi.fn(() => ok(SessionState.Idle)),
    answer: vi.fn(async (_a: unknown) => ok(SessionState.Clarifying)),
    confirmUnderstanding: vi.fn(async () => ok(SessionState.ScopeConfirm)),
    supplementUnderstanding: vi.fn(() => ok(SessionState.Clarifying)),
    impasseChoice: vi.fn(async (_c: unknown) => ok(SessionState.ScopeConfirm)),
    confirmScope: vi.fn((_p: string) => ok(SessionState.ReadyConfirm)),
    startExecution: vi.fn(async () => ok(SessionState.BackingUp)),
    confirmBackupSize: vi.fn(async () => ok(SessionState.Executing)),
    cancelBackupSize: vi.fn(() => ok(SessionState.Error)),
    confirmRisk: vi.fn((_d: unknown) => ok(SessionState.Executing)),
    replyBlocking: vi.fn((_t: string) => ok(SessionState.Executing)),
    acceptDelivery: vi.fn(() => ok(SessionState.Accepted)),
    recoverFromError: vi.fn(() => ok(SessionState.Idle)),
  };
  const orch: OrchestratorActions = {
    getState: () => state,
    scan: spies.scan,
    acceptAwareness: spies.acceptAwareness,
    dismissAwareness: spies.dismissAwareness,
    answer: spies.answer,
    confirmUnderstanding: spies.confirmUnderstanding,
    supplementUnderstanding: spies.supplementUnderstanding,
    impasseChoice: spies.impasseChoice,
    confirmScope: spies.confirmScope,
    startExecution: spies.startExecution,
    confirmBackupSize: spies.confirmBackupSize,
    cancelBackupSize: spies.cancelBackupSize,
    confirmRisk: spies.confirmRisk,
    replyBlocking: spies.replyBlocking,
    acceptDelivery: spies.acceptDelivery,
    recoverFromError: spies.recoverFromError,
  };
  return Object.assign(orch, { _spies: spies });
}

/** 最小 SseHub 替身：仅记录 addClient 调用。 */
function makeSseHub(): SseHub & { added: ServerResponse[] } {
  const added: ServerResponse[] = [];
  const hub = {
    addClient: (res: ServerResponse) => {
      added.push(res);
      return () => {};
    },
  };
  return Object.assign(hub as unknown as SseHub, { added });
}

/** 驱动一次请求并在响应 end 后 resolve。 */
async function drive(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  req: FakeRequest,
  res: FakeResponse,
  body?: string,
): Promise<FakeResponse> {
  handler(asReq(req), asRes(res));
  req.feed(body);
  // 等待请求体解析 + 动作（可能异步）结算。
  await vi.waitFor(() => {
    if (!res.ended) throw new Error("response not ended yet");
  });
  return res;
}

// ---------------------------------------------------------------------------
// POST 动作端点
// ---------------------------------------------------------------------------

describe("createRequestHandler — POST 动作", () => {
  it("POST /scan 调用 orchestrator.scan 并回 200 + ActionResult", async () => {
    const orch = makeOrch();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const res = await drive(handler, new FakeRequest("POST", "/scan"), new FakeResponse());

    expect(orch._spies.scan).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, state: SessionState.AwarenessPresented });
  });

  it("POST /accept 传入 itemId", async () => {
    const orch = makeOrch(SessionState.AwarenessPresented);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    await drive(handler, new FakeRequest("POST", "/accept"), new FakeResponse(), JSON.stringify({ itemId: "item-1" }));

    expect(orch._spies.acceptAwareness).toHaveBeenCalledWith("item-1");
  });

  it("POST /accept 缺 itemId → 409 校验失败", async () => {
    const orch = makeOrch(SessionState.AwarenessPresented);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const res = await drive(handler, new FakeRequest("POST", "/accept"), new FakeResponse(), "{}");

    expect(orch._spies.acceptAwareness).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it("POST /confirm-scope 接受 path 或 userChosenPath 别名", async () => {
    const orch1 = makeOrch(SessionState.ScopeConfirm);
    const h1 = createRequestHandler({ orchestrator: orch1, sseHub: makeSseHub() });
    await drive(h1, new FakeRequest("POST", "/confirm-scope"), new FakeResponse(), JSON.stringify({ path: "/tmp/a" }));
    expect(orch1._spies.confirmScope).toHaveBeenCalledWith("/tmp/a");

    const orch2 = makeOrch(SessionState.ScopeConfirm);
    const h2 = createRequestHandler({ orchestrator: orch2, sseHub: makeSseHub() });
    await drive(h2, new FakeRequest("POST", "/confirm-scope"), new FakeResponse(), JSON.stringify({ userChosenPath: "/tmp/b" }));
    expect(orch2._spies.confirmScope).toHaveBeenCalledWith("/tmp/b");
  });

  it("POST /impasse-choice 校验 choice 取值", async () => {
    const orch = makeOrch(SessionState.Impasse);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });

    await drive(handler, new FakeRequest("POST", "/impasse-choice"), new FakeResponse(), JSON.stringify({ choice: "force_execute" }));
    expect(orch._spies.impasseChoice).toHaveBeenCalledWith("force_execute");

    const bad = await drive(handler, new FakeRequest("POST", "/impasse-choice"), new FakeResponse(), JSON.stringify({ choice: "nope" }));
    expect(bad.statusCode).toBe(409);
  });

  it("POST /confirm-risk 校验 decision 取值", async () => {
    const orch = makeOrch(SessionState.BlockedOnUser);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });

    await drive(handler, new FakeRequest("POST", "/confirm-risk"), new FakeResponse(), JSON.stringify({ decision: "reject" }));
    expect(orch._spies.confirmRisk).toHaveBeenCalledWith("reject");

    const bad = await drive(handler, new FakeRequest("POST", "/confirm-risk"), new FakeResponse(), JSON.stringify({ decision: "maybe" }));
    expect(bad.statusCode).toBe(409);
  });

  it("被拒绝的动作（ok:false）映射为 409", async () => {
    const orch = makeOrch();
    orch._spies.scan.mockResolvedValueOnce({ ok: false, state: SessionState.Idle, reason: "boom" });
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const res = await drive(handler, new FakeRequest("POST", "/scan"), new FakeResponse());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ ok: false, state: SessionState.Idle, reason: "boom" });
  });

  it("已暴露 dismiss / supplement / cancel-backup-size / recover 等动作", async () => {
    const handler = (orch: ReturnType<typeof makeOrch>) =>
      createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });

    const o1 = makeOrch(SessionState.AwarenessPresented);
    await drive(handler(o1), new FakeRequest("POST", "/dismiss"), new FakeResponse());
    expect(o1._spies.dismissAwareness).toHaveBeenCalledOnce();

    const o2 = makeOrch(SessionState.AwaitingUnderstanding);
    await drive(handler(o2), new FakeRequest("POST", "/supplement-understanding"), new FakeResponse());
    expect(o2._spies.supplementUnderstanding).toHaveBeenCalledOnce();

    const o3 = makeOrch(SessionState.AwaitingBackupConfirm);
    await drive(handler(o3), new FakeRequest("POST", "/cancel-backup-size"), new FakeResponse());
    expect(o3._spies.cancelBackupSize).toHaveBeenCalledOnce();

    const o4 = makeOrch(SessionState.Error);
    await drive(handler(o4), new FakeRequest("POST", "/recover"), new FakeResponse());
    expect(o4._spies.recoverFromError).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// /answer 二义分流
// ---------------------------------------------------------------------------

describe("createRequestHandler — /answer 二义分流", () => {
  it("clarifying 状态 → 调用 answer(UserAnswer)", async () => {
    const orch = makeOrch(SessionState.Clarifying);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    await drive(
      handler,
      new FakeRequest("POST", "/answer"),
      new FakeResponse(),
      JSON.stringify({ questionId: "q1", text: "用 TS", acceptedDefaultFor: ["p1"] }),
    );
    expect(orch._spies.answer).toHaveBeenCalledWith({
      questionId: "q1",
      text: "用 TS",
      acceptedDefaultFor: ["p1"],
    });
    expect(orch._spies.replyBlocking).not.toHaveBeenCalled();
  });

  it("blocked_on_user 状态 → 调用 replyBlocking(text)", async () => {
    const orch = makeOrch(SessionState.BlockedOnUser);
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    await drive(
      handler,
      new FakeRequest("POST", "/answer"),
      new FakeResponse(),
      JSON.stringify({ text: "继续" }),
    );
    expect(orch._spies.replyBlocking).toHaveBeenCalledWith("继续");
    expect(orch._spies.answer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SSE 订阅 + 就绪握手
// ---------------------------------------------------------------------------

describe("createRequestHandler — /events 与 /ui-ready", () => {
  it("GET /events 转交 SseHub.addClient 并触发 onSseConnect", () => {
    const orch = makeOrch();
    const sseHub = makeSseHub();
    const onSseConnect = vi.fn();
    const handler = createRequestHandler({ orchestrator: orch, sseHub, onSseConnect });

    const req = new FakeRequest("GET", "/events");
    const res = new FakeResponse();
    handler(asReq(req), asRes(res));

    expect(sseHub.added).toHaveLength(1);
    expect(sseHub.added[0]).toBe(asRes(res));
    expect(onSseConnect).toHaveBeenCalledOnce();
  });

  it("POST /ui-ready 合法握手触发 onUiReady 并回 200", async () => {
    const orch = makeOrch();
    const onUiReady = vi.fn();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub(), onUiReady });
    const res = await drive(
      handler,
      new FakeRequest("POST", "/ui-ready"),
      new FakeResponse(),
      JSON.stringify({ type: "ui-ready" }),
    );

    expect(onUiReady).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("POST /ui-ready 体非法 → 400，不触发 onUiReady", async () => {
    const orch = makeOrch();
    const onUiReady = vi.fn();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub(), onUiReady });
    const res = await drive(
      handler,
      new FakeRequest("POST", "/ui-ready"),
      new FakeResponse(),
      JSON.stringify({ type: "nope" }),
    );

    expect(onUiReady).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 错误与边界
// ---------------------------------------------------------------------------

describe("createRequestHandler — 错误与边界", () => {
  it("非法 JSON 体 → 400", async () => {
    const orch = makeOrch();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const res = await drive(handler, new FakeRequest("POST", "/scan"), new FakeResponse(), "{not json");

    expect(res.statusCode).toBe(400);
    expect(orch._spies.scan).not.toHaveBeenCalled();
  });

  it("空体视为 {} 并正常派发", async () => {
    const orch = makeOrch();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const res = await drive(handler, new FakeRequest("POST", "/scan"), new FakeResponse());
    expect(res.statusCode).toBe(200);
    expect(orch._spies.scan).toHaveBeenCalledOnce();
  });

  it("动作端点用错方法 → 405", async () => {
    const orch = makeOrch();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    const req = new FakeRequest("GET", "/scan");
    const res = new FakeResponse();
    handler(asReq(req), asRes(res));
    expect(res.statusCode).toBe(405);
  });

  it("未知路由 → 404；提供 onUnhandled 时交兜底", () => {
    const orch = makeOrch();
    const res404 = new FakeResponse();
    createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() })(
      asReq(new FakeRequest("GET", "/nope")),
      asRes(res404),
    );
    expect(res404.statusCode).toBe(404);

    const onUnhandled = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      (res as unknown as FakeResponse).end("static");
    });
    const resStatic = new FakeResponse();
    createRequestHandler({ orchestrator: orch, sseHub: makeSseHub(), onUnhandled })(
      asReq(new FakeRequest("GET", "/")),
      asRes(resStatic),
    );
    expect(onUnhandled).toHaveBeenCalledOnce();
  });

  it("忽略查询串与末尾斜杠，仍正确匹配端点", async () => {
    const orch = makeOrch();
    const handler = createRequestHandler({ orchestrator: orch, sseHub: makeSseHub() });
    await drive(handler, new FakeRequest("POST", "/scan/?t=1"), new FakeResponse());
    expect(orch._spies.scan).toHaveBeenCalledOnce();
  });
});
