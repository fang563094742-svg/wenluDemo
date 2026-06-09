/**
 * 问路 — SessionManager：管理多用户会话的生命周期。
 *
 * - 按 userId 创建/缓存 UserSession
 * - LRU 淘汰不活跃会话（默认 30 分钟无心跳即休眠保存）
 * - 提供全局 getSession(userId) 入口
 */

import { UserSession } from "./UserSession.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无活跃则休眠

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private idleTimeoutMs: number;
  private gcInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { idleTimeoutMs?: number }) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** 获取或创建用户会话（含初始化）。 */
  async getSession(userId: string): Promise<UserSession> {
    let session = this.sessions.get(userId);
    if (session) {
      session.touch();
      return session;
    }

    // 首次加载
    session = new UserSession(userId);
    await session.init();
    this.sessions.set(userId, session);
    console.log(`[SessionManager] 用户 ${userId} 会话已加载 (当前活跃: ${this.sessions.size})`);
    return session;
  }

  /** 检查会话是否已加载（不触发创建）。 */
  hasSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /** 立即关闭指定会话。 */
  async closeSession(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    await session.shutdown();
    this.sessions.delete(userId);
    console.log(`[SessionManager] 用户 ${userId} 会话已关闭`);
  }

  /** 启动定期 GC：清理超时无活跃的会话。 */
  startGc(): void {
    if (this.gcInterval) return;
    this.gcInterval = setInterval(() => void this.gc(), 60_000); // 每分钟扫一次
  }

  /** 停止 GC。 */
  stopGc(): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /** GC 一轮：关闭所有超时不活跃的会话。 */
  private async gc(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActiveAt > this.idleTimeoutMs) {
        toClose.push(userId);
      }
    }
    for (const userId of toClose) {
      await this.closeSession(userId);
    }
    if (toClose.length > 0) {
      console.log(`[SessionManager] GC: 已休眠 ${toClose.length} 个不活跃会话`);
    }
  }

  /** 关闭所有会话（进程退出时调用）。 */
  async shutdownAll(): Promise<void> {
    this.stopGc();
    const promises = [...this.sessions.keys()].map((uid) => this.closeSession(uid));
    await Promise.all(promises);
  }

  /** 当前活跃会话数。 */
  get activeCount(): number {
    return this.sessions.size;
  }

  /** 列出当前活跃的 userId。 */
  listActiveUsers(): string[] {
    return [...this.sessions.keys()];
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
