/**
 * 主权自体 · Component 6：自进化升格为宪法增量（policy-delta.ts）
 * ------------------------------------------------------------------
 * 让自我进化从"改一句提示"升格为"在保护下改统治法则（宪法权重）"。
 * 红线永久不可改：核心循环、安全闸、河床 canTriggerEngine 铁律。
 * 生效必须由现实指标背书（镜像精度提升 / 成果验证通过），不由自评。
 * _Requirements: 5.1-5.5_
 */

import { type SignalSource } from "./types.js";
import { type PolicyWeights } from "./sovereign-config.js";

export interface PolicyDelta {
  /** 对各信号源权重的调整。 */
  weightAdjust: Partial<PolicyWeights>;
  /** 可选干预阈值调整。 */
  threshold?: number;
  reason: string;
}

const VALID_SOURCES: ReadonlyArray<SignalSource> = [
  "riverbed", "mirror", "chronotopic", "truthTier", "northStar", "userExplicit", "userTrajectory",
];

/**
 * 净化 delta：剔除任何触碰红线或非法的调整。
 * 红线：① 不得把 riverbed 权重抬到可"夺权"的程度（riverbed 仍只影响倾向，权重封顶）
 *      ② 不得出现非七源的键 ③ 不得设负权重 ④ reason 必须非空。
 */
export function sanitizePolicyDelta(delta: PolicyDelta): { safe: PolicyDelta; rejected: string[] } {
  const rejected: string[] = [];
  const safeAdjust: Partial<PolicyWeights> = {};
  if (!delta || typeof delta !== "object") {
    return { safe: { weightAdjust: {}, reason: "empty" }, rejected: ["delta 非法"] };
  }
  if (!delta.reason || !delta.reason.trim()) rejected.push("缺少 reason，拒绝");

  for (const [k, v] of Object.entries(delta.weightAdjust ?? {})) {
    if (!VALID_SOURCES.includes(k as SignalSource)) { rejected.push(`非法信号源键 ${k}`); continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { rejected.push(`非法权重 ${k}=${v}`); continue; }
    // 河床铁律：河床权重封顶 1.0（只影响倾向，永不夺权）。
    if (k === "riverbed" && v > 1.0) { rejected.push("河床权重超限(>1.0)被钉回，铁律不可绕过"); safeAdjust.riverbed = 1.0; continue; }
    // 单源权重总封顶 2.0。
    (safeAdjust as Record<string, number>)[k] = Math.min(2, v);
  }

  const safe: PolicyDelta = {
    weightAdjust: safeAdjust,
    threshold: typeof delta.threshold === "number" && Number.isFinite(delta.threshold)
      ? Math.max(0, Math.min(1, delta.threshold))
      : undefined,
    reason: delta.reason?.trim() || "(no reason)",
  };
  return { safe, rejected };
}

/** 应用 delta 到权重（纯函数，clamp[0,2]，返回新权重，不改入参）。 */
export function applyPolicyDelta(weights: PolicyWeights, delta: PolicyDelta): PolicyWeights {
  const { safe } = sanitizePolicyDelta(delta);
  const next: PolicyWeights = { ...weights };
  for (const [k, v] of Object.entries(safe.weightAdjust)) {
    if (VALID_SOURCES.includes(k as SignalSource) && typeof v === "number") {
      next[k as SignalSource] = Math.max(0, Math.min(2, v));
    }
  }
  return next;
}

/**
 * delta 是否被现实背书：镜像精度或成果验证至少一项真实提升，且无一项显著倒退。
 * 不由自评——传入的是客观度量前后值。
 */
export function isPolicyDeltaEndorsed(
  before: { mirror: number; results: number },
  after: { mirror: number; results: number },
): boolean {
  const mirrorUp = after.mirror > before.mirror + 1e-6;
  const resultsUp = after.results > before.results + 1e-6;
  const mirrorRegressed = after.mirror < before.mirror - 0.05;
  const resultsRegressed = after.results < before.results - 0.05;
  return (mirrorUp || resultsUp) && !mirrorRegressed && !resultsRegressed;
}
