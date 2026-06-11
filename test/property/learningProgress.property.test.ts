// Feature: 学习进度引擎 —— property 测试证明「尺子本身正确」。
// 证明：LP∈[0,1] 且对三分量单调、ZPD 甜区在 0.5 胜任度处主导、经验LP只取上升、选题取最高LP、停滞检测正确。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  learningProgress,
  empiricalLearningProgress,
  pickHighestLP,
  isStagnant,
  LP_WEIGHTS,
  type LearningCandidate,
} from "../../src/judgment/learningProgress.js";

const prob = () => fc.double({ min: 0, max: 1, noNaN: true });
const cand = (): fc.Arbitrary<LearningCandidate> =>
  fc.record({
    id: fc.string({ minLength: 1 }),
    novelty: prob(),
    competence: prob(),
    empiricalLP: fc.option(prob(), { nil: undefined }),
  });

describe("学习进度引擎：尺子正确性（property）", () => {
  it("LP ∈ [0,1]", () => {
    fc.assert(
      fc.property(cand(), (c) => {
        const lp = learningProgress(c);
        expect(lp).toBeGreaterThanOrEqual(0);
        expect(lp).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it("对 novelty 单调不减：其余不变，novelty 越高 LP 越高", () => {
    fc.assert(
      fc.property(prob(), prob(), prob(), prob(), (n1, n2, comp, emp) => {
        const [lo, hi] = n1 <= n2 ? [n1, n2] : [n2, n1];
        const base = { id: "x", competence: comp, empiricalLP: emp };
        expect(learningProgress({ ...base, novelty: hi })).toBeGreaterThanOrEqual(
          learningProgress({ ...base, novelty: lo }) - 1e-9,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("对 empiricalLP 单调不减：其余不变，经验LP越高 LP越高", () => {
    fc.assert(
      fc.property(prob(), prob(), prob(), prob(), (e1, e2, nov, comp) => {
        const [lo, hi] = e1 <= e2 ? [e1, e2] : [e2, e1];
        const base = { id: "x", novelty: nov, competence: comp };
        expect(learningProgress({ ...base, empiricalLP: hi })).toBeGreaterThanOrEqual(
          learningProgress({ ...base, empiricalLP: lo }) - 1e-9,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("ZPD：胜任度0.5的可学习性分量 ≥ 胜任度0或1（甜区主导）", () => {
    fc.assert(
      fc.property(prob(), prob(), (nov, emp) => {
        const base = { id: "x", novelty: nov, empiricalLP: emp };
        const mid = learningProgress({ ...base, competence: 0.5 });
        const edge0 = learningProgress({ ...base, competence: 0 });
        const edge1 = learningProgress({ ...base, competence: 1 });
        expect(mid).toBeGreaterThanOrEqual(edge0 - 1e-9);
        expect(mid).toBeGreaterThanOrEqual(edge1 - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("经验LP只取上升：后半段成功率高于前半段→正；持平或下降→0", () => {
    expect(empiricalLearningProgress([false, false, true, true])).toBeGreaterThan(0);
    expect(empiricalLearningProgress([true, true, false, false])).toBe(0); // 下降取0
    expect(empiricalLearningProgress([true, true, true, true])).toBe(0); // 持平取0
    expect(empiricalLearningProgress([true])).toBe(0); // 样本不足
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 2, maxLength: 40 }), (xs) => {
        const lp = empiricalLearningProgress(xs);
        expect(lp).toBeGreaterThanOrEqual(0);
        expect(lp).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it("pickHighestLP：选出的 LP ≥ 所有候选；空集 null", () => {
    fc.assert(
      fc.property(fc.array(cand(), { minLength: 1, maxLength: 12 }), (cs) => {
        const best = pickHighestLP(cs)!;
        for (const c of cs) expect(best.lp).toBeGreaterThanOrEqual(learningProgress(c) - 1e-9);
      }),
      { numRuns: 200 },
    );
    expect(pickHighestLP([])).toBeNull();
  });

  it("isStagnant：全部低于阈值才判停滞；空集判停滞（该开新疆域）", () => {
    expect(isStagnant([])).toBe(true);
    const allLow: LearningCandidate[] = [
      { id: "a", novelty: 0.1, competence: 0.95, empiricalLP: 0 },
      { id: "b", novelty: 0.1, competence: 0.05, empiricalLP: 0 },
    ];
    expect(isStagnant(allLow)).toBe(true);
    const oneHigh: LearningCandidate[] = [...allLow, { id: "c", novelty: 0.9, competence: 0.5, empiricalLP: 0.8 }];
    expect(isStagnant(oneHigh)).toBe(false);
  });

  it("权重和为 1（LP 是凸组合，保证 ∈[0,1]）", () => {
    expect(LP_WEIGHTS.novelty + LP_WEIGHTS.learnability + LP_WEIGHTS.empirical).toBeCloseTo(1, 9);
  });
});
