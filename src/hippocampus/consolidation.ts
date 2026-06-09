/**
 * 记忆巩固（Consolidation）— 海马体的"睡眠整理"
 *
 * 做五件事：去重、衰减、提炼、归档、淘汰
 * 最多 1 次 LLM 调用（提炼），失败时跳过该步骤。
 */

import type {
  LayeredMemory,
  Episode,
  Concept,
  ConsolidationReport,
} from "./types.js";
import type { LLM_Provider, LlmRequest } from "../llm/llmProvider.js";
import { scoreImportance } from "./scoring.js";
import { applyForgetting } from "./forgetting.js";

// ─── 配置 ──────────────────────────────────────────────────────

const MAX_EPISODIC = 500;
const MAX_SEMANTIC = 200;
const DECAY_THRESHOLD_CYCLES = 50;   // 超过此 cycle 未被访问 → 衰减
const DECAY_FACTOR = 0.85;
const PRUNE_THRESHOLD = 0.05;        // importance < 此值 → 淘汰
const CONSOLIDATION_BATCH = 10;      // 一次提炼最多处理的 episodes

// ─── 巩固主函数 ─────────────────────────────────────────────────

export async function consolidateMemory(
  memory: LayeredMemory,
  currentCycle: number,
  llm?: LLM_Provider
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    deduped: 0,
    decayed: 0,
    conceptsCreated: 0,
    episodesArchived: 0,
    pruned: 0,
    forgotten: 0,
  };

  // Step 1: 去重
  report.deduped = deduplicateEpisodes(memory);

  // Step 2: 遗忘曲线淘汰（在衰减之前执行，让已经"想不起来"的记忆先走）
  const { forgottenEpisodes, forgottenConcepts } = applyForgetting(
    memory.episodic,
    memory.semantic,
    currentCycle,
    0.08 // 留存率 < 8% 则遗忘
  );
  report.forgotten = forgottenEpisodes + forgottenConcepts;

  // Step 3: 衰减（对留下来的记忆做 importance 衰减）
  report.decayed = decayStaleEntries(memory, currentCycle);

  // Step 4: 提炼（需要 LLM，失败时 graceful 跳过）
  if (llm) {
    try {
      report.conceptsCreated = await distillConcepts(memory, currentCycle, llm);
    } catch (e) {
      // 提炼失败不影响其他步骤
      console.log("[consolidation] distill failed, skipping:", (e as Error).message);
    }
  }

  // Step 5: 淘汰（硬上限）
  report.pruned = pruneMemory(memory);

  // 更新 meta
  memory.meta.lastConsolidationCycle = currentCycle;
  memory.meta.prunedCount += report.forgotten;

  return report;
}

// ─── Step 1: 去重 ───────────────────────────────────────────────

function deduplicateEpisodes(memory: LayeredMemory): number {
  const seen = new Map<string, number>(); // key → index of best
  const toRemove = new Set<number>();
  let count = 0;

  for (let i = 0; i < memory.episodic.length; i++) {
    const ep = memory.episodic[i];
    // 防御：坏数据（content 缺失/非字符串）跳过，不让一条脏记忆崩掉整次巩固。
    if (!ep || typeof ep.content !== "string") continue;
    // 用前 60 字符 + source 作为去重 key
    const key = `${ep.content.slice(0, 60)}||${ep.source}`;

    if (seen.has(key)) {
      const existingIdx = seen.get(key)!;
      const existing = memory.episodic[existingIdx];
      // 保留 importance 更高的
      if (ep.importance > existing.importance) {
        toRemove.add(existingIdx);
        seen.set(key, i);
      } else {
        toRemove.add(i);
      }
      count++;
    } else {
      seen.set(key, i);
    }
  }

  if (toRemove.size > 0) {
    memory.episodic = memory.episodic.filter((_, i) => !toRemove.has(i));
  }
  return count;
}

// ─── Step 2: 衰减 ───────────────────────────────────────────────

function decayStaleEntries(memory: LayeredMemory, currentCycle: number): number {
  let count = 0;

  for (const ep of memory.episodic) {
    const cyclesSinceAccess = currentCycle - ep.lastAccessedCycle;
    if (cyclesSinceAccess > DECAY_THRESHOLD_CYCLES) {
      ep.importance *= DECAY_FACTOR;
      count++;
    }
  }

  for (const concept of memory.semantic) {
    const cyclesSinceAccess = currentCycle - concept.lastAccessedCycle;
    if (cyclesSinceAccess > DECAY_THRESHOLD_CYCLES) {
      concept.importance *= DECAY_FACTOR;
      count++;
    }
  }

  return count;
}

// ─── Step 3: 提炼 ───────────────────────────────────────────────

async function distillConcepts(
  memory: LayeredMemory,
  currentCycle: number,
  llm: LLM_Provider
): Promise<number> {
  // 找同 dimension 的低重要性未提炼 episodes
  const lowImportance = memory.episodic
    .filter(ep => !ep.consolidated && ep.importance < 0.4)
    .slice(0, CONSOLIDATION_BATCH);

  if (lowImportance.length < 3) return 0; // 不够数不提炼

  const episodeTexts = lowImportance.map(ep => `- ${ep.content}`).join("\n");

  const req: LlmRequest = {
    system: "你是一个记忆整理助手。把多条具体事件归纳为1-2条高层概念（每条不超过50字）。只输出概念，每行一条。",
    messages: [
      {
        role: "user",
        content: `请将以下事件记忆提炼为概念：\n${episodeTexts}`,
      },
    ],
    temperature: 0.3,
  };

  const resp = await llm.complete(req);
  const lines = resp.text
    .split("\n")
    .map(l => l.replace(/^[-•*]\s*/, "").trim())
    .filter(l => l.length > 0 && l.length <= 100);

  if (lines.length === 0) return 0;

  let created = 0;
  for (const line of lines.slice(0, 2)) {
    const concept: Concept = {
      id: `concept_${Date.now()}_${created}`,
      type: "semantic",
      content: line,
      importance: 0.6,
      accessCount: 0,
      lastAccessedCycle: currentCycle,
      createdCycle: currentCycle,
      createdAt: new Date().toISOString(),
      sourceEpisodeIds: lowImportance.map(ep => ep.id),
    };
    memory.semantic.push(concept);
    memory.meta.totalConceptsCreated++;
    created++;
  }

  // 标记已提炼
  for (const ep of lowImportance) {
    ep.consolidated = true;
  }

  return created;
}

// ─── Step 5: 淘汰 ───────────────────────────────────────────────

function pruneMemory(memory: LayeredMemory): number {
  let pruned = 0;

  // 淘汰 importance < 阈值的 episodic
  const beforeEp = memory.episodic.length;
  memory.episodic = memory.episodic.filter(ep => ep.importance >= PRUNE_THRESHOLD);
  pruned += beforeEp - memory.episodic.length;

  // 淘汰 importance < 阈值的 semantic
  const beforeSem = memory.semantic.length;
  memory.semantic = memory.semantic.filter(c => c.importance >= PRUNE_THRESHOLD);
  pruned += beforeSem - memory.semantic.length;

  // 超出容量上限时，按 importance 排序淘汰末尾
  if (memory.episodic.length > MAX_EPISODIC) {
    memory.episodic.sort((a, b) => b.importance - a.importance);
    const overflow = memory.episodic.length - MAX_EPISODIC;
    memory.episodic = memory.episodic.slice(0, MAX_EPISODIC);
    pruned += overflow;
  }

  if (memory.semantic.length > MAX_SEMANTIC) {
    memory.semantic.sort((a, b) => b.importance - a.importance);
    const overflow = memory.semantic.length - MAX_SEMANTIC;
    memory.semantic = memory.semantic.slice(0, MAX_SEMANTIC);
    pruned += overflow;
  }

  memory.meta.prunedCount += pruned;
  return pruned;
}

// ─── 辅助：从对话创建 Episode ────────────────────────────────────

/**
 * 将一条用户对话转为 Episode（供外部在合适时机调用）
 */
export function conversationToEpisode(
  text: string,
  currentCycle: number,
  source: "user-said" | "user-emotion" = "user-said"
): Episode {
  return {
    id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "episodic",
    content: text.slice(0, 200), // 限长
    source,
    importance: scoreImportance({
      source,
      createdCycle: currentCycle,
      accessCount: 0,
      currentCycle,
    }),
    accessCount: 0,
    lastAccessedCycle: currentCycle,
    createdCycle: currentCycle,
    createdAt: new Date().toISOString(),
  };
}
