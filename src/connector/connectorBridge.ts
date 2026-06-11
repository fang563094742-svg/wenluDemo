/**
 * 连接器桥接层（平台侧）。
 *
 * 背景（本次迁移目标）：
 *  - 原 riverMain 的「扫描」与「执行」都发生在**启动服务的机器**上（safeExec / fs）。
 *  - 现在要让这两类动作发生在**当前访问网页的用户自己的电脑**上，经本地连接器完成。
 *
 * 架构：
 *  - 用户本机的连接器（wenluConnector）作为 WebSocket **客户端**外连本模块。
 *  - 本模块维护已连接的连接器，并提供 `request(op, args)`：把一条指令下发给连接器，
 *    在用户本机执行后拿回结果（带超时与请求/响应配对）。
 *  - riverMain 的 executeTool / perceive 在「连接器在线」时优先走这里（手和眼睛在用户机），
 *    连接器不在线时回退到原服务端 safeExec / fs（不破坏原主链）。
 *
 * 安全：连接器只接受经本 WS 通道下发的指令；本地 32101 仅暴露只读 /status。
 *
 * 说明：当前 river demo 为单用户形态，桥接「最近连上的活跃连接器」。
 * 多用户按 userId 路由留待登录/会话体系接入后扩展（任务要求：登录模块由他人完成后接上）。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export type ConnectorOp = "exec" | "read_file" | "write_file" | "list_dir" | "scan";

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectorClient {
  id: string;
  ws: WebSocket;
  platform: string;
  arch: string;
  version: string;
  machineLabel: string;
  folders?: { home?: string; desktop?: string; documents?: string; downloads?: string };
  connectedAt: number;
}

export interface ConnectorInfo {
  id: string;
  platform: string;
  arch: string;
  version: string;
  machineLabel: string;
  connectedAt: string;
}

export class ConnectorBridge {
  private wss: WebSocketServer;
  private clients = new Map<string, ConnectorClient>();
  private pending = new Map<string, PendingRequest>();
  private defaultTimeoutMs: number;
  private onChange: (online: boolean) => void;

  constructor(opts: { defaultTimeoutMs?: number; onChange?: (online: boolean) => void } = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.onChange = opts.onChange ?? (() => {});
    // noServer：复用 riverMain 现有的 http.Server，仅在 upgrade 时按路径接管。
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  /** 是否有活跃连接器（手和眼睛是否已落到用户本机）。 */
  isOnline(): boolean {
    return this.clients.size > 0;
  }

  /** 当前用于路由的连接器的平台信息（用于让 agent 按平台用对命令）。无连接器返回 null。 */
  activeInfo(): { platform: string; arch: string; machineLabel: string; folders?: { home?: string; desktop?: string; documents?: string; downloads?: string } } | null {
    const c = this.pick();
    if (!c) return null;
    return { platform: c.platform, arch: c.arch, machineLabel: c.machineLabel, folders: c.folders };
  }

  /** 列出当前已连接的连接器（用于状态展示/诊断）。 */
  list(): ConnectorInfo[] {
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      platform: c.platform,
      arch: c.arch,
      version: c.version,
      machineLabel: c.machineLabel,
      connectedAt: new Date(c.connectedAt).toISOString(),
    }));
  }

  /**
   * 处理 http server 的 upgrade 事件。仅接管路径 `/connector/ws`，
   * 其余路径不处理（交还给 riverMain 的其它逻辑 / 静态服务）。
   * @returns 是否已接管该 upgrade。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/connector/ws") return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
    return true;
  }

  private handleConnection(ws: WebSocket): void {
    const id = randomUUID();
    const client: ConnectorClient = {
      id,
      ws,
      platform: "unknown",
      arch: "unknown",
      version: "unknown",
      machineLabel: "unknown",
      connectedAt: Date.now(),
    };

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        client.platform = String(msg.platform ?? "unknown");
        client.arch = String(msg.arch ?? "unknown");
        client.version = String(msg.version ?? "unknown");
        client.machineLabel = String(msg.machineLabel ?? "unknown");
        if (msg.folders && typeof msg.folders === "object") client.folders = msg.folders;
        const wasOnline = this.isOnline();
        this.clients.set(id, client);
        if (!wasOnline) this.onChange(true);
        console.log(`[connector] 连接器上线 ${client.machineLabel} (${client.platform}/${client.arch})`);
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "result" && typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(String(msg.error ?? "连接器执行失败")));
      }
    });

    const cleanup = (): void => {
      this.clients.delete(id);
      if (!this.isOnline()) this.onChange(false);
      console.log(`[connector] 连接器下线 ${client.machineLabel}`);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  /** 选择当前用于路由的连接器（demo：最近连上的那台）。 */
  private pick(): ConnectorClient | null {
    let latest: ConnectorClient | null = null;
    for (const c of this.clients.values()) {
      if (!latest || c.connectedAt > latest.connectedAt) latest = c;
    }
    return latest;
  }

  /**
   * 下发一条指令到用户本机连接器并等待结果。
   * @throws 无连接器在线 / 超时 / 连接器报错。
   */
  request<T = unknown>(op: ConnectorOp, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const client = this.pick();
    if (!client) return Promise.reject(new Error("无连接器在线"));
    const id = randomUUID();
    const to = timeoutMs ?? this.defaultTimeoutMs;
    console.log(`[路由→连接器] op=${op} 机器=${client.machineLabel} args=${JSON.stringify(args).slice(0, 140)}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`连接器响应超时(${to}ms)`));
      }, to);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      try {
        client.ws.send(JSON.stringify({ type: "cmd", id, op, args }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}
