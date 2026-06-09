/**
 * BM25 + 遗忘曲线 综合检索 — 从分层记忆中按相关性浮现条目
 *
 * 综合得分 = bm25 * 0.4 + retention * 0.25 + importance * 0.2 + recency * 0.15
 * - retention: 艾宾浩斯留存率，模拟记忆是否还"记得住"
 */

import type { Episode, Concept, LayeredMemory } from "./types.js";
import { retentionRate, applyWorkingMemoryLimit, reinforceMemory } from "./forgetting.js";

// ─── 停用词（中文 + 英文高频虚词）────────────────────────────

const STOP_WORDS = new Set([
  // 中文
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
  "它", "们", "那", "被", "从", "把", "让", "用", "而", "可以",
  "什么", "如果", "但是", "因为", "所以", "还是", "或者", "这个",
  // 英文
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "and", "or", "but", "if", "not", "no", "this", "that", "it",
]);

// ─── 分词 ──────────────────────────────────────────────────────

/**
 * 简易分词：按空格/标点切分，过滤停用词和短词
 */
function tokenize(text: string): string[] {
  // 防御：content 缺失/非字符串（如早期迁移生成的空概念）不崩，按空文档处理。
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[\s,.\-;:!?|/\\()\[\]{}"""''、，。！？；：（）【】\n\t]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ─── BM25 核心 ─────────────────────────────────────────────────

interface ScoredResult {
  entry: Episode | Concept;
  score: number;
}

export interface RetrievalOptions {
  topK?: number;
  currentCycle?: number;
  /** 是否应用工作记忆容量限制（Miller's Law 7±2）*/
  applyCapacityLimit?: boolean;
  /** 最低留存率阈值 — 低于此值的记忆不进入候选池 */
  minRetention?: number;
}

/**
 * 从分层记忆中按相关性检索 top-K 条目
 *
 * 综合得分 = bm25 * 0.4 + retention * 0.25 + importance * 0.2 + recency * 0.15
 *
 * 新增机制：
 * 1. 遗忘曲线过滤 — 留存率过低的记忆不进入候选池
 * 2. 间隔重复强化 — 命中条目的记忆强度增长
 * 3. 工作记忆容量 — 最终输出受 7±2 限制
 */
export function retrieveRelevant(
  query: string,
  memory: LayeredMemory,
  topKOrOpts: number | RetrievalOptions = 10,
  currentCycle: number = 0
): Array<Episode | Concept> {
  // 兼容旧调用方式
  const opts: RetrievalOptions = typeof topKOrOpts === "number"
    ? { topK: topKOrOpts, currentCycle }
    : topKOrOpts;
  const topK = opts.topK ?? 10;
  const cycle = opts.currentCycle ?? currentCycle;
  const minRetention = opts.minRetention ?? 0.05;
  const applyCapacity = opts.applyCapacityLimit ?? true;

  if (!query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // 合并 episodic + semantic 为候选池，过滤留存率过低的记忆
  const allCandidates: Array<Episode | Concept> = [
    ...memory.episodic,
    ...memory.semantic,
  ];

  // 遗忘曲线过滤：留存率低于阈值的记忆视为"想不起来"
  const candidates = allCandidates.filter(
    entry => retentionRate(entry, cycle) >= minRetention
  );

  if (candidates.length === 0) return [];

  const N = candidates.length;

  // 计算 IDF：每个 query token 在多少文档中出现
  const docFreq = new Map<string, number>();
  const tokenizedDocs: string[][] = candidates.map(c => tokenize(c.content));

  for (const token of queryTokens) {
    let df = 0;
    for (const doc of tokenizedDocs) {
      if (doc.includes(token)) df++;
    }
    docFreq.set(token, df);
  }

  // BM25 参数
  const k1 = 1.5;
  const b = 0.75;
  const avgDl = tokenizedDocs.reduce((sum, d) => sum + d.length, 0) / N;

  // 对每个候选计算综合得分
  const scored: ScoredResult[] = candidates.map((entry, idx) => {
    const doc = tokenizedDocs[idx];
    const dl = doc.length;

    // BM25 得分
    let bm25 = 0;
    for (const token of queryTokens) {
      const df = docFreq.get(token) || 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const tf = doc.filter(t => t === token).length;
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl));
      bm25 += idf * tfNorm;
    }

    // 归一化 bm25 到 [0,1] 范围（近似）
    const bm25Norm = Math.min(bm25 / (queryTokens.length * 3), 1);

    // 遗忘曲线留存率
    const retention = retentionRate(entry, cycle);

    // 时间衰减（创建时间）
    const age = Math.max(0, cycle - entry.createdCycle);
    const recency = 1 / (1 + age / 100);

    // 综合得分（四维加权）
    const score =
      bm25Norm * 0.4 +
      retention * 0.25 +
      entry.importance * 0.2 +
      recency * 0.15;

    return { entry, score };
  });

  // 排序取 top-K
  scored.sort((a, b) => b.score - a.score);
  let results = scored.slice(0, topK);

  // 工作记忆容量限制
  if (applyCapacity) {
    results = applyWorkingMemoryLimit(results);
  }

  // 副作用：间隔重复强化（模拟"回想成功"增强记忆）
  for (const { entry } of results) {
    reinforceMemory(entry, cycle);
  }

  return results.map(r => r.entry);
}

/**
 * 从当前上下文构建检索 query
 * 合并最近对话 + 当前运行任务目标
 */
export function buildContextQuery(
  recentConversation: Array<{ text: string }>,
  runningTaskGoals: string[]
): string {
  const parts: string[] = [];
  // 最近 3 条对话
  for (const msg of recentConversation.slice(-3)) {
    parts.push(msg.text);
  }
  // 运行中任务
  for (const goal of runningTaskGoals) {
    parts.push(goal);
  }
  return parts.join(" ");
}
