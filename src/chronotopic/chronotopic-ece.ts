/**
 * 时空校准层 · V3 ECE 校准升级（chronotopic-ece.ts）
 * ------------------------------------------------------------------
 * 在既有 Brier 体系（judgment/calibration.ts）**旁**新增「期望校准误差」
 * （Expected Calibration Error, ECE）纯函数视角，而**绝不替换**既有 API。
 *
 * ─── 第一性原理 ───
 * Brier score 是严格适当评分规则，惩罚不诚实的概率报告；但它把「区分度」与
 * 「校准」揉在一个标量里。ECE 则专测**校准**：把预测按报出信心分桶，看每桶
 * 「平均信心」与「实际命中率」差多少，再按样本占比加权求和——直接回答
 * 「弟弟说 70% 的事，是不是真有约 70% 命中」。两者从同一批已结算预测算出，
 * 互为补充、并存不悖。
 *
 *   ECE = Σ_b (n_b / N) × |meanConfidence_b − actualHitRate_b|
 *
 * 设计硬约束（requirements.md Requirement 9）：
 *   - 严格复用既有 `calibrationTable(graded)` 的同一套分桶结果，不另造分桶。
 *   - 只 import `../judgment/calibration.js` 的类型与既有纯函数，绝不改其源。
 *   - 保持 brierScore / meanBrier / judgmentScore / calibrationTable /
 *     worstOverconfidenceBin / CalibrationBin 全部签名与返回语义不变。
 *
 * 本模块为确定性纯函数：无副作用、无 I/O、不读时钟、不读随机，
 * 便于 fast-check 属性测试。绝对边界同时空层（不依赖 3.1/3.2、纯 ESM）。
 *
 * _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6_
 */

import type { CalibrationBin, GradedPrediction } from "../judgment/calibration.js";
import { calibrationTable, clamp01 } from "../judgment/calibration.js";

/**
 * 从既有 `calibrationTable` 的分桶结果直接计算 ECE。
 *
 * 便于在已经持有 `CalibrationBin[]` 时复用同一次分桶，避免重复遍历预测集。
 *
 * `ECE = Σ_b (bin.count / totalCount) × |bin.meanConfidence − bin.actualHitRate|`。
 * 各桶偏差 `∈ [0,1]`、各桶占比非负且和 ≤ 1，故结果天然落在 `[0,1]`；
 * 出口再以 `clamp01` 兜底（防御浮点误差/异常入参）。
 *
 * @param bins 既有 `calibrationTable(graded)` 返回的信心桶（只读消费，不修改）。
 * @param totalCount 总样本数 N（通常为 `graded.length` 或 `Σ bin.count`）。
 * @returns ECE ∈ [0,1]；`totalCount ≤ 0` 时返回 `0`（无样本，零误差占位）。
 */
export function eceFromBins(
  bins: readonly CalibrationBin[],
  totalCount: number,
): number {
  if (totalCount <= 0) return 0;
  let ece = 0;
  for (const bin of bins) {
    // 不变式：累加过程中 0 ≤ ece ≤ (已累加桶的样本占比之和)，恒非负。
    ece += (bin.count / totalCount) * Math.abs(bin.meanConfidence - bin.actualHitRate);
  }
  return clamp01(ece);
}

/**
 * 期望校准误差（ECE）：复用既有 `calibrationTable(graded)` 分桶后加权求和。
 *
 * 与 `judgmentScore` 的「不下结论」语义一致：样本不足返回 `null`（不污染指标）。
 * 完美校准（每桶 `actualHitRate === meanConfidence`）→ `0`；值域 `[0,1]`。
 *
 * 本函数**只读**消费 `graded`，不改既有校准账本、不改既有 Brier API 的任何返回。
 *
 * @param graded 已被客观裁定的预测集合（confidence 越界由 calibrationTable 内部 clamp01）。
 * @param minSample 最小样本数，低于此返回 `null`。默认 3（与 `judgmentScore` 对齐）。
 * @returns ECE ∈ [0,1]；样本数 < `minSample` 时返回 `null`。
 */
export function expectedCalibrationError(
  graded: readonly GradedPrediction[],
  minSample = 3,
): number | null {
  if (graded.length < minSample) return null;
  const bins = calibrationTable(graded);
  return eceFromBins(bins, graded.length);
}
