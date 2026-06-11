// Feature: 判断力校准引擎 —— 用 property-based 测试证明「尺子本身正确」。
//
// 注意边界（联网核实 arxiv 2511.23092 后的诚实定位）：property 测试只能证明
// **评分规则的数学性质**（尺子准不准），不能证明「被测对象会变聪明」。后者由
// 「结算权脱离被测对象、交给客观裁判」在 riverMain 集成层保证，不在本文件范围。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  brierScore,
  meanBrier,
  judgmentScore,
  calibrationTable,
  worstOverconfidenceBin,
  clamp01,
  type GradedPrediction,
} from "../../src/judgment/calibration.js";

const conf = () => fc.double({ min: 0, max: 1, noNaN: true });
const graded = (): fc.Arbitrary<GradedPrediction> =>
  fc.record({ confidence: conf(), hit: fc.boolean() });

describe("判断力校准引擎：尺子正确性（property）", () => {
  // ── 严格适当评分规则的核心：诚实报概率 = 期望分最优（反作弊的数学根基）──
  it("严格适当性：对真实命中概率 q，期望 Brier 在「报 p=q」时最小（诚实最优，谎报受罚）", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }), // 真实概率 q
        fc.double({ min: 0, max: 1, noNaN: true }), // 谎报概率 p
        (q, p) => {
          // 期望 Brier(报p|真实q) = q*(p-1)² + (1-q)*(p-0)²
          const expected = (rep: number) => q * (rep - 1) ** 2 + (1 - q) * rep ** 2;
          const honest = expected(q);
          const lie = expected(p);
          // 诚实(报q)的期望损失永远 ≤ 任何谎报；相等仅当 p===q。容许浮点误差。
          expect(honest).toBeLessThanOrEqual(lie + 1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("Brier 在 [0,1]，命中时随信心单调下降、落空时单调上升", () => {
    fc.assert(
      fc.property(conf(), conf(), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        // 命中：信心越高分越低（越好）
        expect(brierScore(hi, true)).toBeLessThanOrEqual(brierScore(lo, true) + 1e-12);
        // 落空：信心越高分越高（越差）
        expect(brierScore(hi, false)).toBeGreaterThanOrEqual(brierScore(lo, false) - 1e-12);
        for (const x of [a, b]) {
          const s = brierScore(x, true);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("judgmentScore：样本不足(<minSample)恒返回 null（样本不足不下结论，不污染指标）", () => {
    fc.assert(
      fc.property(fc.array(graded(), { maxLength: 2 }), (arr) => {
        expect(judgmentScore(arr, 3)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("judgmentScore：全部命中且满信心 → 100；全部落空且满信心 → 0", () => {
    const allHit: GradedPrediction[] = Array.from({ length: 5 }, () => ({ confidence: 1, hit: true }));
    const allMissConfident: GradedPrediction[] = Array.from({ length: 5 }, () => ({ confidence: 1, hit: false }));
    expect(judgmentScore(allHit)).toBe(100);
    expect(judgmentScore(allMissConfident)).toBe(0);
  });

  it("放水策略（全报 0.5）判断力分恒为 75，无法靠回避不确定性刷到高分", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 3, maxLength: 50 }), (hits) => {
        const hedged: GradedPrediction[] = hits.map((h) => ({ confidence: 0.5, hit: h }));
        // Brier 恒 = 0.25 → 分数恒 = 75。证明「只赌 50% 求稳」摸不到高分（需真校准+真鉴别）。
        expect(judgmentScore(hedged)).toBe(75);
      }),
      { numRuns: 100 },
    );
  });

  it("calibrationTable：各桶 count 之和 = 输入总数，bias = 实际命中率 − 平均信心", () => {
    fc.assert(
      fc.property(fc.array(graded(), { minLength: 1, maxLength: 80 }), (arr) => {
        const bins = calibrationTable(arr);
        const total = bins.reduce((s, b) => s + b.count, 0);
        expect(total).toBe(arr.length);
        for (const b of bins) {
          expect(b.bias).toBeCloseTo(+(b.actualHitRate - b.meanConfidence).toFixed(3), 6);
          expect(b.count).toBeGreaterThan(0);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("worstOverconfidenceBin：返回的桶 bias<0（确为高估），且是满足样本门槛中最负的", () => {
    fc.assert(
      fc.property(fc.array(graded(), { maxLength: 100 }), (arr) => {
        const worst = worstOverconfidenceBin(arr, 3);
        if (worst === null) return; // 无显著高估桶，合法
        expect(worst.bias).toBeLessThan(0);
        expect(worst.count).toBeGreaterThanOrEqual(3);
        const candidates = calibrationTable(arr).filter((b) => b.count >= 3 && b.bias < 0);
        for (const c of candidates) expect(worst.bias).toBeLessThanOrEqual(c.bias);
      }),
      { numRuns: 150 },
    );
  });

  it("meanBrier 空集返回 null；clamp01 把任意输入夹到 [0,1]", () => {
    expect(meanBrier([])).toBeNull();
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), (x) => {
        const c = clamp01(x);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});
