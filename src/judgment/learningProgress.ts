/**
 * 学习进度引擎（纯函数核心）—— 飞轮的「方向盘」。
 *
 * ─── 第一性原理（联网核实：IMGEP/自动课程 arxiv 1708.02190、ProCuRL ZPD、
 *      MAGELLAN 学习进度元认知）───
 * 真正能自驱进化的体，不追新颖、不追难度，而追**学习进度（Learning Progress, LP）**最大的
 * 方向——「我在这件事上正在快速变强」的那个甜区（ZPD 最近发展区，太难太易都不学）。
 *
 * 本模块不重造度量，而是把已有两把尺子**组合**成 LP：
 *  - 新颖度（novelty.ts）：这件事在不在新疆域。
 *  - 可学习性（selfModel.ts 的 learnabilityScore）：胜任度是否落在踮脚够得着的甜区。
 *  - 经验性 LP（competence 历史变化率）：最近这条线上的胜任度是否真在上升。
 *
 * LP 高的方向 = 既新、又够得着、且最近真的在涨——这正是「学习进度最大」的甜区。
 * 飞轮据此选题：reflect 用它定纠偏方向、goalMonitor 用它定最大 LP 维度、consciousness
 * 用它提示「下一个该学什么」。
 *
 * 纯函数（无副作用、无 I/O、不依赖时钟），便于 property 测试证明尺子正确。
 */

import { clamp01 } from "./calibration.js";
import { learnabilityScore } from "./selfModel.js";

/** 一个候选学习方向的输入信号。 */
export interface LearningCandidate {
  /** 候选标识。 */
  id: string;
  /** 候选的文本描述（用于新颖度评估，由调用方在外部算好后传入 novelty）。 */
  novelty: number;
  /** 对该方向（已偏差校正的）胜任度估计 0-1。 */
  competence: number;
  /**
   * 经验学习进度 0-1（可选）：该方向最近的胜任度变化率（这条线上是否真在快速变强）。
   * 缺省按 0 处理（无历史则只靠 novelty × learnability）。
   */
  empiricalLP?: number;
}

/** LP 各分量的默认权重。novelty 与 learnability 是先验，empiricalLP 是后验（最强信号）。 */
export const LP_WEIGHTS = {
  novelty: 0.3,
  learnability: 0.3,
  empirical: 0.4,
} as const;

/**
 * 学习进度分（0-1）：把新颖度、可学习性(ZPD)、经验 LP 三路信号融成一个标量。
 *
 * `LP = w_n·novelty + w_l·learnability(competence) + w_e·empiricalLP`。
 * 三者皆高 → 既新、又踮脚够得着、且真在涨 → LP 最高 → 最该投入的甜区。
 *
 * @param c 候选信号。
 * @returns LP 0-1。
 */
export function learningProgress(c: LearningCandidate): number {
  const nov = clamp01(c.novelty);
  const learn = learnabilityScore(clamp01(c.competence)); // 0.5 胜任度处取峰
  const emp = clamp01(c.empiricalLP ?? 0);
  const lp =
    LP_WEIGHTS.novelty * nov +
    LP_WEIGHTS.learnability * learn +
    LP_WEIGHTS.empirical * emp;
  return +clamp01(lp).toFixed(4);
}

/**
 * 经验学习进度：从一条方向上「按时间排序的胜任度成功序列」估计它最近是否在变强。
 *
 * 用「后半段成功率 − 前半段成功率」的正向部分（只奖励上升，退步不算负 LP——退步该走别的信号）。
 * 这是 IMGEP/Oudeyer 的经典 LP 定义的离散化：LP = 近期能力 − 早期能力。
 *
 * @param outcomes 按时间排序的结果序列（true=成功）。
 * @returns 经验 LP 0-1（上升幅度；无上升或样本不足返回 0）。
 */
export function empiricalLearningProgress(outcomes: readonly boolean[]): number {
  if (outcomes.length < 2) return 0;
  const mid = Math.floor(outcomes.length / 2);
  const early = outcomes.slice(0, mid);
  const recent = outcomes.slice(mid);
  if (early.length === 0 || recent.length === 0) return 0;
  const rate = (xs: readonly boolean[]) => xs.filter(Boolean).length / xs.length;
  const delta = rate(recent) - rate(early);
  return +clamp01(delta).toFixed(4); // 只取正向上升
}

/**
 * 从候选集里挑「学习进度最大」的方向（自动课程的选题核心）。
 *
 * @param candidates 候选方向。
 * @returns 最高 LP 的候选及其 LP；空集返回 null。
 */
export function pickHighestLP<T extends LearningCandidate>(
  candidates: readonly T[],
): { candidate: T; lp: number } | null {
  let best: { candidate: T; lp: number } | null = null;
  for (const c of candidates) {
    const lp = learningProgress(c);
    if (best === null || lp > best.lp) best = { candidate: c, lp };
  }
  return best;
}

/**
 * 停滞检测：一组方向的 LP 是否全部低迷（都低于阈值），意味着当前疆域已榨干、该开新疆域。
 *
 * 这是飞轮「不收敛」的守门：当所有够得着的方向 LP 都枯竭，信号是「跳出去探索全新领域」。
 *
 * @param candidates 候选方向。
 * @param threshold LP 低迷阈值，默认 0.25。
 * @returns true=全部低迷（该跳新疆域）。
 */
export function isStagnant(
  candidates: readonly LearningCandidate[],
  threshold = 0.25,
): boolean {
  if (candidates.length === 0) return true;
  return candidates.every((c) => learningProgress(c) < threshold);
}
