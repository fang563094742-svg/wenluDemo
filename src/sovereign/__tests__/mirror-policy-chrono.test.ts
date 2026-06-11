/**
 * 镜像/策略/时空 属性测试 — P3 非自评 / P4 精度→权重单调 / P6 红线 / 时空
 * Validates: Requirements 3.4, 3.6, 3.7, 5.3, 4.x
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeMirrorScore,
  mirrorToWeight,
  mirrorToBehaviorParams,
  detectGoalTension,
  settleShadowPrediction,
  sanitizePolicyDelta,
  applyPolicyDelta,
  isPolicyDeltaEndorsed,
  signatureToVerdictInput,
  chronoRetrievalBias,
  chronoToPersonaStance,
  DEFAULT_POLICY_WEIGHTS,
} from "../index.js";

describe("镜像 · P3 精度非自评 (Req 3.7)", () => {
  it("computeMirrorScore 只由 hits/settled/accepts/suggested 决定", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }),
        (hits, settled, accepts, suggested) => {
          const h = Math.min(hits, settled);
          const a = Math.min(accepts, suggested);
          const s = computeMirrorScore(h, settled, a, suggested);
          expect(s.accuracy).toBeGreaterThanOrEqual(0);
          expect(s.accuracy).toBeLessThanOrEqual(1);
          expect(s.composite).toBeGreaterThanOrEqual(0);
          expect(s.composite).toBeLessThanOrEqual(1);
          // settled=0 ⟹ accuracy=0（无结算不能凭空有精度）
          if (settled === 0) expect(s.accuracy).toBe(0);
          if (suggested === 0) expect(s.acceptRate).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("镜像 · P4 精度→权重单调不减 (Req 3.6)", () => {
  it("composite 越大 mirrorToWeight 越大（不减）", () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 1, noNaN: true }), fc.float({ min: 0, max: 1, noNaN: true }), (a, b) => {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const wLo = mirrorToWeight({ accuracy: lo, acceptRate: lo, composite: lo });
        const wHi = mirrorToWeight({ accuracy: hi, acceptRate: hi, composite: hi });
        expect(wHi).toBeGreaterThanOrEqual(wLo);
      }),
      { numRuns: 300 },
    );
  });
  it("精度越高 → 说话越有把握、代执行越敢、干预阈值越低", () => {
    const low = mirrorToBehaviorParams({ accuracy: 0.1, acceptRate: 0.1, composite: 0.1 });
    const high = mirrorToBehaviorParams({ accuracy: 0.9, acceptRate: 0.9, composite: 0.9 });
    expect(high.speechAssertiveness).toBeGreaterThan(low.speechAssertiveness);
    expect(high.actionBoldness).toBeGreaterThan(low.actionBoldness);
    expect(high.interveneThreshold).toBeLessThan(low.interveneThreshold);
  });
});

describe("镜像 · 目标张力 + 预测结算", () => {
  it("长期目标与近期行为背离 ⟹ tension=true", () => {
    const r = detectGoalTension("成为顶尖工程师", ["刷短视频", "睡懒觉"]);
    expect(r.tension).toBe(true);
  });
  it("对齐 ⟹ tension=false", () => {
    const r = detectGoalTension("成为顶尖工程师", ["写了工程项目代码"]);
    expect(r.tension).toBe(false);
  });
  it("预测命中结算", () => {
    expect(settleShadowPrediction({ predicted: "他会拒绝", actual: "他拒绝了这个方案" }).hit).toBe(true);
    expect(settleShadowPrediction({ predicted: "他会同意", actual: "完全无关的事" }).hit).toBe(false);
  });
});

describe("策略 · P6 policy-delta 红线 (Req 5.3)", () => {
  it("河床权重 >1.0 被钉回（铁律不可绕过）", () => {
    const { safe, rejected } = sanitizePolicyDelta({ weightAdjust: { riverbed: 5 }, reason: "想让河床夺权" });
    expect(safe.weightAdjust.riverbed).toBe(1.0);
    expect(rejected.some((r) => r.includes("河床"))).toBe(true);
  });
  it("非法信号源键被拒", () => {
    const { rejected } = sanitizePolicyDelta({ weightAdjust: { coreLoop: 9 } as never, reason: "x" });
    expect(rejected.some((r) => r.includes("非法"))).toBe(true);
  });
  it("缺 reason 被记拒", () => {
    const { rejected } = sanitizePolicyDelta({ weightAdjust: { mirror: 1.2 }, reason: "" });
    expect(rejected.some((r) => r.includes("reason"))).toBe(true);
  });
  it("applyPolicyDelta clamp 且不改入参", () => {
    const snap = JSON.stringify(DEFAULT_POLICY_WEIGHTS);
    const next = applyPolicyDelta(DEFAULT_POLICY_WEIGHTS, { weightAdjust: { mirror: 1.5 }, reason: "懂你了" });
    expect(next.mirror).toBe(1.5);
    expect(JSON.stringify(DEFAULT_POLICY_WEIGHTS)).toBe(snap);
  });
  it("现实背书：精度提升且无倒退 ⟹ 通过；倒退 ⟹ 拒绝", () => {
    expect(isPolicyDeltaEndorsed({ mirror: 0.4, results: 0.3 }, { mirror: 0.6, results: 0.3 })).toBe(true);
    expect(isPolicyDeltaEndorsed({ mirror: 0.6, results: 0.5 }, { mirror: 0.4, results: 0.5 })).toBe(false);
  });
});

describe("时空入主 (Req 4.x)", () => {
  const sig = (presence: string, scene: string, timeOfDay: string) => ({
    signatureId: "s", targetRef: { kind: "event" as const, id: "x" },
    temporal: { timeOfDay } as never, scene: scene as never, frontAppName: null,
    presence: presence as never, userAwayMinutes: 0, createdAt: "t",
  });
  it("签名缺失 ⟹ fail-open 低显著占位", () => {
    const v = signatureToVerdictInput(null);
    expect(v.salience).toBe(0);
    expect(v.presence).toBe("away");
  });
  it("在场+明确场景 ⟹ 高显著；离开 ⟹ 偏长期记忆", () => {
    const present = signatureToVerdictInput(sig("present", "coding", "morning"));
    const away = signatureToVerdictInput(sig("away", "idle", "night"));
    expect(present.salience).toBeGreaterThan(away.salience);
    expect(chronoRetrievalBias(present).recencyBoost).toBeGreaterThan(chronoRetrievalBias(away).recencyBoost);
    expect(chronoRetrievalBias(away).recencyBoost).toBeLessThan(0); // 离开偏长期
  });
  it("不同在场态 ⟹ 不同人格姿态", () => {
    const night = chronoToPersonaStance(signatureToVerdictInput(sig("present", "writing", "night")));
    const morning = chronoToPersonaStance(signatureToVerdictInput(sig("present", "writing", "morning")));
    const away = chronoToPersonaStance(signatureToVerdictInput(sig("away", "idle", "morning")));
    expect(night).not.toBe(morning);
    expect(away).toContain("克制");
  });
});
