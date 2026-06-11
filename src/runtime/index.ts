/**
 * index.ts — runtime 模块统一出口。
 *
 * 对外暴露：
 * - 创建统一 runtime 的工厂函数 createRuntime()
 * - 所有子模块的类型和接口
 *
 * 对内保证：
 * - agentState 只能通过 store.dispatch(Command) 写入
 * - 只读访问通过 store.getState() + selectors
 * - 跨模块通知通过 eventBus
 * - 大对象通过 artifactStore
 * - 历史流水通过 actionLedger
 * - 生命周期通过 lifecycleManager
 * - 预算门禁通过 budgetGovernor
 */

export type { AgentState, Belief, KnowledgeEntry, UserInsight, Prediction, VerifiableTask, MasteredTool, ReflectionEntry, GoalDimension, NorthStarGoal, SelfHookModule, SensorState, CapabilityMapCell, VelocitySnapshot, UserShadowPrediction, DriftSignal, GoalTension, ActiveTask, RollbackCheckpoint, BudgetState } from "./agentState.js";
export { createInitialAgentState } from "./agentState.js";

export type { AgentEvent, AgentEventKind, EventHandler, EventBus } from "./eventBus.js";
export { createEventBus, createEvent } from "./eventBus.js";

export type { Command, Store } from "./reducer.js";
export { reduce, createStore, selectGoalGap, selectActiveBeliefs, selectOpenPredictions, selectOpenVerifiableTasks, selectPredictionHitRate, selectBudgetUtilization, selectEvolutionVelocity, selectUserMirrorAccuracy, selectUnresolvedDrifts, selectActiveSensors } from "./reducer.js";

export type { LedgerEntry, LedgerSource, SideEffect, LedgerQuery, ActionLedger } from "./actionLedger.js";
export { createActionLedger, wireLedgerToEventBus } from "./actionLedger.js";

export type { ArtifactKind, ArtifactRef, ArtifactMetadata, ArtifactStore } from "./artifactStore.js";
export { createArtifactStore } from "./artifactStore.js";

export type { LifecyclePhase, LifecycleConfig, LifecycleManager } from "./lifecycle.js";
export { createLifecycleManager } from "./lifecycle.js";

export type { ResourceDimension, BudgetBucket, BudgetConfig, OperationalTier, GovernorSnapshot, DegradationSuggestion, AcquireRequest, AcquireResult, BudgetGovernor } from "./budgetGovernor.js";
export { createBudgetGovernor } from "./budgetGovernor.js";

// ═══════════════════════════════════════════════════════════════════════
// 统一 Runtime 工厂
// ═══════════════════════════════════════════════════════════════════════

import { createInitialAgentState } from "./agentState.js";
import { createEventBus } from "./eventBus.js";
import { createStore } from "./reducer.js";
import { createActionLedger, wireLedgerToEventBus } from "./actionLedger.js";
import { createArtifactStore } from "./artifactStore.js";
import { createLifecycleManager } from "./lifecycle.js";
import { createBudgetGovernor } from "./budgetGovernor.js";
import type { Store } from "./reducer.js";
import type { EventBus } from "./eventBus.js";
import type { ActionLedger } from "./actionLedger.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { LifecycleManager } from "./lifecycle.js";
import type { BudgetGovernor } from "./budgetGovernor.js";

export interface Runtime {
  store: Store;
  eventBus: EventBus;
  ledger: ActionLedger;
  artifacts: ArtifactStore;
  lifecycle: LifecycleManager;
  budget: BudgetGovernor;
  shutdown(): Promise<void>;
}

export interface RuntimeConfig {
  dataDir: string;
  breatheIntervalMs?: number;
  idleThresholdMs?: number;
}

export async function createRuntime(config: RuntimeConfig): Promise<Runtime> {
  const eventBus = createEventBus({ historyLimit: 3000 });
  const initialState = createInitialAgentState();
  const store = createStore(initialState, eventBus);
  const ledger = createActionLedger(config.dataDir);
  const artifacts = await createArtifactStore(config.dataDir);
  const budget = createBudgetGovernor();
  const lifecycle = createLifecycleManager(
    {
      dataDir: config.dataDir,
      breatheIntervalMs: config.breatheIntervalMs,
      idleThresholdMs: config.idleThresholdMs,
    },
    store,
    eventBus,
    ledger,
    artifacts,
  );

  // 自动接线：tool 事件 → ledger
  const unwireLedger = wireLedgerToEventBus(ledger, eventBus);

  async function shutdown(): Promise<void> {
    unwireLedger();
    await lifecycle.shutdown();
  }

  return { store, eventBus, ledger, artifacts, lifecycle, budget, shutdown };
}
