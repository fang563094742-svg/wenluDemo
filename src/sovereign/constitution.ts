/**
 * 主权自体 · Component 3：宪法裁决层（constitution.ts）
 * ------------------------------------------------------------------
 * 当七个信号源冲突时，由宪法确定地裁定谁说了算、干预多强。纯函数、可单测。
 *
 * 铁律（钉死，不可被任何裁决绕过）：
 *  - 河床判断 canTriggerEngine=false：enforceRiverbedBedrock 强制所有 riverbed 信号
 *    canDrive=false；任何 Verdict 若 adopt=riverbed，drivingAllowed 恒 false。
 *  - 用户当下 vs 长期：不盲从当下、不背叛长期，由权重+强度裁决。
 * _Requirements: 2.1-2.4, 2.7, 2.8, 6.1_
 */

import {
  type SignalSource,
  type SourceSignal,
  type Intervention,
  type Verdict,
} from "./types.js";
import { type PolicyWeights } from "./sovereign-config.js";

/** 河床铁律守卫：强制所有 riverbed 来源信号 canDrive=false（判断永不夺权）。不改其他源。 */
export function enforceRiverbedBedrock(signals: ReadonlyArray<SourceSignal>): SourceSignal[] {
  return signals.map((s) =>
    s.source === "riverbed" && s.canDrive ? { ...s, canDrive: false } : { ...s },
  );
}

/**
 * 用户当下显性表达 vs 用户长期真实走向的冲突裁决。
 * 不恒采当下、不恒采长期：由各自 weight*strength 决定；接近时偏向长期（不背叛长期）。
 */
export function reconcileUserNowVsTrajectory(
  explicit: SourceSignal,
  trajectory: SourceSignal,
  weights: PolicyWeights,
): { adopt: SignalSource; rationale: string } {
  const nowScore = (weights.userExplicit ?? 0) * (explicit?.strength ?? 0);
  const trajScore = (weights.userTrajectory ?? 0) * (trajectory?.strength ?? 0);
  // 接近（差距 < 10%）时偏向长期走向，避免被一时表达带偏；否则取高分者。
  if (Math.abs(nowScore - trajScore) < 0.1 * Math.max(nowScore, trajScore, 1e-9)) {
    return { adopt: "userTrajectory", rationale: "当下与长期接近，偏向长期走向（不背叛长期）" };
  }
  return nowScore > trajScore
    ? { adopt: "userExplicit", rationale: "当下表达足够强，优先回应当下" }
    : { adopt: "userTrajectory", rationale: "长期走向权重更高，不盲从当下" };
}

function weightedScore(s: SourceSignal, weights: PolicyWeights): number {
  return (weights[s.source] ?? 0) * (Number.isFinite(s.strength) ? Math.max(0, Math.min(1, s.strength)) : 0);
}

/** 干预强度映射：河床/低置信 → soft/hold；高置信非河床 → strong；矛盾未决 → silent。 */
function deriveIntervention(adopt: SignalSource, confidence: number, contested: boolean): Intervention {
  if (contested && confidence < 0.35) return "silent";
  if (adopt === "riverbed") return confidence >= 0.6 ? "soft" : "hold";
  if (confidence >= 0.7) return "strong";
  if (confidence >= 0.45) return "soft";
  return "hold";
}

/**
 * 裁决：确定性纯函数。给定信号集 + 权重 → Verdict。不修改入参。
 * 算法：①enforceRiverbedBedrock ②userExplicit/userTrajectory 冲突走 reconcile
 * ③最高加权源为 adopt ④置信由 adopt 分数相对总分 ⑤干预强度映射
 * ⑥drivingAllowed 仅当 adopt 源 canDrive 且 intervention=strong（河床恒 false）。
 */
export function adjudicate(signals: ReadonlyArray<SourceSignal>, weights: PolicyWeights): Verdict {
  const safe = enforceRiverbedBedrock(signals);
  if (safe.length === 0) {
    return { adopt: "userTrajectory", intervention: "hold", confidence: 0, rationale: "无信号，暂不出手", drivingAllowed: false };
  }

  // 用户当下 vs 长期：若两者都在场，先 reconcile 出用户侧主张。
  const explicit = safe.find((s) => s.source === "userExplicit");
  const trajectory = safe.find((s) => s.source === "userTrajectory");
  let userPreferred: SignalSource | null = null;
  let userRationale = "";
  if (explicit && trajectory) {
    const r = reconcileUserNowVsTrajectory(explicit, trajectory, weights);
    userPreferred = r.adopt;
    userRationale = r.rationale;
  }

  // 计算各源加权分；用户侧只保留 reconcile 出的那个。
  const scored = safe
    .filter((s) => {
      if (s.source === "userExplicit" || s.source === "userTrajectory") {
        return userPreferred ? s.source === userPreferred : true;
      }
      return true;
    })
    .map((s) => ({ s, score: weightedScore(s, weights) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const total = scored.reduce((acc, x) => acc + x.score, 0);
  const confidence = total > 0 ? Math.max(0, Math.min(1, top.score / total)) : 0;
  // 矛盾未决：第一名与第二名分数接近（差距 < 15%）。
  const contested = scored.length >= 2 && top.score > 0 && (top.score - scored[1].score) / top.score < 0.15;

  const adopt = top.s.source;
  const intervention = deriveIntervention(adopt, confidence, contested);
  const drivingAllowed = top.s.canDrive === true && intervention === "strong" && adopt !== "riverbed";

  const rationale = adopt === userPreferred && userRationale
    ? userRationale
    : `采纳「${adopt}」(加权分 ${top.score.toFixed(3)}/${total.toFixed(3)})${contested ? "；存在接近竞争者" : ""}`;

  return { adopt, intervention, confidence, rationale, drivingAllowed };
}

/** 类封装。 */
export class Constitution {
  constructor(private readonly weights: PolicyWeights) {}
  adjudicate(signals: ReadonlyArray<SourceSignal>): Verdict {
    return adjudicate(signals, this.weights);
  }
}
