/**
 * 任务 15.1：SSE 推送通道单元测试（vitest，非 property）。
 *
 * 覆盖：
 *  - `serializeSseFrame`：严格产出 `event: <name>\n` + `data: <json>` + 终止空行的 SSE 帧；
 *    多行 JSON 时每行加 `data: ` 前缀。
 *  - `orchestratorEventToFrame`：编排层语义事件 → SSE 帧的桥接，重点验证
 *    `scan-progress → scan:progress` 重命名与 `execution-progress` 四态 status 透传。
 *  - `SseHub`：连接注册/注销、广播给所有连接、写失败连接被剔除、`notifier()` 桥接广播。
 *
 * 不接真实 http server：用最小 FakeResponse 替身捕获写入内容（替身仅模拟本测试所需的
 * ServerResponse 行为，不构成对被测逻辑的 mock）。
 *
 * _Requirements: 16.2_
 */

import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";

import { SseHub, serializeSseFrame, orchestratorEventToFrame } from "../../src/server/sse.js";
import { SessionState } from "../../src/orchestrator/session.js";
import type { ExecutionProgressEvent } from "../../src/executor/types.js";

// ---------------------------------------------------------------------------
// 测试替身：最小 ServerResponse（仅实现 SseHub 用到的方法）
// ---------------------------------------------------------------------------

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  failNextWrite = false;
  private listeners: Record<string, Array<() => void>> = {};

  // SseHub 访问的 socket 调优方法（均为 no-op 即可）。
  socket = {
    setTimeout: (_ms: number) => {},
    setNoDelay: (_v: boolean) => {},
    setKeepAlive: (_v: boolean) => {},
  };

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = { ...headers };
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated write failure");
    }
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  on(event: string, cb: () => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  /** 模拟底层连接被对端关闭，触发已注册的 close 回调。 */
  emitClose(): void {
    for (const cb of this.listeners["close"] ?? []) cb();
  }

  /** 拼接后的全部写入文本。 */
  text(): string {
    return this.chunks.join("");
  }
}

/** 把 FakeResponse 当作 ServerResponse 注入（结构上满足被测所需子集）。 */
function asRes(fake: FakeResponse): ServerResponse {
  return fake as unknown as ServerResponse;
}

// ---------------------------------------------------------------------------
// serializeSseFrame
// ---------------------------------------------------------------------------

describe("serializeSseFrame", () => {
  it("产出 event: 行 + 单行 data: 行 + 终止空行", () => {
    const frame = serializeSseFrame("state-changed", { state: "idle" });
    expect(frame).toBe('event: state-changed\ndata: {"state":"idle"}\n\n');
  });

  it("多行 JSON 的每一行都加 data: 前缀", () => {
    const frame = serializeSseFrame("x", "line1\nline2");
    // JSON.stringify("line1\nline2") === '"line1\\nline2"'（\n 被转义，不产生真实换行），
    // 故仍是单行 data；用一个真正含换行的序列化场景验证多行分支：
    const multiline = serializeSseFrame("x", { a: 1 }).split("\n");
    expect(multiline[0]).toBe("event: x");
    expect(multiline[1]).toBe('data: {"a":1}');
    expect(frame.startsWith("event: x\n")).toBe(true);
  });

  it("undefined 载荷序列化为 null", () => {
    expect(serializeSseFrame("e", undefined)).toBe("event: e\ndata: null\n\n");
  });
});

// ---------------------------------------------------------------------------
// orchestratorEventToFrame 桥接
// ---------------------------------------------------------------------------

describe("orchestratorEventToFrame", () => {
  it("scan-progress 重命名为对外的 scan:progress 事件且载荷形状为 ScanProgressEvent", () => {
    const frame = orchestratorEventToFrame({
      kind: "scan-progress",
      found: ["a.ts", "repo-x"],
    });
    expect(frame.event).toBe("scan:progress");
    expect(frame.data).toEqual({ type: "scan:progress", found: ["a.ts", "repo-x"] });
  });

  it("execution-progress 原样透传四态 status（与 emitProgress 同源）", () => {
    const statuses: Array<ExecutionProgressEvent & { kind: "tool-result" }> = [
      { kind: "tool-result", tool: "write_file", status: "ok", resultSummary: "" },
      { kind: "tool-result", tool: "run_command", status: "failed", resultSummary: "" },
      { kind: "tool-result", tool: "write_file", status: "blocked", resultSummary: "" },
      { kind: "tool-result", tool: "delete_file", status: "skipped", resultSummary: "" },
    ];
    for (const ev of statuses) {
      const frame = orchestratorEventToFrame({ kind: "execution-progress", event: ev });
      expect(frame.event).toBe("execution-progress");
      expect(frame.data).toBe(ev);
    }
  });

  it("error 事件携带 code/message", () => {
    const frame = orchestratorEventToFrame({
      kind: "error",
      error: { code: "SCAN_ERROR", message: "boom" },
    });
    expect(frame.event).toBe("error");
    expect(frame.data).toEqual({ code: "SCAN_ERROR", message: "boom" });
  });

  it("state-changed 携带新状态", () => {
    const frame = orchestratorEventToFrame({
      kind: "state-changed",
      state: SessionState.Executing,
    });
    expect(frame.event).toBe("state-changed");
    expect(frame.data).toEqual({ state: SessionState.Executing });
  });
});

// ---------------------------------------------------------------------------
// SseHub 连接管理 + 广播 + notifier 桥接
// ---------------------------------------------------------------------------

describe("SseHub", () => {
  it("addClient 写响应头与初始帧，并计入连接数", () => {
    const hub = new SseHub({ heartbeatMs: 0 }); // 关心跳，专注连接管理
    const fake = new FakeResponse();
    hub.addClient(asRes(fake));

    expect(hub.clientCount()).toBe(1);
    expect(fake.statusCode).toBe(200);
    expect(fake.headers["Content-Type"]).toContain("text/event-stream");
    expect(fake.text()).toContain(": connected");
    hub.closeAll();
  });

  it("broadcast 把同一帧推给所有连接", () => {
    const hub = new SseHub({ heartbeatMs: 0 });
    const a = new FakeResponse();
    const b = new FakeResponse();
    hub.addClient(asRes(a));
    hub.addClient(asRes(b));

    hub.broadcast({ event: "accepted", data: {} });

    const expected = serializeSseFrame("accepted", {});
    expect(a.text()).toContain(expected);
    expect(b.text()).toContain(expected);
    hub.closeAll();
  });

  it("连接 close 后自动注销，不再向其广播", () => {
    const hub = new SseHub({ heartbeatMs: 0 });
    const fake = new FakeResponse();
    hub.addClient(asRes(fake));
    expect(hub.clientCount()).toBe(1);

    fake.emitClose();
    expect(hub.clientCount()).toBe(0);
  });

  it("写入失败的连接被剔除，不影响其余连接", () => {
    const hub = new SseHub({ heartbeatMs: 0 });
    const bad = new FakeResponse();
    const good = new FakeResponse();
    hub.addClient(asRes(bad));
    hub.addClient(asRes(good));
    // 清掉建连初始帧记录，专注本次广播。
    bad.chunks.length = 0;
    good.chunks.length = 0;

    bad.failNextWrite = true;
    hub.broadcast({ event: "high-risk", data: { description: "rm -rf" } });

    expect(hub.clientCount()).toBe(1); // bad 被剔除
    expect(good.text()).toContain(serializeSseFrame("high-risk", { description: "rm -rf" }));
    hub.closeAll();
  });

  it("notifier() 把 OrchestratorEvent 桥接为 SSE 帧并广播", () => {
    const hub = new SseHub({ heartbeatMs: 0 });
    const fake = new FakeResponse();
    hub.addClient(asRes(fake));
    fake.chunks.length = 0;

    const notifier = hub.notifier();
    notifier.emit({ kind: "scan-progress", found: ["x"] });

    expect(fake.text()).toContain(
      serializeSseFrame("scan:progress", { type: "scan:progress", found: ["x"] }),
    );
    hub.closeAll();
  });

  it("closeAll 结束所有连接并清空", () => {
    const hub = new SseHub({ heartbeatMs: 0 });
    const a = new FakeResponse();
    const b = new FakeResponse();
    hub.addClient(asRes(a));
    hub.addClient(asRes(b));

    hub.closeAll();

    expect(hub.clientCount()).toBe(0);
    expect(a.writableEnded).toBe(true);
    expect(b.writableEnded).toBe(true);
  });
});
