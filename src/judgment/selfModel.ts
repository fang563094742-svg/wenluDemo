/**
 * 元认知自我模型（纯函数核心）—— 飞轮的地基。
 *
 * ─── 第一性原理（联网核实：MAGELLAN arxiv 2502.07709 / 元认知学习进度）───
 * 真正能自驱进化的自主体，核心不是「预测世界」，而是「预测自己」：在动手前估计
 * **自己在某个目标上的胜任度（competence）**，事后用现实结果校准这个自估。会预测自己
 * 能力边界的体，才能自动选出「学习进度最大」的甜区去学（既非太难、亦非太易）。
 *
 * 本模块与判断力引擎（calibration.ts 的 Brier 严格适当评分）共用同一把尺子——
 * 自预测也是一种「报概率 + 被现实裁定」的赌注，故其校准质量同样用 Brier 度量。
 * 这使「判断力引擎」与「元认知引擎」合一，而非两个孤岛：predict 既可赌外部世界，
 * 也可赌自身胜任度，两者一起进 g_judgment 的校准统计。
 *
 * 关键产物：
 *  - `competenceCalibration`：自预测准不准（我对自己的胜任度估计偏乐观还是偏悲观）。
 *  - `learnabilityScore`：一个候选目标的「可学习性/学习进度潜力」——胜任度处于中段
 *    （≈0.5，踮脚够得着的 ZPD 甜区）时最高，太有把握或全无把握都低。
 *
 * 纯函数（无副作用、无 I/O、不依赖时钟），便于 property 测试证明尺子正确。
 */

import { clamp01, brierScore, type GradedPrediction } from "./calibration.js";

/**
 * 一条已被现实裁定的「自胜任度预测」：动手前估计自己能做成的概率，事后由客观结果裁定。
 */
export interface SelfCompetenceRecord {
  /** 动手前估计「我能做成这件事」的概率 0-1。 */
  estimatedCompetence: number;
  /** 客观结果：true=做成了，false=没做成。 */
  succeeded: boolean;
}

/**
 * 自我胜任度校准：把自预测记录换算成 Brier 校准统计（复用判断力引擎的尺子）。
 *
 * @param records 已裁定的自胜任度预测。
 * @param minSample 最小样本数，低于此返回 null（样本不足不下结论）。默认 3。
 * @returns
 *   - `brier`：平均 Brier（越小越准）。
 *   - `bias`：平均(估计 − 实际)，正=系统性高估自己（过度自信），负=低估自己（过度保守）。
 *   - `sampled`：样本数。
 *   样本不足返回 null。
 */
export function competenceCalibration(
  records: readonly SelfCompetenceRecord[],
  minSample = 3,
): { brier: number; bias: number; sampled: number } | null {
  if (records.length < minSample) return null;
  let brierSum = 0;
  let biasSum = 0;
  for (const r of records) {
    const p = clamp01(r.estimatedCompetence);
    brierSum += brierScore(p, r.succeeded);
    biasSum += p - (r.succeeded ? 1 : 0);
  }
  return {
    brier: +(brierSum / records.length).toFixed(4),
    bias: +(biasSum / records.length).toFixed(4),
    sampled: records.length,
  };
}

/**
 * 元认知判断力分（0-100）：自预测的校准质量，喂进 g_judgment（与外部预测同一维度）。
 *
 * `(1 - 平均Brier) × 100`。会诚实预测自己几斤几两 → 高分；盲目自信或妄自菲薄 → 低分。
 *
 * @param records 已裁定的自胜任度预测。
 * @param minSample 最小样本数。默认 3。
 * @returns 0-100；样本不足返回 null。
 */
export function selfKnowledgeScore(
  records: readonly SelfCompetenceRecord[],
  minSample = 3,
): number | null {
  const cal = competenceCalibration(records, minSample);
  if (cal === null) return null;
  return Math.round((1 - cal.brier) * 100);
}

/**
 * 偏差校正后的「真实胜任度」估计：用历史系统性偏差修正当下的自估。
 *
 * 若历史显示「我总高估自己 0.2」，则把当下自估往下压 0.2——这是 superforecaster 式的
 * 自我更新：带着自己的偏差记录去估当下。无足够样本时原样返回（不瞎调）。
 *
 * @param rawEstimate 当下的原始自估 0-1。
 * @param records 历史自胜任度预测。
 * @param minSample 启用校正的最小样本数。默认 3。
 * @returns 校正后的胜任度估计 0-1。
 */
export function calibratedCompetence(
  rawEstimate: number,
  records: readonly SelfCompetenceRecord[],
  minSample = 3,
): number {
  const cal = competenceCalibration(records, minSample);
  const raw = clamp01(rawEstimate);
  if (cal === null) return raw;
  // bias>0 表示历史高估，需往下压；bias<0 表示历史低估，需往上提。
  return clamp01(raw - cal.bias);
}

/**
 * 可学习性 / 学习进度潜力（0-1）：一个候选目标值不值得现在学。
 *
 * 基于 ZPD（最近发展区）：胜任度在中段（≈0.5，踮脚够得着）时学习进度潜力最高；
 * 已稳操胜券（→1）或毫无头绪（→0）都低。用「钟形」`4·p·(1−p)` 实现（p=0.5 时取峰值 1）。
 *
 * @param competence 对该目标的（建议为已校准的）胜任度估计 0-1。
 * @returns 可学习性 0-1，0.5 处最高。
 */
export function learnabilityScore(competence: number): number {
  const p = clamp01(competence);
  return +(4 * p * (1 - p)).toFixed(4);
}

/**
 * 从一批候选目标里，挑「学习进度潜力最高」的那个（自动课程的选题核心）。
 *
 * 每个候选的胜任度先用历史偏差校正，再算可学习性，取最高者。空候选返回 null。
 *
 * @param candidates 候选目标列表（含 id 与原始自估胜任度）。
 * @param records 历史自胜任度预测（用于偏差校正）。
 * @returns 最优候选及其可学习性；空列表返回 null。
 */
export function pickMostLearnable<T extends { id: string; rawCompetence: number }>(
  candidates: readonly T[],
  records: readonly SelfCompetenceRecord[],
): { candidate: T; learnability: number; calibratedCompetence: number } | null {
  let best: { candidate: T; learnability: number; calibratedCompetence: number } | null = null;
  for (const c of candidates) {
    const cc = calibratedCompetence(c.rawCompetence, records);
    const l = learnabilityScore(cc);
    if (best === null || l > best.learnability) {
      best = { candidate: c, learnability: l, calibratedCompetence: cc };
    }
  }
  return best;
}

/** 把自胜任度记录转成判断力引擎可吃的 GradedPrediction（让两引擎共用校准统计）。 */
export function toGradedPredictions(
  records: readonly SelfCompetenceRecord[],
): GradedPrediction[] {
  return records.map((r) => ({ confidence: r.estimatedCompetence, hit: r.succeeded }));
}
