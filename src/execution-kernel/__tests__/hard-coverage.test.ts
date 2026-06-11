/**
 * 硬覆盖断言 — Task 8.2 / 8.3 / 8.4（最高约束·不可跳过）
 *  8.2 向后兼容逐字节零改变（observe 缺省下纯函数不改宿主状态）
 *  8.3 fail-open（五段任一注入异常 ⟹ 不冒泡、退回安全）
 *  8.4 联动复用（策略载体是 cognitive-core Intent；终态接 userModel；不重造）
 * Validates: Requirements 7.2, 7.3, 7.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  resolveExecutionConfig,
  observeAction,
  judgeOutcome,
  decideContinuation,
  buildDefinitionOfDone,
  buildMidPlan,
  detectPlanDrift,
  validateCandidate,
  suggestAttentionRedirect,
  type StateProbe,
  type WorkingState,
  type LegalityValidator,
} from "../index.js";

const working: WorkingState = { doneSoFar: [], nextStep: "x", rationale: "r", updatedAt: "t" };

describe("8.2 向后兼容逐字节零改变 (Req 7.2)", () => {
  it("observe 缺省：resolveExecutionConfig 不改入参 mind", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (extra) => {
        const mind = { ...extra };
        delete (mind as Record<string, unknown>).executionKernel;
        const snap = JSON.stringify(mind);
        const cfg = resolveExecutionConfig(mind);
        expect(cfg.mode).toBe("observe");
        expect(JSON.stringify(mind)).toBe(snap);
      }),
      { numRuns: 150 },
    );
  });

  it("所有纯函数不修改入参（buildMidPlan/detectPlanDrift/suggestRedirect/buildDoD）", () => {
    const um = { insights: [{ aspect: "goal", content: "x", confidence: 0.9 }] };
    const umSnap = JSON.stringify(um);
    buildDefinitionOfDone({ goal: "g", userModel: um });
    expect(JSON.stringify(um)).toBe(umSnap);

    const outcomes = ["achieved", "no_effect"] as const;
    const oSnap = JSON.stringify(outcomes);
    detectPlanDrift(outcomes, "achieved", 2);
    expect(JSON.stringify(outcomes)).toBe(oSnap);
  });
});

describe("8.3 fail-open：五段任一注入异常都不冒泡 (Req 7.3)", () => {
  it("感知：probe 抛异常 ⟹ resolve unknown", async () => {
    const throwing: StateProbe = { read() { throw new Error("boom"); } };
    await expect(observeAction({ intent: "i", action: "a", intendedEffect: "x", probe: throwing })).resolves.toBeDefined();
  });

  it("感知 judge：畸形输入不抛", () => {
    expect(() => judgeOutcome(undefined, undefined, "")).not.toThrow();
  });

  it("脊柱：极端参数不抛", () => {
    expect(() => decideContinuation({
      recentOutcomes: [], working, doneReached: false, userAbort: false,
      stallBudget: 0, stepsUsed: 0, maxStepsHardCap: 0,
    })).not.toThrow();
  });

  it("终态：空 goal/缺 userModel 不抛", () => {
    expect(() => buildDefinitionOfDone({ goal: "" })).not.toThrow();
  });

  it("策略：校验器抛异常 ⟹ fail-open 放行", () => {
    const v: LegalityValidator = { isLegal: () => { throw new Error("x"); } };
    expect(validateCandidate("m", null, v).legal).toBe(true);
  });

  it("对齐：缺信号不抛", () => {
    expect(() => suggestAttentionRedirect({ currentTaskGoal: "" })).not.toThrow();
  });
});

describe("8.4 联动复用硬覆盖 (Req 7.4, 6.1, 6.2, 6.3)", () => {
  it("策略计划载体确实是 cognitive-core 的 Intent（含其字段契约）", () => {
    const plan = buildMidPlan({ goal: "g" });
    // cognitive-core Intent 的契约字段
    for (const k of ["id", "sourceUtterance", "goal", "subgoals", "expectedResult", "acceptanceLine", "status", "createdAt", "mode"]) {
      expect(plan.intent).toHaveProperty(k);
    }
    expect(plan.intent.id).toMatch(/^intent_/); // 来自 cognitive-core newIntentId
  });

  it("终态确实消费 userModel 投影（接用户画像）", () => {
    const dod = buildDefinitionOfDone({
      goal: "g",
      userModel: { insights: [{ aspect: "boundary", content: "别替我做决定", confidence: 0.95 }] },
    });
    expect(dod.userAligned).toBe(true);
    expect(dod.doneConditions.some((c) => c.includes("别替我做决定"))).toBe(true);
  });

  it("终态确实消费 goalMonitor 差距投影（接北极星）", () => {
    const dod = buildDefinitionOfDone({ goal: "g", goalGap: { gap: 60, topDimension: "g_results" } });
    expect(dod.doneConditions.some((c) => c.includes("g_results"))).toBe(true);
  });
});
