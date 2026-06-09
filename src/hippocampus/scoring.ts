/**
 * 重要性评分 — 纯函数，决定一条记忆"值多少"
 */

import type { EpisodeSource } from "./types.js";

/** 来源权重：用户直说 > 情绪 > 观察 > 推断 > 运行日志 */
const SOURCE_WEIGHTS: Record<EpisodeSource, number> = {
  "user-said": 1.0,
  "user-emotion": 0.9,
  "observed-action": 0.7,
  "inferred": 0.5,
  "runtime": 0.3,
};

export interface ScoreInput {
  source: EpisodeSource;
  createdCycle: number;
  accessCount: number;
  currentCycle: number;
}

/**
 * 计算记忆条目的综合重要性得分 [0, 1]
 *
 * 公式：base * 0.6 + recency * 0.25 + access * 0.15
 * - base: 来源权重
 * - recency: 时间衰减 1/(1 + age/50)
 * - access: 被检索次数加成，上限 0.3
 */
export function scoreImportance(input: ScoreInput): number {
  const base = SOURCE_WEIGHTS[input.source] ?? 0.5;
  const age = Math.max(0, input.currentCycle - input.createdCycle);
  const recency = 1 / (1 + age / 50);
  const access = Math.min(input.accessCount * 0.05, 0.3);

  const raw = base * 0.6 + recency * 0.25 + access * 0.15;
  return Math.max(0, Math.min(1, raw));
}

/**
 * 将旧 knowledge source 映射到 EpisodeSource
 */
export function mapKnowledgeSource(
  source: string
): EpisodeSource {
  switch (source) {
    case "user-told":
      return "user-said";
    case "web-verified":
    case "file-observed":
      return "observed-action";
    case "inferred-unverified":
      return "inferred";
    default:
      return "inferred";
  }
}

/**
 * 将旧 belief source 映射到 EpisodeSource
 */
export function mapBeliefSource(
  source: string
): EpisodeSource {
  switch (source) {
    case "user-said":
      return "user-said";
    case "observed":
      return "observed-action";
    case "corrected":
      return "user-emotion";
    case "inferred":
    default:
      return "inferred";
  }
}
