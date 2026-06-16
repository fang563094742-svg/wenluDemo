/**
 * proactive-awareness-demo —— SSE 推送通道（任务 15.1，R16.2）。
 *
 * 设计依据：design.md「7. Web 服务与对话界面（R16）→ Web_Server / 前端 app.js 行为要点」
 * 与「SSE 事件类型一览」。
 *
 * 运行形态：本机 Web 服务向浏览器 Conversation_UI **单向推送**服务端事件（REST 触发动作 +
 * SSE 单向推送，见 design「设计决策」）。本模块只负责 **SSE 通道本身**——用 Node 内置
 * `http` 的 `ServerResponse` 写 `text/event-stream`：
 *  - 管理 SSE 客户端连接（注册 / 注销 / 心跳保活）。
 *  - 广播：把语义事件序列化为 SSE 帧（`event: <name>\ndata: <json>\n\n`）推送给所有连接。
 *  - 提供把 `OrchestratorEvent` 适配为 SSE 帧的**桥接**（实现 `OrchestratorNotifier` 接口），
 *    供 `webServer` 注入给 `Orchestrator`（解耦：编排层只产语义事件，事件名 / 序列化在此）。
 *
 * 事件类型一览（与 design 呼应，分属扫描 / 执行两阶段，互不干扰）：
 *  - `scan:progress`      扫描阶段专用线索流，载荷 {@link ScanProgressEvent}（可选增强）。
 *  - `execution-progress` 执行阶段动作流，载荷 {@link ExecutionProgressEvent}，携带四态
 *                         `status`（`"ok" | "failed" | "blocked" | "skipped"`），与执行循环
 *                         `emitProgress` 同源。
 *  - 以及业务事件：状态变化 / 察觉呈现 / 澄清问题 / 最终理解 / 僵局 / 定界建议 /
 *    开始执行确认 / 备份大小警告 / 高危弹窗 / 阻断性提问 / 验收报告 / 已验收 / 错误。
 *
 * 安全：`scan:progress` 的 `found` 仅承载已过排除红线的元信息级线索，**绝不含文件正文**
 * （R3.5/R4.4）——本通道只是透传，载荷的元信息纯度由上游扫描层保证。
 *
 * _Requirements: 16.2_
 */

import type { ServerResponse } from "node:http";
import { screenOutboundText } from "../sovereign/privacy-boundary.js";

import type {
  OrchestratorEvent,
  OrchestratorNotifier,
} from "../orchestrator/orchestrator.js";
import type { ScanProgressEvent } from "../scanner/types.js";

// ===========================================================================
// SSE 事件名 —— 与 design「SSE 事件类型一览」一一对应
// ===========================================================================

/**
 * 通道允许的 SSE 事件名集合（前端 `es.addEventListener(<name>, ...)` 据此订阅）。
 *
 * 注意 `scan:progress` 与 `execution-progress` 并列、分属扫描与执行两阶段、互不干扰；
 * 其余为闭环业务事件。事件名取自 design，多数与 `OrchestratorEvent.kind` 同名，唯
 * `scan-progress` 对外采用 design 约定的 `scan:progress`。
 */
export type SseEventName =
  | "state-changed"
  | "scan:progress"
  | "awareness"
  | "clarify-questions"
  | "awaiting-understanding"
  | "impasse"
  | "scope-suggestion"
  | "ready-confirm"
  | "backup-size-warning"
  | "execution-progress"
  | "high-risk"
  | "blocking-question"
  | "delivery-report"
  | "accepted"
  | "error";

/** 一条待推送的 SSE 帧：事件名 + 任意可 JSON 序列化的载荷。 */
export interface SseFrame {
  /** SSE `event:` 字段。 */
  event: SseEventName;
  /** SSE `data:` 字段载荷（将被 JSON 序列化）。 */
  data: unknown;
}

// ===========================================================================
// 帧序列化（纯函数，便于单测）
// ===========================================================================

/**
 * 把一条事件序列化为 SSE 帧文本：`event: <name>\ndata: <json>\n\n`。
 *
 * 形式严格遵循 SSE 规范：
 *  - `data` 经 `JSON.stringify`；若其中含换行，则**逐行**加 `data: ` 前缀（多行 data 帧）。
 *  - 帧以空行（`\n\n`）结束，触发浏览器分发该事件。
 */
export function serializeSseFrame(event: string, data: unknown): string {
  const json = JSON.stringify(data ?? null);
  const dataLines = json
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

// ===========================================================================
// OrchestratorEvent → SSE 帧 桥接
// ===========================================================================

/**
 * 把编排层语义事件 {@link OrchestratorEvent} 适配为对外的 {@link SseFrame}。
 *
 * 桥接是解耦点：`Orchestrator` 只产出与传输无关的语义事件，对外事件名与载荷形状
 * （含 `scan-progress → scan:progress` 的重命名、`execution-progress` 四态 status 透传）
 * 在此一处确定，便于前端契约稳定与单测。
 */
export function orchestratorEventToFrame(event: OrchestratorEvent): SseFrame {
  switch (event.kind) {
    case "state-changed":
      return { event: "state-changed", data: { state: event.state } };
    case "scan-progress": {
      // 扫描阶段专用线索流：对外采用 design 约定的 `scan:progress` 事件名，
      // 载荷形状对齐 ScanProgressEvent（仅元信息级线索，绝不含正文）。
      const payload: ScanProgressEvent = {
        type: "scan:progress",
        found: event.found,
      };
      return { event: "scan:progress", data: payload };
    }
    case "awareness":
      return { event: "awareness", data: event.view };
    case "clarify-questions":
      return { event: "clarify-questions", data: { questions: event.questions } };
    case "awaiting-understanding":
      return {
        event: "awaiting-understanding",
        data: {
          taskFrame: event.taskFrame,
          confidence: event.confidence,
          prompt: event.prompt,
        },
      };
    case "impasse":
      return { event: "impasse", data: event.summary };
    case "scope-suggestion":
      return { event: "scope-suggestion", data: { suggestedPath: event.suggestedPath } };
    case "ready-confirm":
      return { event: "ready-confirm", data: { workingDir: event.workingDir } };
    case "backup-size-warning":
      return { event: "backup-size-warning", data: event.estimate };
    case "execution-progress":
      // 执行阶段动作流：四态 status 随 ExecutionProgressEvent 原样透传（与 emitProgress 同源）。
      return { event: "execution-progress", data: event.event };
    case "high-risk":
      return { event: "high-risk", data: { description: event.description } };
    case "blocking-question":
      return { event: "blocking-question", data: { problem: event.problem } };
    case "delivery-report":
      return { event: "delivery-report", data: event.report };
    case "accepted":
      return { event: "accepted", data: {} };
    case "error":
      return { event: "error", data: event.error };
  }
}

// ===========================================================================
// SseHub —— SSE 连接管理 + 广播 + 心跳
// ===========================================================================

/** {@link SseHub} 可调参数。 */
export interface SseHubOptions {
  /** 心跳间隔（毫秒），默认 15000；写入 SSE 注释行保活、防中间代理断流。 */
  heartbeatMs?: number;
}

/** SSE 通道响应头（禁缓存 / 禁代理缓冲 / 保持长连接）。 */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 关闭部分反代（如 nginx）对流的缓冲，确保事件即时到达浏览器。
  "X-Accel-Buffering": "no",
};

/**
 * SSE 推送通道：管理一组 `ServerResponse` 长连接，提供广播与心跳保活。
 *
 * 典型用法（webServer 注入给 Orchestrator）：
 * ```ts
 * const hub = new SseHub();
 * // GET /events 处理器中：
 * hub.addClient(res);
 * // 装配编排器时：new Orchestrator({ ..., notifier: hub.notifier() });
 * ```
 *
 * 设计要点：
 *  - **单向**：只向浏览器写，不读浏览器（读路径走 REST，见 routes）。
 *  - **韧性**：单个连接写失败不影响其余连接；写失败 / 连接关闭即自动注销。
 *  - **不阻止进程退出**：心跳定时器 `unref()`，不会因纯心跳而把进程吊住。
 */
export class SseHub {
  /** 当前活跃的 SSE 客户端连接集合。 */
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeatMs: number;
  /** 心跳定时器；仅在存在连接时运行，最后一个连接离开即停。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // 运行统计（本地未提交代码引入，从删除前缓存恢复）——供 /health runtimeHealthPayload 读取。
  private connectCount = 0;
  private disconnectCount = 0;
  private broadcastCount = 0;
  private lastConnectAt: string | null = null;
  private lastDisconnectAt: string | null = null;
  private lastBroadcastAt: string | null = null;

  constructor(options: SseHubOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  /** 当前活跃连接数。 */
  clientCount(): number {
    return this.clients.size;
  }

  /** 运行统计快照（连接/断开/广播计数与最近时间）。本地未提交代码引入，从删除前缓存恢复。 */
  stats(): {
    clients: number;
    connectCount: number;
    disconnectCount: number;
    broadcastCount: number;
    lastConnectAt: string | null;
    lastDisconnectAt: string | null;
    lastBroadcastAt: string | null;
  } {
    return {
      clients: this.clients.size,
      connectCount: this.connectCount,
      disconnectCount: this.disconnectCount,
      broadcastCount: this.broadcastCount,
      lastConnectAt: this.lastConnectAt,
      lastDisconnectAt: this.lastDisconnectAt,
      lastBroadcastAt: this.lastBroadcastAt,
    };
  }

  /**
   * 注册一个新的 SSE 客户端连接（在 `GET /events` 处理器中调用）。
   *
   * 写入 SSE 响应头并发出初始注释帧建立流；监听连接关闭以自动注销；
   * 首个连接到来时启动心跳。
   *
   * @returns 注销函数（亦会在底层连接 `close` 时自动触发）。
   */
  addClient(res: ServerResponse): () => void {
    res.writeHead(200, SSE_HEADERS);
    // 部分运行时需要显式 flush 头部，确保浏览器尽快进入 open 状态（触发就绪握手）。
    res.flushHeaders?.();
    // 关闭连接级超时并启用 TCP 保活，避免空闲被中途断开。
    res.socket?.setTimeout?.(0);
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true);

    // 初始帧：设定断线重连间隔 + 一条注释，立即把流"打开"。
    res.write(`retry: ${this.heartbeatMs}\n`);
    res.write(`: connected\n\n`);

    this.clients.add(res);
    this.connectCount += 1;
    this.lastConnectAt = new Date().toISOString();

    const unregister = (): void => this.removeClient(res);
    res.on("close", unregister);
    res.on("error", unregister);

    this.ensureHeartbeat();
    return unregister;
  }

  /** 注销一个连接：从集合移除、结束响应、必要时停掉心跳。 */
  removeClient(res: ServerResponse): void {
    if (!this.clients.delete(res)) return;
    this.disconnectCount += 1;
    this.lastDisconnectAt = new Date().toISOString();
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // 连接可能已被对端关闭，忽略结束时的异常。
      }
    }
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /**
   * 把一条 SSE 帧广播给所有活跃连接。
   *
   * 对每个连接独立写入；任一连接写入抛错（如已断开）即就地注销该连接，
   * 不影响其余连接（韧性，R1.6 服务保持运行）。
   */
  broadcast(frame: SseFrame): void {
    if (this.clients.size === 0) return;
    // SSE 双保险：对最终 JSON 字符串再过一次 screenOutboundText, 兜住源头未筛查的载荷。
    const rawText = serializeSseFrame(frame.event, frame.data);
    const screened = screenOutboundText(rawText);
    const text = screened.leaked ? serializeSseFrame(frame.event, { redacted: true, message: screened.safeText }) : rawText;
    if (screened.leaked) {
      console.warn(`[sse:redacted] event=${frame.event} matched=${screened.matched ?? "?"}`);
    }
    this.broadcastCount += 1;
    this.lastBroadcastAt = new Date().toISOString();
    // 复制成数组再迭代：注销会修改底层 Set，避免迭代期改集合。
    for (const res of [...this.clients]) {
      this.writeTo(res, text);
    }
  }

  /**
   * 返回一个 {@link OrchestratorNotifier}：把编排层语义事件桥接为 SSE 帧并广播。
   * 供 `webServer` 在装配 `Orchestrator` 时注入（`{ notifier: hub.notifier() }`）。
   */
  notifier(): OrchestratorNotifier {
    return {
      emit: (event: OrchestratorEvent): void => {
        this.broadcast(orchestratorEventToFrame(event));
      },
    };
  }

  /** 关闭全部连接并停掉心跳（供 webServer `shutdown` 调用）。 */
  closeAll(): void {
    for (const res of [...this.clients]) {
      this.removeClient(res);
    }
    this.stopHeartbeat();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 向单个连接写入文本；失败即注销该连接。 */
  private writeTo(res: ServerResponse, text: string): void {
    if (res.writableEnded) {
      this.removeClient(res);
      return;
    }
    try {
      res.write(text);
    } catch {
      this.removeClient(res);
    }
  }

  /** 存在连接且尚无心跳时启动心跳定时器（注释帧保活）。 */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const res of [...this.clients]) {
        this.writeTo(res, `: heartbeat\n\n`);
      }
    }, this.heartbeatMs);
    // 纯心跳不应吊住进程退出。
    this.heartbeatTimer.unref?.();
  }

  /** 停止心跳定时器。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
