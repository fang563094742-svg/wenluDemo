/**
 * 海马体模块导出聚合
 */

export type {
  ScoredEntry,
  Episode,
  EpisodeSource,
  Concept,
  LayeredMemory,
  WorkingMemory,
  MemoryMeta,
  InteractionState,
  PendingDelivery,
  PrefrontalAction,
  PrefrontalDecision,
  ConsolidationReport,
} from "./types.js";

export { scoreImportance, mapKnowledgeSource, mapBeliefSource } from "./scoring.js";
export { retrieveRelevant, buildContextQuery } from "./retrieval.js";
export type { RetrievalOptions } from "./retrieval.js";
export { consolidateMemory, conversationToEpisode } from "./consolidation.js";
export { migrateToLayered, needsMigration } from "./migration.js";
export {
  retentionRate,
  memoryStrength,
  shouldForget,
  applyForgetting,
  reinforceMemory,
  weakenMemory,
  applyWorkingMemoryLimit,
} from "./forgetting.js";
