/**
 * reducer.ts — 状态写入纪律。
 *
 * 核心铁律：agentState 的任何修改必须经过 reducer。
 * 没有模块可以直接 state.xxx = yyy，全部通过 dispatch(command) → reducer → new state。
 *
 * 设计参考：CQRS 的 Command 侧——但不做 Event Sourcing（太重），
 * 而是 Command → Reducer → State + SideEffect 列表。
 *
 * 收益：
 * 1. 所有状态变更可追踪（command 日志 = 变更日志）
 * 2. 防止模块间通过状态偷偷耦合
 * 3. 可做 time-travel debug（记录 command 序列即可回放）
 * 4. eventBus 只传播通知，不负责改状态——职责清晰
 */

import type { AgentState } from "./agentState.js";
import type { LedgerEntry } from "./actionLedger.js";

// ═══════════════════════════════════════════════════════════════════════
// Command 类型（所有允许的写入操作）
// ═══════════════════════════════════════════════════════════════════════

export type StateCommand =
  // === 执行相关 ===
  | { kind: "task/add"; payload: { task: AgentState["execution"]["activeTasks"][0] } }
  | { kind: "task/update"; payload: { taskId: string; updates: Partial<AgentState["execution"]["activeTasks"][0]> } }
  | { kind: "task/remove"; payload: { taskId: string } }
  | { kind: "verification/add"; payload: { verification: AgentState["execution"]["pendingVerifications"][0] } }
  | { kind: "verification/resolve"; payload: { taskId: string; result: unknown } }
  | { kind: "checkpoint/save"; payload: { checkpoint: AgentState["execution"]["rollbackPoints"][0] } }
  | { kind: "checkpoint/rollback"; payload: { checkpointId: string } }

  // === 记忆相关 ===
  | { kind: "belief/add"; payload: { belief: AgentState["memory"]["beliefs"][0] } }
  | { kind: "belief/update"; payload: { beliefId: string; updates: Partial<AgentState["memory"]["beliefs"][0]> } }
  | { kind: "belief/remove"; payload: { beliefId: string } }
  | { kind: "knowledge/add"; payload: { entry: AgentState["memory"]["knowledge"][0] } }
  | { kind: "knowledge/remove"; payload: { entryId: string } }
  | { kind: "riverbed/update"; payload: { domain: string; updates: unknown } }

  // === 用户镜像相关 ===
  | { kind: "mirror/insight-add"; payload: { insight: AgentState["userMirror"]["insights"][0] } }
  | { kind: "mirror/insight-update"; payload: { insightId: string; updates: Partial<AgentState["userMirror"]["insights"][0]> } }
  | { kind: "mirror/prediction-add"; payload: { prediction: AgentState["userMirror"]["shadowPredictions"][0] } }
  | { kind: "mirror/prediction-settle"; payload: { predictionId: string; outcome: boolean } }
  | { kind: "mirror/drift-signal"; payload: { signal: AgentState["userMirror"]["driftSignals"][0] } }

  // === 进化相关 ===
  | { kind: "evolution/capability-add"; payload: { capability: AgentState["evolution"]["capabilities"][0] } }
  | { kind: "evolution/capability-remove"; payload: { name: string } }
  | { kind: "evolution/reflection-add"; payload: { entry: AgentState["evolution"]["reflections"][0] } }
  | { kind: "evolution/task-add"; payload: { task: AgentState["evolution"]["verifiableTasks"][0] } }
  | { kind: "evolution/task-update"; payload: { taskId: string; updates: unknown } }
  | { kind: "evolution/goal-update"; payload: { updates: Partial<AgentState["evolution"]["goal"]> } }
  | { kind: "evolution/velocity-snapshot"; payload: { snapshot: AgentState["evolution"]["velocity"] } }
  | { kind: "evolution/hook-update"; payload: { hook: AgentState["evolution"]["selfHooks"] } }

  // === 身份 / 生命周期 ===
  | { kind: "identity/heartbeat"; payload: { timestamp: string } }
  | { kind: "identity/cycle-increment"; payload: {} }

  // === 批量 / 事务 ===
  | { kind: "batch"; payload: { commands: StateCommand[] } }
  ;

// ═══════════════════════════════════════════════════════════════════════
// Reducer 产出
// ═══════════════════════════════════════════════════════════════════════

export interface ReducerResult {
  state: AgentState;
  applied: boolean;
  sideEffects: SideEffect[];
  error?: string;
}

export interface SideEffect {
  kind: "persist" | "emit-event" | "log" | "notify-user";
  payload: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// Reducer 实现
// ═══════════════════════════════════════════════════════════════════════

export function reduce(state: AgentState, command: StateCommand): ReducerResult {
  const sideEffects: SideEffect[] = [];

  try {
    // batch 递归处理
    if (command.kind === "batch") {
      let currentState = state;
      for (const sub of command.payload.commands) {
        const result = reduce(currentState, sub);
        if (!result.applied) {
          return { state, applied: false, sideEffects: [], error: result.error };
        }
        currentState = result.state;
        sideEffects.push(...result.sideEffects);
      }
      return { state: incrementVersion(currentState), applied: true, sideEffects };
    }

    const newState = applyCommand(structuredClone(state), command);
    sideEffects.push({ kind: "persist", payload: { version: newState.version } });
    sideEffects.push({ kind: "emit-event", payload: { eventKind: "state-mutated", command: command.kind } });

    return { state: incrementVersion(newState), applied: true, sideEffects };
  } catch (err: any) {
    return { state, applied: false, sideEffects: [], error: err.message };
  }
}

function applyCommand(state: AgentState, command: StateCommand): AgentState {
  switch (command.kind) {
    // === 执行 ===
    case "task/add":
      state.execution.activeTasks.push(command.payload.task);
      break;
    case "task/update": {
      const task = state.execution.activeTasks.find(t => t.id === command.payload.taskId);
      if (task) Object.assign(task, command.payload.updates);
      break;
    }
    case "task/remove":
      state.execution.activeTasks = state.execution.activeTasks.filter(t => t.id !== command.payload.taskId);
      break;
    case "verification/add":
      state.execution.pendingVerifications.push(command.payload.verification);
      break;
    case "verification/resolve":
      state.execution.pendingVerifications = state.execution.pendingVerifications.filter(v => v.id !== command.payload.taskId);
      break;
    case "checkpoint/save":
      state.execution.rollbackPoints.push(command.payload.checkpoint);
      if (state.execution.rollbackPoints.length > 20) state.execution.rollbackPoints.shift();
      break;
    case "checkpoint/rollback": {
      const idx = state.execution.rollbackPoints.findIndex(c => c.id === command.payload.checkpointId);
      if (idx >= 0) state.execution.rollbackPoints = state.execution.rollbackPoints.slice(0, idx);
      break;
    }

    // === 记忆 ===
    case "belief/add":
      state.memory.beliefs.push(command.payload.belief);
      break;
    case "belief/update": {
      const belief = state.memory.beliefs.find(b => b.id === command.payload.beliefId);
      if (belief) Object.assign(belief, command.payload.updates);
      break;
    }
    case "belief/remove":
      state.memory.beliefs = state.memory.beliefs.filter(b => b.id !== command.payload.beliefId);
      break;
    case "knowledge/add":
      state.memory.knowledge.push(command.payload.entry);
      break;
    case "knowledge/remove":
      state.memory.knowledge = state.memory.knowledge.filter(k => k.id !== command.payload.entryId);
      break;
    case "riverbed/update":
      state.memory.riverbed[command.payload.domain] = {
        ...state.memory.riverbed[command.payload.domain],
        ...command.payload.updates as Record<string, unknown>,
      };
      break;

    // === 用户镜像 ===
    case "mirror/insight-add":
      state.userMirror.insights.push(command.payload.insight);
      break;
    case "mirror/insight-update": {
      const insight = state.userMirror.insights.find(i => i.id === command.payload.insightId);
      if (insight) Object.assign(insight, command.payload.updates);
      break;
    }
    case "mirror/prediction-add":
      state.userMirror.shadowPredictions.push(command.payload.prediction);
      break;
    case "mirror/prediction-settle": {
      const pred = state.userMirror.shadowPredictions.find((p: any) => p.id === command.payload.predictionId);
      if (pred) (pred as any).settled = command.payload.outcome;
      break;
    }
    case "mirror/drift-signal":
      state.userMirror.driftSignals.push(command.payload.signal);
      if (state.userMirror.driftSignals.length > 50) state.userMirror.driftSignals.shift();
      break;

    // === 进化 ===
    case "evolution/capability-add":
      state.evolution.capabilities.push(command.payload.capability);
      break;
    case "evolution/capability-remove":
      state.evolution.capabilities = state.evolution.capabilities.filter(c => c.name !== command.payload.name);
      break;
    case "evolution/reflection-add":
      state.evolution.reflections.push(command.payload.entry);
      if (state.evolution.reflections.length > 100) state.evolution.reflections.shift();
      break;
    case "evolution/task-add":
      state.evolution.verifiableTasks.push(command.payload.task);
      break;
    case "evolution/task-update": {
      const vt = state.evolution.verifiableTasks.find(t => t.id === command.payload.taskId);
      if (vt) Object.assign(vt, command.payload.updates);
      break;
    }
    case "evolution/goal-update":
      Object.assign(state.evolution.goal, command.payload.updates);
      break;
    case "evolution/velocity-snapshot":
      state.evolution.velocity = command.payload.snapshot;
      break;
    case "evolution/hook-update":
      state.evolution.selfHooks = command.payload.hook;
      break;

    // === 身份 ===
    case "identity/heartbeat":
      state.identity.lastHeartbeat = command.payload.timestamp;
      break;
    case "identity/cycle-increment":
      state.identity.cycles++;
      break;

    default:
      throw new Error(`unknown command: ${(command as any).kind}`);
  }

  return state;
}

function incrementVersion(state: AgentState): AgentState {
  state.version++;
  return state;
}

// ═══════════════════════════════════════════════════════════════════════
// Dispatch 门面（供外部模块使用的唯一写入入口）
// ═══════════════════════════════════════════════════════════════════════

export interface StateStore {
  getState(): Readonly<AgentState>;
  dispatch(command: StateCommand): ReducerResult;
  subscribe(listener: (state: AgentState, command: StateCommand) => void): () => void;
}

export function createStateStore(initialState: AgentState, _eventBus?: any): StateStore {
  let state = initialState;
  const listeners: Set<(state: AgentState, command: StateCommand) => void> = new Set();

  function getState(): Readonly<AgentState> {
    return state;
  }

  function dispatch(command: StateCommand): ReducerResult {
    const result = reduce(state, command);
    if (result.applied) {
      state = result.state;
      for (const listener of listeners) {
        try { listener(state, command); } catch { /* ignore listener errors */ }
      }
    }
    return result;
  }

  function subscribe(listener: (state: AgentState, command: StateCommand) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { getState, dispatch, subscribe };
}

// ═══════════════════════════════════════════════════════════════════════
// Aliases — index.ts 使用的名字
// ═══════════════════════════════════════════════════════════════════════

export type Command = StateCommand;
export type Store = StateStore;
export const createStore = createStateStore;

// ═══════════════════════════════════════════════════════════════════════
// Selectors — 只读投影，无副作用
// ═══════════════════════════════════════════════════════════════════════

export function selectGoalGap(store: StateStore): number {
  const s = store.getState();
  const goal = s.evolution.goal;
  const achieved = goal.dimensions.filter(d => d.current >= d.target).length;
  return 1 - achieved / Math.max(1, goal.dimensions.length);
}

export function selectActiveBeliefs(store: StateStore) {
  return store.getState().memory.beliefs.filter(b => b.confidence > 0.3);
}

export function selectOpenPredictions(store: StateStore) {
  return store.getState().userMirror.shadowPredictions.filter((p: any) => !p.settled);
}

export function selectOpenVerifiableTasks(store: StateStore) {
  return store.getState().evolution.verifiableTasks.filter(t => t.status === "open");
}

export function selectPredictionHitRate(store: StateStore): number {
  const preds = store.getState().userMirror.shadowPredictions as any[];
  const settled = preds.filter(p => p.settled !== undefined);
  if (!settled.length) return 0;
  return settled.filter(p => p.settled === true).length / settled.length;
}

export function selectBudgetUtilization(store: StateStore): number {
  const b = store.getState().budget;
  if (!b || b.remoteLlm.limitPerHour === 0) return 0;
  return b.remoteLlm.usedTokens / b.remoteLlm.limitPerHour;
}

export function selectEvolutionVelocity(store: StateStore) {
  return store.getState().evolution.velocity ?? { capabilitiesPerWeek: 0, reflectionsPerDay: 0 };
}

export function selectUserMirrorAccuracy(store: StateStore): number {
  return store.getState().userMirror.mirrorAccuracy ?? 0;
}

export function selectUnresolvedDrifts(store: StateStore) {
  return store.getState().userMirror.driftSignals.filter((d: any) => !d.resolved);
}

export function selectActiveSensors(store: StateStore) {
  return store.getState().evolution.sensors.filter(s => !s.dormant);
}
