/**
 * 宪法裁决属性测试 — P1 河床不夺权 / P2 裁决确定性 / P7 当下vs长期 / P11 干预有界
 * Validates: Requirements 2.3, 2.4, 7.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  adjudicate,
  enforceRiverbedBedrock,
  reconcileUserNowVsTrajectory,
  DEFAULT_POLICY_WEIGHTS,
  type SourceSignal,
  type SignalSource,
} from "../index.js";

const SOURCES: SignalSource[] = ["riverbed", "mirror", "chronotopic", "truthTier", "northStar", "userExplicit", "userTrajectory"];

function arbSignal(): fc.Arbitrary<SourceSignal> {
  return fc.record({
    source: fc.constantFrom(...SOURCES),
    stance: fc.string(),
    strength: fc.float({ min: 0, max: 1, noNaN: true }),
    canDrive: fc.boolean(),
  });
}

describe("宪法 · P1 河床不夺权 (Req 2.3, 7.5)", () => {
  it("enforceRiverbedBedrock 强制所有 riverbed 信号 canDrive=false", () => {
    fc.assert(
      fc.property(fc.array(arbSignal(), { maxLength: 8 }), (signals) => {
        const safe = enforceRiverbedBedrock(signals);
        for (const s of safe) {
          if (s.source === "riverbed") expect(s.canDrive).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("∀ signals：若 adopt=riverbed 则 drivingAllowed 恒 false", () => {
    fc.assert(
      fc.property(fc.array(arbSignal(), { minLength: 1, maxLength: 8 }), (signals) => {
        const v = adjudicate(signals, DEFAULT_POLICY_WEIGHTS);
        if (v.adopt === "riverbed") expect(v.drivingAllowed).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("具体：河床信号即使 canDrive=true 也不被允许驱动", () => {
    const signals: SourceSignal[] = [
      { source: "riverbed", stance: "该出手", strength: 1, canDrive: true },
    ];
    const v = adjudicate(signals, DEFAULT_POLICY_WEIGHTS);
    expect(v.adopt).toBe("riverbed");
    expect(v.drivingAllowed).toBe(false);
  });
});

describe("宪法 · P2 裁决确定性纯函数 (Req)", () => {
  it("∀ signals：多次 adjudicate 深度相等且不改入参", () => {
    fc.assert(
      fc.property(fc.array(arbSignal(), { minLength: 1, maxLength: 6 }), (signals) => {
        const snap = JSON.stringify(signals);
        const a = adjudicate(signals, DEFAULT_POLICY_WEIGHTS);
        const b = adjudicate(signals, DEFAULT_POLICY_WEIGHTS);
        expect(a).toEqual(b);
        expect(JSON.stringify(signals)).toBe(snap);
      }),
      { numRuns: 300 },
    );
  });
});

describe("宪法 · P11 干预强度有界 (Req)", () => {
  it("∀ signals：intervention ∈ 四态，drivingAllowed 仅 strong 且非河床", () => {
    fc.assert(
      fc.property(fc.array(arbSignal(), { minLength: 1, maxLength: 8 }), (signals) => {
        const v = adjudicate(signals, DEFAULT_POLICY_WEIGHTS);
        expect(["strong", "soft", "hold", "silent"]).toContain(v.intervention);
        if (v.drivingAllowed) {
          expect(v.intervention).toBe("strong");
          expect(v.adopt).not.toBe("riverbed");
        }
        expect(v.confidence).toBeGreaterThanOrEqual(0);
        expect(v.confidence).toBeLessThanOrEqual(1);
      }),
      { numRuns: 400 },
    );
  });
});

describe("宪法 · P7 用户当下 vs 长期 (Req 2.4)", () => {
  it("不恒采当下也不恒采长期：强当下表达胜出", () => {
    const r = reconcileUserNowVsTrajectory(
      { source: "userExplicit", stance: "现在就要", strength: 1, canDrive: false },
      { source: "userTrajectory", stance: "长期方向", strength: 0.2, canDrive: false },
      DEFAULT_POLICY_WEIGHTS,
    );
    expect(r.adopt).toBe("userExplicit");
  });
  it("长期权重高时不盲从当下", () => {
    const r = reconcileUserNowVsTrajectory(
      { source: "userExplicit", stance: "一时冲动", strength: 0.3, canDrive: false },
      { source: "userTrajectory", stance: "长期方向", strength: 0.9, canDrive: false },
      DEFAULT_POLICY_WEIGHTS,
    );
    expect(r.adopt).toBe("userTrajectory");
  });
  it("接近时偏向长期（不背叛长期）", () => {
    const r = reconcileUserNowVsTrajectory(
      { source: "userExplicit", stance: "x", strength: 0.7, canDrive: false },
      { source: "userTrajectory", stance: "y", strength: 0.7, canDrive: false },
      DEFAULT_POLICY_WEIGHTS,
    );
    expect(r.adopt).toBe("userTrajectory");
  });
});
