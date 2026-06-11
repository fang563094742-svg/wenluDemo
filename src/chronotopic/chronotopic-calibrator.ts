/**
 * 时空校准层 · 置信度校准器（Component 3：chronotopic-calibrator.ts）
 * ------------------------------------------------------------------
 * 把一条「原始置信度」依据时空签名（when × presence）确定性地降权——越是
 * 深夜、越是用户已离开很久，关于「此刻」的判断越不可全信，于是按时段档与在场
 * 档各自的乘子折减。本模块构建在 chronotopic-time.ts（TimeOfDay）与
 * chronotopic-signature.ts（ChronotopicPresence / ChronotopicSignature）之上。
 *
 * 设计要点（参见 design.md Component 3 与 requirements.md Requirement 3）：
 *  - 确定性纯函数：不读真实时钟、不读随机源，全部由入参推出。
 *  - 所有乘子 ∈ (0,1]，基准档 = 1.0，因此校准只会「降权」，绝不放大。
 *  - 越界 / NaN 的原始置信度先经 clamp01 归一到 [0,1]，再参与乘法。
 *
 * 关键性质（属性测试会验证，实现必须保证）：
 *  - 值域：calibrateConfidence 的结果恒落在 [0,1]。
 *  - 单调降权：所有乘子 ≤ 1，故 calibrated ≤ clamp01(raw)。
 *  - 对 raw 单调非减：raw 越大，calibrated 不减。
 *  - 基准恒等：当涉及的乘子全为 1.0 时，calibrated === clamp01(raw)。
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不 import judgment/calibration（时空层自带 clamp01，NaN→0，与河床层一致）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import type { TimeOfDay } from "./chronotopic-time.js";
import type { ChronotopicPresence, ChronotopicSignature } from "./chronotopic-signature.js";

/**
 * 时空校准配置：时段档与在场档各自的折减乘子。
 *
 * 约定（参见 requirements.md R3.2）：每个乘子都应落在 (0,1]，基准档取 1.0，
 * 从而保证校准只降权不放大。
 */
export interface ChronotopicCalibrationConfig {
  /** 时段档 → 乘子（∈ (0,1]）。 */
  timeOfDayFactor: Record<TimeOfDay, number>;
  /** 在场档 → 乘子（∈ (0,1]）。 */
  presenceFactor: Record<ChronotopicPresence, number>;
}

/**
 * 默认时空校准配置。
 *
 * 时段档（白天为基准 1.0，夜晚渐降）：
 *  - afternoon = 1.0、morning = 1.0（白天基准）
 *  - evening = 0.9（傍晚略降）
 *  - night = 0.8（深夜降权）
 *  - late_night = 0.7（凌晨降权最多）
 *
 * 在场档（用户离开越久，关于「此刻」越降权）：
 *  - present = 1.0（在场基准）
 *  - recently_active = 0.9（刚离开）
 *  - away = 0.7（已离开）
 *
 * 所有乘子均 ∈ (0,1]。
 */
export const DEFAULT_CHRONOTOPIC_CONFIG: ChronotopicCalibrationConfig = {
  timeOfDayFactor: {
    morning: 1.0,
    afternoon: 1.0,
    evening: 0.9,
    night: 0.8,
    late_night: 0.7,
  },
  presenceFactor: {
    present: 1.0,
    recently_active: 0.9,
    away: 0.7,
  },
};

/**
 * 把任意数值钳到 [0,1]（时空层内部惯例：NaN → 0）。
 *
 * 规则：
 *  - NaN → 0（与河床层 riverbed-util 一致；注意与 judgment/calibration 的 NaN→0.5
 *    不同，本层不依赖那边的实现）。
 *  - x < 0 → 0。
 *  - x > 1 → 1。
 *  - 其余原样返回。
 *
 * @param x 任意数值
 * @returns 位于 [0,1] 的钳值
 */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 依据时空签名对原始置信度做确定性校准（纯函数，不读时钟、不读随机）。
 *
 * 计算式：
 *   calibrated = clamp01( clamp01(rawConfidence)
 *                         × timeOfDayFactor[signature.temporal.timeOfDay]
 *                         × presenceFactor[signature.presence] )
 *
 * 先把越界 / NaN 的 rawConfidence 钳到 [0,1]，再分别乘以时段档、在场档乘子，
 * 末端再钳一次以吸收浮点误差。由于所有乘子 ∈ (0,1]，结果恒 ≤ clamp01(raw)。
 *
 * @param rawConfidence 原始置信度（越界 / NaN 会先被 clamp01 归一）
 * @param signature 时空签名（提供 timeOfDay 与 presence）
 * @param config 校准配置，默认 DEFAULT_CHRONOTOPIC_CONFIG
 * @returns 校准后的置信度，恒落在 [0,1]
 */
export function calibrateConfidence(
  rawConfidence: number,
  signature: ChronotopicSignature,
  config: ChronotopicCalibrationConfig = DEFAULT_CHRONOTOPIC_CONFIG,
): number {
  const base = clamp01(rawConfidence);
  const timeFactor = config.timeOfDayFactor[signature.temporal.timeOfDay];
  const presenceFactor = config.presenceFactor[signature.presence];
  return clamp01(base * timeFactor * presenceFactor);
}
