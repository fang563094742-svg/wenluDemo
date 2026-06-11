// Feature: 元认知自我模型 —— property 测试证明「尺子本身正确」。
// 证明：自校准与 Brier 同源、偏差校正方向正确、可学习性在 0.5 处取峰、选题取最高 LP。
// 边界：只证明尺子数学性质，不证明被测对象真会自知（由 riverMain 接线层保证）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  competenceCalibration,
  selfKnowledgeScore,
  calibratedCompetence,
  learnabilityScore,
  pickMostLearnable,
  type SelfCompetenceRecord,
} from "../../src/judgment/selfModel.js";

const prob = () => fc.double({ min: 0, max: 1, noNaN: true });
const rec = (): fc.Arbitrary<SelfCompetenceRecord> =>
  fc.record({ estimatedCompetence: prob(), succeeded: fc.boolean() });

describe("元认知自我模型：尺子正确性（property）", () => {
  it("样本不足(<minSample)恒返回 null（不下结论）", () => {
    fc.assert(
      fc.property(fc.array(rec(), { maxLength: 2 }), (rs) => {
        expect(competenceCalibration(rs, 3)).toBeNull();
        expect(selfKnowledgeScore(rs, 3)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("bias 符号正确：全部高估(估1却失败)→bias>0；全部低估(估0却成功)→bias<0", () => {
    const overconfident: SelfCompetenceRecord[] = Array.from({ length: 5 }, () => ({ estimatedCompetence: 1, succeeded: false }));
    const underconfident: SelfCompetenceRecord[] = Array.from({ length: 5 }, () => ({ estimatedCompetence: 0, succeeded: true }));
    expect(competenceCalibration(overconfident)!.bias).toBeGreaterThan(0);
    expect(competenceCalibration(underconfident)!.bias).toBeLessThan(0);
    // 完美校准：估1且成功 → brier=0 → 自知分=100。
    const perfect: SelfCompetenceRecord[] = Array.from({ length: 5 }, () => ({ estimatedCompetence: 1, succeeded: true }));
    expect(selfKnowledgeScore(perfect)).toBe(100);
  });

  it("偏差校正方向正确：历史高估 → 校正后下压；历史低估 → 校正后上提", () => {
    const overconfident: SelfCompetenceRecord[] = Array.from({ length: 5 }, () => ({ estimatedCompetence: 0.9, succeeded: false }));
    const underconfident: SelfCompetenceRecord[] = Array.from({ length: 5 }, () => ({ estimatedCompetence: 0.1, succeeded: true }));
    fc.assert(
      fc.property(prob(), (raw) => {
        // 历史高估 → 校正值 ≤ 原值；历史低估 → 校正值 ≥ 原值。
        expect(calibratedCompetence(raw, overconfident)).toBeLessThanOrEqual(raw + 1e-9);
        expect(calibratedCompetence(raw, underconfident)).toBeGreaterThanOrEqual(raw - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("校正结果恒在 [0,1]；样本不足时原样返回", () => {
    fc.assert(
      fc.property(prob(), fc.array(rec(), { maxLength: 2 }), (raw, few) => {
        expect(calibratedCompetence(raw, few)).toBeCloseTo(Math.min(1, Math.max(0, raw)), 9);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(prob(), fc.array(rec()), (raw, rs) => {
        const c = calibratedCompetence(raw, rs);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it("可学习性在 0.5 处取峰，对称，端点为 0（ZPD 甜区）", () => {
    expect(learnabilityScore(0.5)).toBe(1);
    expect(learnabilityScore(0)).toBe(0);
    expect(learnabilityScore(1)).toBe(0);
    fc.assert(
      fc.property(prob(), (p) => {
        expect(learnabilityScore(p)).toBeCloseTo(learnabilityScore(1 - p), 6);
        // 越靠近 0.5 越高（与端点比）。
        expect(learnabilityScore(0.5)).toBeGreaterThanOrEqual(learnabilityScore(p) - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("pickMostLearnable：选出的候选其可学习性 ≥ 所有候选（取最高 LP）", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string({ minLength: 1 }), rawCompetence: prob() }), { minLength: 1, maxLength: 12 }),
        fc.array(rec()),
        (cands, records) => {
          const best = pickMostLearnable(cands, records)!;
          for (const c of cands) {
            const cc = calibratedCompetence(c.rawCompetence, records);
            expect(best.learnability).toBeGreaterThanOrEqual(learnabilityScore(cc) - 1e-9);
          }
        },
      ),
      { numRuns: 200 },
    );
    expect(pickMostLearnable([], [])).toBeNull();
  });
});
