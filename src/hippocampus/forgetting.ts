/**
 * 遗忘曲线 — 基于艾宾浩斯模型的记忆留存率计算
 *
 * 核心公式：R = e^(-t/S)
 * - R: 留存率 (0~1)
 * - t: 自上次访问以来的 cycle 数
 * - S: 记忆强度（由重复访问次数、情绪权重、来源权重综合决定）
 *
 * 记忆强度 S 随以下因素增长：
 * - 重复检索次数 (spacing effect)
 * - 情绪关联度（高情绪 → 更耐久）
 * - 来源权重（用户直说 > 推断）
 */

import type { Episode, Concept, EpisodeSource } from "./types.js";

// ─── 参数 ──────────────────────────────────────────────────────

/** 来源对记忆强度的贡献 */
const SOURCE_DURABILITY: Record<EpisodeSource, number> = {
  "user-said":       1.0,
  "user-emotion":    1.2,  // 情绪记忆更耐久
  "observed-action": 0.7,
  "inferred":        0.4,
  "runtime":         0.2,
};

/** 基础记忆强度（第一次编码后 S 的初始值）*/
const BASE_STRENGTH = 20;

/** 每次成功检索对强度的增益（间隔重复效应）*/
const ACCESS_STRENGTH_GAIN = 8;

/** 情绪词典 — 出现这些词的记忆获得额外情绪加权 */
const EMOTION_KEYWORDS = new Set([
  // 积极
  "开心", "感谢", "喜欢", "爱", "兴奋", "期待", "幸福", "满足",
  "happy", "love", "excited", "grateful", "amazing",
  // 消极
  "难过", "生气", "害怕", "担心", "焦虑", "失望", "痛苦", "压力",
  "sad", "angry", "afraid", "worried", "anxious", "stressed",
  // 重要时刻
  "第一次", "最后", "永远", "再也不", "答应", "承诺",
  "first", "last", "never", "always", "promise",
]);

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 计算记忆强度 S（决定遗忘速率）
 */
export function memoryStrength(entry: Episode | Concept): number {
  const sourceFactor = entry.type === "episodic"
    ? SOURCE_DURABILITY[(entry as Episode).source] ?? 0.5
    : 0.8; // 语义记忆天然比情景更稳定

  const spacingBonus = Math.min(entry.accessCount * ACCESS_STRENGTH_GAIN, 80);
  const emotionBonus = hasEmotionContent(entry.content) ? 15 : 0;

  return BASE_STRENGTH * sourceFactor + spacingBonus + emotionBonus;
}

/**
 * 计算记忆留存率 R ∈ (0, 1]
 *
 * R = e^(-t/S)
 * t = currentCycle - lastAccessedCycle
 */
export function retentionRate(entry: Episode | Concept, currentCycle: number): number {
  const t = Math.max(0, currentCycle - entry.lastAccessedCycle);
  if (t === 0) return 1.0;

  const S = memoryStrength(entry);
  const R = Math.exp(-t / S);
  return Math.max(0, Math.min(1, R));
}

/**
 * 判断一条记忆是否应该被遗忘
 *
 * 策略：留存率 < forgettingThreshold 且没有保护标记
 */
export function shouldForget(
  entry: Episode | Concept,
  currentCycle: number,
  forgettingThreshold: number = 0.1
): boolean {
  // 高重要性记忆永不自动遗忘
  if (entry.importance >= 0.8) return false;

  // 最近 10 个 cycle 内创建的不遗忘（编码保护期）
  if (currentCycle - entry.createdCycle < 10) return false;

  const R = retentionRate(entry, currentCycle);
  return R < forgettingThreshold;
}

/**
 * 批量遗忘 — 返回被遗忘的条目数量
 * 副作用：直接修改 memory 数组
 */
export function applyForgetting(
  episodes: Episode[],
  concepts: Concept[],
  currentCycle: number,
  threshold: number = 0.1
): { forgottenEpisodes: number; forgottenConcepts: number } {
  const epBefore = episodes.length;
  const filteredEp = episodes.filter(ep => !shouldForget(ep, currentCycle, threshold));
  episodes.length = 0;
  episodes.push(...filteredEp);

  const cBefore = concepts.length;
  const filteredC = concepts.filter(c => !shouldForget(c, currentCycle, threshold));
  concepts.length = 0;
  concepts.push(...filteredC);

  return {
    forgottenEpisodes: epBefore - filteredEp.length,
    forgottenConcepts: cBefore - filteredC.length,
  };
}

/**
 * 强化一条记忆 — 模拟"重新编码"效果
 * 间隔重复：每次检索后 S 增长，遗忘速率降低
 */
export function reinforceMemory(entry: Episode | Concept, currentCycle: number): void {
  entry.accessCount++;
  entry.lastAccessedCycle = currentCycle;
  // 每次强化稍微提升 importance（上限 0.95）
  entry.importance = Math.min(0.95, entry.importance + 0.02);
}

/**
 * 弱化一条记忆 — 模拟"干扰"效果
 */
export function weakenMemory(entry: Episode | Concept, factor: number = 0.9): void {
  entry.importance *= factor;
}

// ─── 工作记忆容量 ─────────────────────────────────────────────

/** Miller's Law: 7±2，我们取 7 */
const WORKING_MEMORY_CAPACITY = 7;

/**
 * 工作记忆溢出淘汰 — 只保留最相关的 N 条
 * 输入已经按相关性排序的候选列表
 */
export function applyWorkingMemoryLimit<T>(
  items: T[],
  capacity: number = WORKING_MEMORY_CAPACITY
): T[] {
  return items.slice(0, capacity);
}

// ─── 内部辅助 ─────────────────────────────────────────────────

function hasEmotionContent(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of EMOTION_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}
