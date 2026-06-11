/**
 * 主权自体 · 一等公民类型（types.ts）
 * ------------------------------------------------------------------
 * 七大信号源、信号、裁决、镜像精度、时空裁决输入。全部领域无关、可单测。
 * _Requirements: 2.1, 2.2, 3.4, 4.2_
 */

import { randomUUID } from "node:crypto";

/** 宪法的七个信号源。 */
export type SignalSource =
  | "riverbed"        // 河床域判断（canTriggerEngine=false，只影响倾向）
  | "mirror"          // 镜像精度
  | "chronotopic"     // 时空在场
  | "truthTier"       // 真假分层
  | "northStar"       // 北极星长期目标
  | "userExplicit"    // 用户当下显性表达
  | "userTrajectory"; // 用户长期真实走向

export interface SourceSignal {
  source: SignalSource;
  /** 该源此刻主张什么（人可读）。 */
  stance: string;
  /** 0-1，该源此刻的强度/紧迫度。 */
  strength: number;
  /** 是否允许直接驱动执行（河床恒 false）。 */
  canDrive: boolean;
}

/** 干预强度：强干预 / 弱建议 / 暂不出手 / 闭嘴不补。 */
export type Intervention = "strong" | "soft" | "hold" | "silent";

export interface Verdict {
  /** 采纳哪个源为主。 */
  adopt: SignalSource;
  intervention: Intervention;
  /** 0-1。 */
  confidence: number;
  rationale: string;
  /** 是否允许出手执行（河床主张恒不置 true）。 */
  drivingAllowed: boolean;
}

/** 镜像精度（不自评，只由真实结算驱动）。 */
export interface MirrorScore {
  /** shadowPrediction 命中率 0-1。 */
  accuracy: number;
  /** agent 行动被用户采纳率 0-1。 */
  acceptRate: number;
  /** 综合 0-1。 */
  composite: number;
}

/** 时空签名投影成的宪法一等输入。 */
export interface ChronoVerdictInput {
  scene: string;
  presence: string;
  temporal: string;
  /** 0-1，时空信号此刻的显著度。 */
  salience: number;
}

export function newVerdictId(): string {
  return `verdict_${randomUUID()}`;
}
