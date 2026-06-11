/**
 * 主权自体 · Component 5：时空入主（chrono-govern.ts）
 * ------------------------------------------------------------------
 * 把时空签名从"渲染一段文风"升级为统治检索/判断/节奏/人格姿态的一等裁决输入。
 * 复用 chronotopic barrel 的 ChronotopicSignature，不重造时空引擎。
 * _Requirements: 4.1-4.7, 6.2_
 */

import type { ChronotopicSignature } from "../chronotopic/index.js";
import { type ChronoVerdictInput } from "./types.js";

/** 签名 → 宪法一等输入（scene/presence/temporal + 显著度）。fail-open：缺失返回低显著占位。 */
export function signatureToVerdictInput(sig: ChronotopicSignature | null | undefined): ChronoVerdictInput {
  if (!sig) return { scene: "unknown", presence: "away", temporal: "unknown", salience: 0 };
  const temporal = typeof (sig.temporal as { timeOfDay?: string })?.timeOfDay === "string"
    ? String((sig.temporal as { timeOfDay?: string }).timeOfDay)
    : "unknown";
  // 显著度：在场度越高、场景越明确，时空信号此刻越该被听见。
  const presenceSalience = sig.presence === "present" ? 1 : sig.presence === "recently_active" ? 0.5 : 0.15;
  const sceneSalience = sig.scene === "unknown" || sig.scene === "idle" ? 0.4 : 1;
  return {
    scene: String(sig.scene ?? "unknown"),
    presence: String(sig.presence ?? "away"),
    temporal,
    salience: Math.max(0, Math.min(1, presenceSalience * sceneSalience)),
  };
}

/**
 * 当前在场态 → 记忆检索加权。与海马体 retrieve 配合：
 * 在场+明确场景 → 提升同场景近期记忆权重；离开 → 弱化近期、回归长期。
 */
export function chronoRetrievalBias(input: ChronoVerdictInput): { sceneBoost: number; recencyBoost: number } {
  const present = input.presence === "present";
  const recently = input.presence === "recently_active";
  return {
    sceneBoost: input.scene === "unknown" || input.scene === "idle" ? 0 : 0.5 * input.salience,
    recencyBoost: present ? 0.6 : recently ? 0.3 : -0.2, // 离开则更偏长期记忆
  };
}

/**
 * 在场态 → "未来的我"人格姿态（喂 narrative persona）。
 * 同一用户在不同人生时段/在场态唤出不同姿态：深夜在场→沉稳陪伴；清晨规划→进取推进；离开→克制留白。
 */
export function chronoToPersonaStance(input: ChronoVerdictInput): string {
  if (input.presence === "away") return "克制留白：用户已离开，少打扰、只留必要的下一步";
  const t = input.temporal;
  if (t === "night" || t === "late_night" || t === "evening") {
    return "沉稳陪伴：夜间在场，语气放缓、先稳住情绪再谈推进";
  }
  if (t === "morning" || t === "early_morning") {
    return "进取推进：清晨规划时段，直给方向与最高杠杆的下一步";
  }
  if (input.scene === "coding") return "并肩作战：编码场景，简短、精确、可执行";
  if (input.scene === "meeting") return "幕后支援：会议中，只在被需要时给关键一句";
  return "稳健在场：按当前场景给恰当颗粒度的回应";
}
