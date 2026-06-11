/**
 * eventBus.ts — 唯一事件总线。
 *
 * 职责清单（三不做原则）：
 * 1. 传播事件（跨模块通知） ✓
 * 2. 不负责写入状态（写入走 reducer）
 * 3. 不负责持久化（持久化走 lifecycle + artifactStore）
 *
 * 设计要点：
 * - 同步 emit（防止事件丢失）
 * - 支持 replay（从 actionLedger 回放历史事件）
 * - 支持通配符监听（'*' 监听所有事件）
 * - 弱引用防止内存泄漏
 */

// ═══════════════════════════════════════════════════════════════════════
// 事件类型定义
// ═══════════════════════════════════════════════════════════════════════

export type AgentEventKind =
  | "user-input"
  | "user-away"
  | "user-returned"
  | "tool-invoked"
  | "tool-completed"
  | "tool-failed"
  | "breathe-start"
  | "breathe-end"
  | "reflect-start"
  | "reflect-result"
  | "evolve-tick"
  | "verification-result"
  | "state-persisted"
  | "evolution-tick"
  | "user-mirror-updated"
  | "budget-warning"
  | "budget-exhausted"
  | "error"
  | "lifecycle-phase"
  | "task-created"
  | "task-completed"
  | "task-failed"
  | "prediction-settled"
  | "capability-forged"
  | "sensor-grown"
  | "drift-detected"
  | "meta-reflection-rejected";

export interface AgentEvent {
  kind: AgentEventKind;
  timestamp: string;
  cycle?: number;
  source: string;
  payload: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// 事件构造辅助
// ═══════════════════════════════════════════════════════════════════════

export function createEvent(kind: AgentEventKind, source: string, payload: unknown, cycle?: number): AgentEvent {
  return {
    kind,
    timestamp: new Date().toISOString(),
    cycle,
    source,
    payload,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// EventBus 实现
// ═══════════════════════════════════════════════════════════════════════

export type EventHandler = (event: AgentEvent) => void;

export interface EventBus {
  emit(event: AgentEvent): void;
  on(kind: AgentEventKind | "*", handler: EventHandler): () => void;
  off(kind: AgentEventKind | "*", handler: EventHandler): void;
  once(kind: AgentEventKind, handler: EventHandler): () => void;
  history(since?: string, kinds?: AgentEventKind[]): AgentEvent[];
  clear(): void;
}

export function createEventBus(opts?: { historyLimit?: number }): EventBus {
  const limit = opts?.historyLimit ?? 2000;
  const handlers = new Map<AgentEventKind | "*", Set<EventHandler>>();
  const eventHistory: AgentEvent[] = [];

  function getOrCreate(kind: AgentEventKind | "*"): Set<EventHandler> {
    let set = handlers.get(kind);
    if (!set) {
      set = new Set();
      handlers.set(kind, set);
    }
    return set;
  }

  function emit(event: AgentEvent): void {
    // 保留历史（ring buffer）
    eventHistory.push(event);
    if (eventHistory.length > limit) {
      eventHistory.shift();
    }
    // 精确匹配
    const specific = handlers.get(event.kind);
    if (specific) {
      for (const h of specific) {
        try { h(event); } catch { /* handler 不允许拖垮总线 */ }
      }
    }
    // 通配符
    const wildcard = handlers.get("*");
    if (wildcard) {
      for (const h of wildcard) {
        try { h(event); } catch { /* handler 不允许拖垮总线 */ }
      }
    }
  }

  function on(kind: AgentEventKind | "*", handler: EventHandler): () => void {
    getOrCreate(kind).add(handler);
    return () => off(kind, handler);
  }

  function off(kind: AgentEventKind | "*", handler: EventHandler): void {
    handlers.get(kind)?.delete(handler);
  }

  function once(kind: AgentEventKind, handler: EventHandler): () => void {
    const wrapper: EventHandler = (event) => {
      off(kind, wrapper);
      handler(event);
    };
    return on(kind, wrapper);
  }

  function history(since?: string, kinds?: AgentEventKind[]): AgentEvent[] {
    let result = eventHistory;
    if (since) {
      result = result.filter(e => e.timestamp >= since);
    }
    if (kinds && kinds.length > 0) {
      const kindSet = new Set(kinds);
      result = result.filter(e => kindSet.has(e.kind));
    }
    return result;
  }

  function clear(): void {
    eventHistory.length = 0;
  }

  return { emit, on, off, once, history, clear };
}
