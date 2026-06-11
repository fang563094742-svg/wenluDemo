/**
 * 时空校准层 · ECE 校准属性测试（chronotopic-ece.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 12.3（Property 14：ECE 值域与完美校准）、12.4（Property 15：ECE
 * 与既有 Brier API 共存不破坏）。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-ece.js，以及
 * 既有 ../judgment/calibration.js（只读其纯函数做对比，绝不改其源）。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { expectedCalibrationError } from "./chronotopic-ece.js";
import {
  brierScore,
  meanBrier,
  judgmentScore,
  calibrationTable,
  worstOverconfidenceBin,
  type GradedPrediction,
} from "../judgment/calibration.js";

/** 任意一条已结算预测（confidence 含越界 / 异常值，hit 任意布尔）。 */
const gradedArb: fc.Arbitrary<GradedPrediction> = fc.record({
  confidence: fc.oneof(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.double({ min: -50, max: 50, noNaN: true }),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, 1, -0.3, 1.7),
  ),
  hit: fc.boolean(),
});

/** 任意已结算预测集合（含空集与超过 minSample 的较大集合）。 */
const gradedListArb: fc.Arbitrary<GradedPrediction[]> = fc.array(gradedArb, {
  minLength: 0,
  maxLength: 200,
});

const MIN_SAMPLE = 3;
const TOL = 1e-9;

describe("expectedCalibrationError（Property 14：ECE 值域与完美校准）", () => {
  // **Validates: Requirements 9.1, 9.3**
  it("样本 ≥ minSample 时 ECE ∈ [0,1]；样本 < minSample 返回 null", () => {
    fc.assert(
      fc.property(gradedListArb, (graded) => {
        const ece = expectedCalibrationError(graded, MIN_SAMPLE);
        if (graded.length < MIN_SAMPLE) {
          expect(ece).toBeNull();
        } else {
          expect(ece).not.toBeNull();
          const v = ece as number;
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  // **Validates: Requirements 9.1, 9.3**
  it("完美校准（每桶 actualHitRate === meanConfidence）：ECE 在容差内为 0", () => {
    fc.assert(
      fc.property(
        // 构造完美校准：全 confidence=1 且 hit=true（桶内命中率 1 = 信心 1），
        // 与全 confidence=0 且 hit=false（桶内命中率 0 = 信心 0）混合。
        // 两类各自落入不同信心桶，桶内 actualHitRate 恒等于 meanConfidence。
        fc.integer({ min: MIN_SAMPLE, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (nHigh, nLow) => {
          const graded: GradedPrediction[] = [
            ...Array.from({ length: nHigh }, () => ({ confidence: 1, hit: true })),
            ...Array.from({ length: nLow }, () => ({ confidence: 0, hit: false })),
          ];
          const ece = expectedCalibrationError(graded, MIN_SAMPLE);
          expect(ece).not.toBeNull();
          expect(Math.abs(ece as number)).toBeLessThanOrEqual(TOL);
        },
      ),
    );
  });
});

describe("expectedCalibrationError（Property 15：ECE 与既有 Brier API 共存不破坏）", () => {
  // **Validates: Requirements 9.5, 9.6**
  it("调用 ECE 前后，既有 Brier 系列函数对同一输入的返回值完全不变", () => {
    fc.assert(
      fc.property(gradedListArb, (graded) => {
        // 调用前快照：既有 API 对该输入的返回值。
        const beforeMeanBrier = meanBrier(graded);
        const beforeJudgment = judgmentScore(graded);
        const beforeTable = calibrationTable(graded);
        const beforeWorst = worstOverconfidenceBin(graded);
        const beforeBrier = graded.map((g) => brierScore(g.confidence, g.hit));

        // 调用被测纯函数（不应触碰任何既有状态 / 入参）。
        expectedCalibrationError(graded);

        // 调用后再次求值，断言与调用前逐一深度相等。
        expect(meanBrier(graded)).toEqual(beforeMeanBrier);
        expect(judgmentScore(graded)).toEqual(beforeJudgment);
        expect(calibrationTable(graded)).toEqual(beforeTable);
        expect(worstOverconfidenceBin(graded)).toEqual(beforeWorst);
        expect(graded.map((g) => brierScore(g.confidence, g.hit))).toEqual(beforeBrier);
      }),
    );
  });

  // **Validates: Requirements 9.5, 9.6**
  it("ECE 不修改入参 graded（纯函数、只读消费）", () => {
    fc.assert(
      fc.property(gradedListArb, (graded) => {
        const snapshot = structuredClone(graded);
        expectedCalibrationError(graded);
        expect(graded).toEqual(snapshot);
      }),
    );
  });
});
