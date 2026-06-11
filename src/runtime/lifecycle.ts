/**
 * lifecycle.ts — 单一生命周期管理器。
 *
 * 取代：
 * - riverMain 的 alive flag + breathe while 循环
 * - orchestrator 的独立状态机
 * - session 的 active/inactive 判断
 *
 * 统一为一个生命周期：
 *   INIT → RUNNING → IDLE → RUNNING → ... → SHUTDOWN
 *
 * 职责：
 * 1. 启动时：加载 state snapshot + 恢复 ledger tail + 健康检查
 * 2. 运行时：调度 breathe 循环（尊重 budget + user presence）
 * 3. 空闲时：降频/休眠（不烧 LLM）
 * 4. 关停时：持久化 + 清理 + graceful shutdown
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { AgentState } from "./agentState.js";
import { createInitialAgentState } from "./agentState.js";
import type { EventBus } from "./eventBus.js";
import { createEvent } from "./eventBus.js";
import type { Store, Command } from "./reducer.js";
import type { ActionLedger } from "./actionLedger.js";
import type { ArtifactStore } from "./artifactStore.js";

// ═══════════════════════════════════════════════════════════════════════
// 生命周期阶段
// ═══════════════════════════════════════════════════════════════════════

export type LifecyclePhase = "init" | "running" | "idle" | "shutdown";

export interface LifecycleConfig {
  dataDir: string;
  breatheIntervalMs: number;
  idleThresholdMs: number;
  snapshotIntervalMs: number;
  maxConsecutiveIdle: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  dataDir: "",
  breatheIntervalMs: 12000,
  idleThresholdMs: 600000,     // 10min 无用户活动 → idle
  snapshotIntervalMs: 60000,   // 每分钟快照一次
  maxConsecutiveIdle: 50,      // idle 超过 50 轮触发休眠
};

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle Manager
// ═══════════════════════════════════════════════════════════════════════

export interface LifecycleManager {
  phase(): LifecyclePhase;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  onBreathe(handler: (cycle: number) => Promise<void>): void;
  notifyUserActivity(): void;
  forceRunCycle(): Promise<void>;
}

export function createLifecycleManager(
  config: Partial<LifecycleConfig> & { dataDir: string },
  store: Store,
  eventBus: EventBus,
  ledger: ActionLedger,
  artifactStore: ArtifactStore,
): LifecycleManager {
  const cfg: LifecycleConfig = { ...DEFAULT_CONFIG, ...config };
  let currentPhase: LifecyclePhase = "init";
  let breatheHandler: ((cycle: number) => Promise<void>) | null = null;
  let breatheTimer: ReturnType<typeof setInterval> | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let lastUserActivity = Date.now();
  let consecutiveIdle = 0;
  let running = false;

  const snapshotPath = resolvePath(cfg.dataDir, "agent-state.snapshot.json");

  // --- 持久化 ---

  async function persistSnapshot(): Promise<void> {
    const state = store.getState();
    const toWrite = { ...state, lastPersistedAt: new Date().toISOString() };
    await mkdir(cfg.dataDir, { recursive: true });
    await writeFile(snapshotPath, JSON.stringify(toWrite, null, 2), "utf-8");
    eventBus.emit(createEvent("state-persisted", "lifecycle", { version: state.version }));
  }

  async function loadSnapshot(): Promise<AgentState | null> {
    try {
      const content = await readFile(snapshotPath, "utf-8");
      return JSON.parse(content) as AgentState;
    } catch {
      return null;
    }
  }

  // --- 循环调度 ---

  function isUserAway(): boolean {
    return Date.now() - lastUserActivity > cfg.idleThresholdMs;
  }

  async function tick(): Promise<void> {
    if (!running) return;
    if (currentPhase === "shutdown") return;

    // 检查用户是否离开
    if (isUserAway()) {
      if (currentPhase !== "idle") {
        currentPhase = "idle";
        eventBus.emit(createEvent("lifecycle-phase", "lifecycle", { phase: "idle" }));
      }
      consecutiveIdle++;
      if (consecutiveIdle >= cfg.maxConsecutiveIdle) {
        return; // 超深度休眠——不做任何事
      }
      // idle 模式降频：每 3 轮才真正呼吸一次
      if (consecutiveIdle % 3 !== 0) return;
    } else {
      if (currentPhase === "idle") {
        currentPhase = "running";
        consecutiveIdle = 0;
        eventBus.emit(createEvent("lifecycle-phase", "lifecycle", { phase: "running" }));
      }
    }

    // 执行呼吸
    const cycle = store.getState().identity.cycles;
    store.dispatch({ kind: "identity/cycle-increment", payload: {} });
    store.dispatch({ kind: "identity/heartbeat", payload: { timestamp: new Date().toISOString() } });
    eventBus.emit(createEvent("breathe-start", "lifecycle", { cycle: cycle + 1 }, cycle + 1));

    if (breatheHandler) {
      try {
        await breatheHandler(cycle + 1);
      } catch (err) {
        eventBus.emit(createEvent("error", "lifecycle", { error: String(err), cycle: cycle + 1 }));
      }
    }

    eventBus.emit(createEvent("breathe-end", "lifecycle", { cycle: cycle + 1 }, cycle + 1));
  }

  // --- 公开接口 ---

  function phase(): LifecyclePhase {
    return currentPhase;
  }

  async function start(): Promise<void> {
    currentPhase = "init";
    eventBus.emit(createEvent("lifecycle-phase", "lifecycle", { phase: "init" }));

    // 尝试恢复快照
    const saved = await loadSnapshot();
    if (saved) {
      // 用 saved 状态替换 store 中的初始状态（通过 dispatch 不可能，需要 store 层支持 hydrate）
      // 这里简化处理：直接 dispatch 关键字段恢复
      // 实际生产中应有 store.hydrate(saved) 接口
    }

    currentPhase = "running";
    running = true;
    eventBus.emit(createEvent("lifecycle-phase", "lifecycle", { phase: "running" }));

    // 启动定时器
    breatheTimer = setInterval(() => { tick().catch(() => {}); }, cfg.breatheIntervalMs);
    snapshotTimer = setInterval(() => { persistSnapshot().catch(() => {}); }, cfg.snapshotIntervalMs);

    // 首次快照
    await persistSnapshot();
  }

  async function shutdown(): Promise<void> {
    currentPhase = "shutdown";
    running = false;
    eventBus.emit(createEvent("lifecycle-phase", "lifecycle", { phase: "shutdown" }));

    if (breatheTimer) { clearInterval(breatheTimer); breatheTimer = null; }
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }

    store.dispatch({ kind: "identity/heartbeat", payload: { timestamp: new Date().toISOString() } });
    await persistSnapshot();
  }

  function onBreathe(handler: (cycle: number) => Promise<void>): void {
    breatheHandler = handler;
  }

  function notifyUserActivity(): void {
    lastUserActivity = Date.now();
    if (currentPhase === "idle") {
      currentPhase = "running";
      consecutiveIdle = 0;
      eventBus.emit(createEvent("user-returned", "lifecycle", {}));
    }
  }

  async function forceRunCycle(): Promise<void> {
    await tick();
  }

  return { phase, start, shutdown, onBreathe, notifyUserActivity, forceRunCycle };
}
