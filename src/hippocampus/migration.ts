/**
 * 旧 mind.json → 分层记忆迁移
 *
 * 幂等：检查 version，已迁移则跳过。
 */

import type {
  LayeredMemory,
  Episode,
  Concept,
} from "./types.js";
import {
  scoreImportance,
  mapKnowledgeSource,
  mapBeliefSource,
} from "./scoring.js";

// ─── 旧结构类型（用于读取） ─────────────────────────────────────

interface OldKnowledge {
  fact: string;
  source: string;
  confidence?: number;
  firstLearnedAt?: string;
  dimension?: string;
}

interface OldBelief {
  belief: string;
  source?: string;
  confidence?: number;
  status?: string;
  correctedBy?: string;
  dimension?: string;
  formedAt?: string;
}

interface OldTool {
  toolName: string;
  command: string;
  description: string;
}

interface OldRule {
  rule: string;
  confidence: number;
  source: string;
}

interface OldMind {
  knowledge?: OldKnowledge[];
  beliefs?: OldBelief[];
  masteredTools?: OldTool[];
  rules?: OldRule[];
  cycles?: number;
}

// ─── 迁移主函数 ─────────────────────────────────────────────────

/**
 * 从旧的 mind.json 结构迁移到分层记忆。
 * 幂等：只在 version 不存在时执行。
 */
export function migrateToLayered(mind: OldMind): LayeredMemory {
  const currentCycle = mind.cycles || 0;
  const episodic: Episode[] = [];
  const semantic: Concept[] = [];

  // 1. knowledge → episodic
  if (mind.knowledge) {
    for (const k of mind.knowledge) {
      const source = mapKnowledgeSource(k.source);
      const ep: Episode = {
        id: `ep_migrated_${episodic.length}`,
        type: "episodic",
        content: k.fact,
        source,
        dimension: k.dimension,
        importance: scoreImportance({
          source,
          createdCycle: Math.max(0, currentCycle - 100), // 估算
          accessCount: 0,
          currentCycle,
        }),
        accessCount: 0,
        lastAccessedCycle: currentCycle,
        createdCycle: Math.max(0, currentCycle - 100),
        createdAt: k.firstLearnedAt || new Date().toISOString(),
      };
      episodic.push(ep);
    }
  }

  // 2. beliefs (active, 未被推翻) → semantic
  if (mind.beliefs) {
    for (const b of mind.beliefs) {
      if (b.correctedBy) continue; // 跳过已被推翻的
      if (b.status === "retired") continue;

      mapBeliefSource(b.source || "inferred"); // side-effect: validate source
      const confidence = b.confidence ?? 0.6;

      const concept: Concept = {
        id: `concept_migrated_${semantic.length}`,
        type: "semantic",
        content: b.belief,
        dimension: b.dimension,
        importance: confidence * 0.8,
        accessCount: 0,
        lastAccessedCycle: currentCycle,
        createdCycle: Math.max(0, currentCycle - 50),
        createdAt: b.formedAt || new Date().toISOString(),
        sourceEpisodeIds: [],
      };
      semantic.push(concept);
    }
  }

  // 3. masteredTools + rules → procedural
  const tools = (mind.masteredTools || []).map(t => ({
    name: t.toolName,
    command: t.command,
    description: t.description,
  }));

  const rules = (mind.rules || []).map(r => ({
    rule: r.rule,
    confidence: r.confidence,
    source: r.source,
  }));

  const memory: LayeredMemory = {
    working: {
      currentContext: [],
      recentTopics: [],
      activeGoals: [],
    },
    episodic,
    semantic,
    procedural: { tools, rules },
    meta: {
      version: 1,
      lastConsolidationCycle: currentCycle,
      totalEpisodesCreated: episodic.length,
      totalConceptsCreated: semantic.length,
      prunedCount: 0,
    },
  };

  console.log(
    `[migration] Migrated: ${episodic.length} episodes, ` +
    `${semantic.length} concepts, ${tools.length} tools, ${rules.length} rules`
  );

  return memory;
}

/**
 * 检查 mind 是否需要迁移
 */
export function needsMigration(mind: any): boolean {
  return !mind.memory?.meta?.version;
}
