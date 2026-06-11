/**
 * StrategyKernel 属性测试 — Task 5.2
 * P9 计划载体复用（MovePlan.intent 是 cognitive-core Intent）；P10 背离仅发信号（无副作用）。
 * Validates: Requirements 4.2, 4.4, 4.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildMidPlan,
  detectPlanDrift,
  validateCandidate,
  type ActionOutcome,
  type RiverbedJudgmentReadLike,
  type LegalityValidator,
} from "../index.js";
import { isValidDag } from "../../cognitive-core/index.js";

describe("StrategyKernel · P9 计划载体复用 cognitive-core Intent (Req 4.2)", () => {
  it("buildMidPlan 产出合法 Intent（含 id/goal/subgoals/status/mode）且 subgoals 是 DAG", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (goal) => {
        const plan = buildMidPlan({ goal });
        expect(plan.intent.id).toMatch(/^intent_/);
        expect(plan.intent.status).toBe("planned");
        expect(plan.intent.mode).toBe("enforce");
        expect(Array.isArray(plan.intent.subgoals)).toBe(true);
        expect(plan.intent.subgoals.length).toBeGreaterThan(0);
        expect(isValidDag(plan.intent.subgoals)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("提供河床判断 ⟹ 据显著域分解子目标且仍是 DAG", () => {
    const judgment: RiverbedJudgmentReadLike = {
      summary: "技术与执行域最显著",
      topDomains: [
        { domain: "execution", salience: 0.9 },
        { domain: "tech", salience: 0.7 },
        { domain: "relationship", salience: 0.3 },
      ],
    };
    const plan = buildMidPlan({ goal: "推进项目", judgment });
    expect(plan.intent.subgoals.length).toBeGreaterThanOrEqual(2);
    expect(isValidDag(plan.intent.subgoals)).toBe(true);
    expect(plan.rationale).toContain("河床");
  });
});

describe("StrategyKernel · P10 背离仅发信号 (Req 4.4, 4.5)", () => {
  it("连续 driftWindow 步全偏离 ⟹ drift=true", () => {
    const r = detectPlanDrift(["no_effect", "wrong_effect", "unknown"], "achieved", 3);
    expect(r.drift).toBe(true);
  });

  it("窗口内有命中预期 ⟹ drift=false", () => {
    const r = detectPlanDrift(["no_effect", "achieved", "no_effect"], "achieved", 3);
    expect(r.drift).toBe(false);
  });

  it("步数不足窗口 ⟹ drift=false", () => {
    expect(detectPlanDrift(["no_effect"], "achieved", 3).drift).toBe(false);
  });

  it("detectPlanDrift 无副作用（不改入参数组）", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ActionOutcome>("achieved", "no_effect", "wrong_effect", "unknown"), { maxLength: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (outcomes, w) => {
          const snapshot = JSON.stringify(outcomes);
          detectPlanDrift(outcomes, "achieved", w);
          expect(JSON.stringify(outcomes)).toBe(snapshot);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("StrategyKernel · validateCandidate 领域校验钩子 (Req 4.6)", () => {
  it("无校验器 ⟹ 放行且标注未校验", () => {
    const r = validateCandidate("e2e4", null);
    expect(r.legal).toBe(true);
    expect(r.reason).toContain("not checked");
  });

  it("注入校验器 ⟹ 用其判定", () => {
    const validator: LegalityValidator = { isLegal: (c) => c === "e2e4" };
    expect(validateCandidate("e2e4", null, validator).legal).toBe(true);
    expect(validateCandidate("e2e9", null, validator).legal).toBe(false);
  });

  it("校验器抛异常 ⟹ fail-open 放行", () => {
    const validator: LegalityValidator = { isLegal: () => { throw new Error("x"); } };
    expect(validateCandidate("e2e4", null, validator).legal).toBe(true);
  });
});
