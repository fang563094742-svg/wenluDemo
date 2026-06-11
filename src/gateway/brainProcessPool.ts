/**
 * 问路 — 多用户大脑进程池（multiuser-pg-store 阶段二·网关）。
 *
 * 每个用户的大脑 = 一个独立 riverMain 进程（`WENLU_BRAIN_USER=<userId>` + 独立 PORT），
 * 进程间天然完全隔离（各自全局态 + 各自 PG 行经 WHERE user_id + RLS）。本池负责：
 *  - 按需唤起：首次有该用户请求时 spawn 其大脑进程，轮询 /health 就绪后才放行。
 *  - 空闲回收：超过 idleTimeoutMs 无活动的进程优雅终止（SIGTERM → 进程内 saveMind + closePool）。
 *  - 端口分配：从 basePort 起找空闲端口。
 *
 * 直接以 `node <tsx-cli> src/riverMain.ts` spawn 单一子进程，便于按 PID 干净回收。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { request as httpRequest } from "node:http";

export interface BrainProc {
  userId: string;
  port: number;
  proc: ChildProcess;
  ready: boolean;
  startedAt: number;
  lastActiveAt: number;
}

export interface PoolOptions {
  repoRoot: string;
  basePort: number;          // 子进程端口起点（如 4100）
  maxProcs: number;          // 最多并发大脑进程
  idleTimeoutMs: number;     // 空闲多久回收
  healthTimeoutMs: number;   // 等待就绪上限
}

const DEFAULTS: Omit<PoolOptions, "repoRoot"> = {
  basePort: parseInt(process.env.WENLU_GW_CHILD_BASE_PORT ?? "4100", 10),
  maxProcs: parseInt(process.env.WENLU_GW_MAX_PROCS ?? "20", 10),
  idleTimeoutMs: parseInt(process.env.WENLU_GW_IDLE_MS ?? `${30 * 60 * 1000}`, 10),
  healthTimeoutMs: parseInt(process.env.WENLU_GW_HEALTH_MS ?? "60000", 10),
};

export class BrainProcessPool {
  private procs = new Map<string, BrainProc>();
  private starting = new Map<string, Promise<BrainProc>>();
  private usedPorts = new Set<number>();
  private opts: PoolOptions;
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: Partial<PoolOptions> & { repoRoot: string }) {
    this.opts = { ...DEFAULTS, ...opts };
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref?.();
  }

  /** 取（或唤起）某用户的大脑进程，确保 /health 就绪。 */
  async acquire(userId: string): Promise<BrainProc> {
    const existing = this.procs.get(userId);
    if (existing && existing.ready && !existing.proc.killed) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    const inflight = this.starting.get(userId);
    if (inflight) return inflight;

    const p = this.spawnFor(userId);
    this.starting.set(userId, p);
    try {
      const bp = await p;
      return bp;
    } finally {
      this.starting.delete(userId);
    }
  }

  private allocPort(): number {
    for (let port = this.opts.basePort; port < this.opts.basePort + 1000; port++) {
      if (!this.usedPorts.has(port)) { this.usedPorts.add(port); return port; }
    }
    throw new Error("[gateway] 无可用端口");
  }

  private async spawnFor(userId: string): Promise<BrainProc> {
    if (this.procs.size >= this.opts.maxProcs) {
      // 满了 → 先回收最久未活动者
      await this.evictLru();
    }
    const port = this.allocPort();
    const tsxCli = resolvePath(this.opts.repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const proc = spawn(process.execPath, [tsxCli, "src/riverMain.ts"], {
      cwd: this.opts.repoRoot,
      env: { ...process.env, WENLU_BRAIN_USER: userId, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout?.on("data", () => { /* 子进程日志可按需转存 */ });
    proc.stderr?.on("data", (d) => { console.error(`[gw:child ${userId.slice(0, 8)}:${port}] ${String(d).slice(0, 300)}`); });

    const bp: BrainProc = { userId, port, proc, ready: false, startedAt: Date.now(), lastActiveAt: Date.now() };
    this.procs.set(userId, bp);

    proc.on("exit", (code, signal) => {
      console.error(`[gw:child ${userId.slice(0, 8)}:${port}] exit code=${code} signal=${signal}`);
      this.usedPorts.delete(port);
      const cur = this.procs.get(userId);
      if (cur && cur.proc === proc) this.procs.delete(userId);
    });
    proc.on("error", (err) => { console.error(`[gw:child ${userId.slice(0, 8)}:${port}] spawn error: ${err.message}`); });

    await this.waitHealthy(port);
    bp.ready = true;
    return bp;
  }

  private async waitHealthy(port: number): Promise<void> {
    const deadline = Date.now() + this.opts.healthTimeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.pingHealth(port);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`[gateway] 大脑进程 port=${port} 在 ${this.opts.healthTimeoutMs}ms 内未就绪`);
  }

  private pingHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  private async evictLru(): Promise<void> {
    let oldest: BrainProc | null = null;
    for (const bp of this.procs.values()) {
      if (!oldest || bp.lastActiveAt < oldest.lastActiveAt) oldest = bp;
    }
    if (oldest) await this.stop(oldest.userId);
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const toStop: string[] = [];
    for (const bp of this.procs.values()) {
      if (now - bp.lastActiveAt > this.opts.idleTimeoutMs) toStop.push(bp.userId);
    }
    for (const uid of toStop) await this.stop(uid);
  }

  /** 优雅停止某用户大脑进程（SIGTERM → 进程内 saveMind + closePool）。 */
  async stop(userId: string): Promise<void> {
    const bp = this.procs.get(userId);
    if (!bp) return;
    this.procs.delete(userId);
    this.usedPorts.delete(bp.port);
    try { bp.proc.kill("SIGTERM"); } catch { /* ignore */ }
    // 兜底：3s 未退则强杀
    setTimeout(() => { try { if (!bp.proc.killed) bp.proc.kill("SIGKILL"); } catch { /* ignore */ } }, 3000).unref?.();
  }

  async shutdownAll(): Promise<void> {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null; }
    await Promise.all([...this.procs.keys()].map((uid) => this.stop(uid)));
  }

  list(): Array<{ userId: string; port: number; ready: boolean; idleMs: number }> {
    const now = Date.now();
    return [...this.procs.values()].map((bp) => ({ userId: bp.userId, port: bp.port, ready: bp.ready, idleMs: now - bp.lastActiveAt }));
  }
}
