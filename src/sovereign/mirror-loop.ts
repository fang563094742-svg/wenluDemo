/**
 * 主权自体 · Component 4：镜像闭环结算（mirror-loop.ts）
 * ------------------------------------------------------------------
 * 把"我猜你/你采纳没有/你说想成为什么 vs 实际在做什么"变成可校准的精度系统。
 * 精度只由真实结算驱动（不自评），并反向改写行为 + 动态调整宪法权重。
 * _Requirements: 3.1-3.7_
 */

import { type MirrorScore } from "./types.js";

/** 把文本切成可比对的 token：英文按分隔符，中文额外加 2-gram，使中文也能做重叠判断。 */
function tokenize(text: string): string[] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return [];
  const coarse = t.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x.length >= 2);
  const grams: string[] = [];
  for (const seg of coarse) {
    if (/[\u4e00-\u9fa5]/.test(seg) && seg.length >= 2) {
      for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2)); // 中文 2-gram
    }
  }
  return [...coarse, ...grams];
}

/** 结算一条 shadowPrediction：现实(actual)是否如预测(predicted)。轻量语义近似可由调用点注入更强判定。 */
export function settleShadowPrediction(pred: { predicted: string; actual: string }): { hit: boolean } {
  const p = (pred.predicted ?? "").trim().toLowerCase();
  const a = (pred.actual ?? "").trim().toLowerCase();
  if (!p || !a) return { hit: false };
  if (p === a) return { hit: true };
  // token（含中文 2-gram）重叠近似（调用点可用 LLM 语义裁判覆盖）。
  const pt = tokenize(p);
  const hit = pt.length > 0 && pt.some((t) => a.includes(t));
  return { hit };
}

/**
 * 由命中率 + 接纳率算镜像精度。纯函数：只由 (hits/settled/accepts/suggested) 决定，
 * 无任何自由参数能凭空抬高（防自评刷分）。settled/suggested 为 0 时该维度记 0。
 */
export function computeMirrorScore(hits: number, settled: number, accepts: number, suggested: number): MirrorScore {
  const accuracy = settled > 0 ? Math.max(0, Math.min(1, hits / settled)) : 0;
  const acceptRate = suggested > 0 ? Math.max(0, Math.min(1, accepts / suggested)) : 0;
  // 综合：命中率与接纳率几何平均（任一为 0 则综合显著降低，避免单边刷高）。
  const composite = Math.sqrt(Math.max(0, accuracy) * Math.max(0, acceptRate));
  return { accuracy, acceptRate, composite };
}

/** 目标张力：长期目标 vs 近期实际行为背离检测。 */
export function detectGoalTension(
  longTermGoal: string,
  recentBehaviors: ReadonlyArray<string>,
): { tension: boolean; type: string; detail: string } {
  const goal = (longTermGoal ?? "").trim().toLowerCase();
  if (!goal || recentBehaviors.length === 0) return { tension: false, type: "none", detail: "证据不足" };
  const goalTokens = tokenize(goal);
  const behaviorText = recentBehaviors.join(" ").toLowerCase();
  const aligned = goalTokens.some((t) => behaviorText.includes(t));
  if (aligned) return { tension: false, type: "none", detail: "近期行为与长期目标对齐" };
  return {
    tension: true,
    type: "verbal-vs-behavioral",
    detail: `长期目标「${longTermGoal.slice(0, 40)}」近期行为未见对应推进`,
  };
}

/** 镜像精度 → 行为参数：越懂你，说话越有把握、代执行越敢、干预阈值越低（更主动）。 */
export function mirrorToBehaviorParams(score: MirrorScore): {
  speechAssertiveness: number;
  actionBoldness: number;
  interveneThreshold: number;
} {
  const c = Math.max(0, Math.min(1, score.composite));
  return {
    speechAssertiveness: 0.3 + 0.7 * c, // 0.3~1.0
    actionBoldness: 0.2 + 0.8 * c,      // 0.2~1.0
    interveneThreshold: 0.8 - 0.5 * c,  // 0.8~0.3：精度越高越早出手
  };
}

/** 镜像精度 → 宪法中 mirror 源权重：关于 composite 单调不减（越懂你越有发言权）。 */
export function mirrorToWeight(score: MirrorScore): number {
  const c = Math.max(0, Math.min(1, score.composite));
  return 0.3 + 1.2 * c; // 0.3~1.5：低精度发言权小，高精度可超过其他源
}
