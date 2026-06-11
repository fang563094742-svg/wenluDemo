// Feature: 新颖度引擎 —— 用 property-based 测试证明「尺子本身正确」。
// 证明：重复行为新颖度趋零、全新行为新颖度高、奖励系数正确翻转激励、能力阶梯单调。
// 边界：property 只证明尺子的数学性质，不证明被测对象会真去探索（后者由 riverMain 接线层保证）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  jaccard,
  noveltyScore,
  isRepetitive,
  noveltyRewardFactor,
  meetsDifficultyLadder,
  NOVELTY_REJECT_THRESHOLD,
  type BehaviorFingerprint,
} from "../../src/judgment/novelty.js";

const text = () => fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);
const fp = (): fc.Arbitrary<BehaviorFingerprint> =>
  fc.record({ desc: text(), domain: fc.option(fc.string(), { nil: undefined }) });

describe("新颖度引擎：尺子正确性（property）", () => {
  it("noveltyScore ∈ [0,1]，空档案恒为 1（第一次做任何事都新）", () => {
    fc.assert(
      fc.property(text(), (c) => {
        expect(noveltyScore(c, [])).toBe(1);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(text(), fc.array(fp()), (c, arch) => {
        const n = noveltyScore(c, arch);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it("重复行为新颖度趋零：候选与档案中某条完全相同（含语义锚）→ 新颖度 0（被判重复）", () => {
    // 带语义锚的内容（英文标识符/中文概念），排除纯标点这类无语义内容。
    const meaningful = fc.oneof(
      fc.constantFrom("payment-config 8899 失效", "tokio async 并发模型", "屏幕 OCR 截图眼睛", "端口 3210 可达验证"),
      fc.string({ minLength: 3, maxLength: 30 }).filter((s) => /[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/i.test(s)),
    );
    fc.assert(
      fc.property(meaningful, fc.array(fp()), (dup, rest) => {
        const archive = [...rest, { desc: dup }];
        // 候选与档案里某条逐字相同（且有语义锚）→ 覆盖度=1 → 新颖度=0。
        expect(noveltyScore(dup, archive)).toBe(0);
        expect(isRepetitive(dup, archive)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("单调性：往档案里加更多条目，新颖度只会降不会升（见过越多越不新）", () => {
    fc.assert(
      fc.property(text(), fc.array(fp(), { minLength: 1 }), fp(), (c, base, extra) => {
        const before = noveltyScore(c, base);
        const after = noveltyScore(c, [...base, extra]);
        expect(after).toBeLessThanOrEqual(before + 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("奖励系数翻转激励：重复(<阈值)系数<0.2，全新(=1)系数=1.5，且单调不减", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(noveltyRewardFactor(hi)).toBeGreaterThanOrEqual(noveltyRewardFactor(lo) - 1e-9);
        },
      ),
      { numRuns: 200 },
    );
    expect(noveltyRewardFactor(1)).toBeCloseTo(1.5, 6);
    expect(noveltyRewardFactor(0)).toBe(0);
    // 重复区任意点系数 ≤ 0.2（舒适区饿死；边界 n→阈值 时趋近 0.2）。
    fc.assert(
      fc.property(fc.double({ min: 0, max: NOVELTY_REJECT_THRESHOLD - 1e-6, noNaN: true }), (n) => {
        expect(noveltyRewardFactor(n)).toBeLessThanOrEqual(0.2);
      }),
      { numRuns: 100 },
    );
  });

  it("能力阶梯门：空历史恒放行；非空时难度≥峰值×0.8 才放行", () => {
    expect(meetsDifficultyLadder(1, [])).toBe(true);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1 }),
        (cand, cleared) => {
          const peak = Math.max(...cleared);
          expect(meetsDifficultyLadder(cand, cleared)).toBe(cand >= peak * 0.8);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("jaccard：自反=1，对称，∈[0,1]", () => {
    fc.assert(
      fc.property(text(), text(), (a, b) => {
        expect(jaccard(a, a)).toBe(1);
        expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a), 9);
        const j = jaccard(a, b);
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});
