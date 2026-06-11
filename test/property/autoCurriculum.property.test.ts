// Feature: 自动课程引擎 —— property 测试证明「飞轮总调度决策正确」。
// 证明：课程分∈[0,1]且对各分量单调、选题取最高分、停滞触发跳新疆域、空候选 null。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  curriculumScore,
  planNextChallenge,
  CURRICULUM_WEIGHTS,
  type CurriculumCandidate,
} from "../../src/judgment/autoCurriculum.js";

const prob = () => fc.double({ min: 0, max: 1, noNaN: true });
const cand = (): fc.Arbitrary<CurriculumCandidate> =>
  fc.record({
    domain: fc.constantFrom("web", "file", "code", "gui", "data"),
    difficulty: fc.integer({ min: 1, max: 5 }),
    competence: prob(),
    learningProgress: prob(),
    isEmptyCell: fc.boolean(),
  });

describe("自动课程引擎：飞轮总调度（property）", () => {
  it("课程分 ∈ [0,1]", () => {
    fc.assert(
      fc.property(cand(), (c) => {
        const s = curriculumScore(c);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it("对学习进度单调不减：其余不变，LP 越高课程分越高", () => {
    fc.assert(
      fc.property(prob(), prob(), prob(), fc.boolean(), fc.integer({ min: 1, max: 5 }), (l1, l2, comp, empty, diff) => {
        const [lo, hi] = l1 <= l2 ? [l1, l2] : [l2, l1];
        const base = { domain: "web", difficulty: diff, competence: comp, isEmptyCell: empty };
        expect(curriculumScore({ ...base, learningProgress: hi })).toBeGreaterThanOrEqual(
          curriculumScore({ ...base, learningProgress: lo }) - 1e-9,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("填空格红利：其余不变，isEmptyCell=true 的课程分 ≥ false", () => {
    fc.assert(
      fc.property(prob(), prob(), fc.integer({ min: 1, max: 5 }), (comp, lp, diff) => {
        const base = { domain: "web", difficulty: diff, competence: comp, learningProgress: lp };
        expect(curriculumScore({ ...base, isEmptyCell: true })).toBeGreaterThanOrEqual(
          curriculumScore({ ...base, isEmptyCell: false }) - 1e-9,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("ZPD：胜任度0.5的课程分 ≥ 胜任度0或1（踮脚够得着主导）", () => {
    fc.assert(
      fc.property(prob(), fc.boolean(), fc.integer({ min: 1, max: 5 }), (lp, empty, diff) => {
        const base = { domain: "web", difficulty: diff, learningProgress: lp, isEmptyCell: empty };
        const mid = curriculumScore({ ...base, competence: 0.5 });
        expect(mid).toBeGreaterThanOrEqual(curriculumScore({ ...base, competence: 0 }) - 1e-9);
        expect(mid).toBeGreaterThanOrEqual(curriculumScore({ ...base, competence: 1 }) - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("planNextChallenge：非停滞时选最高课程分的候选；空集 null", () => {
    expect(planNextChallenge([])).toBeNull();
    fc.assert(
      fc.property(fc.array(cand(), { minLength: 1, maxLength: 15 }), (cs) => {
        const dir = planNextChallenge(cs, 0)!; // floor=0 → 永不判停滞，纯取最高分
        const maxScore = Math.max(...cs.map(curriculumScore));
        expect(dir.score).toBeCloseTo(+maxScore.toFixed(4), 4);
      }),
      { numRuns: 200 },
    );
  });

  it("停滞触发跳新疆域：全部低分(<floor)时，指令指向一个空格方向（若存在）", () => {
    const lowAllEmpty: CurriculumCandidate[] = [
      { domain: "web", difficulty: 1, competence: 0.98, learningProgress: 0.02, isEmptyCell: true },
      { domain: "code", difficulty: 5, competence: 0.02, learningProgress: 0.01, isEmptyCell: true },
    ];
    const dir = planNextChallenge(lowAllEmpty, 0.5)!;
    expect(dir.fillsEmptyCell).toBe(true);
    expect(dir.rationale).toContain("跳新疆域");
  });

  it("权重和为 1（课程分是凸组合，保证 ∈[0,1]）", () => {
    expect(
      CURRICULUM_WEIGHTS.learnability + CURRICULUM_WEIGHTS.learningProgress + CURRICULUM_WEIGHTS.emptyCellBonus,
    ).toBeCloseTo(1, 9);
  });
});
