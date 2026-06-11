/**
 * ContinuationKernel 属性测试 — Task 3.2
 * P4 合法等待不计空转、P5 终止条件正确、P6 不自转（wait 必带 WakeCondition）。
 * Validates: Requirements 2.2, 2.4, 2.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decideContinuation,
  isLegitimateWait,
  type ActionOutcome,
  type WorkingState,
  type WakeCondition,
} from "../index.js";

const working: WorkingState = { doneSoFar: [], nextStep: "x", rationale: "r", updatedAt: "t" };
const wake: WakeCondition = { kind: "opponent_moved", spec: {}, describe: "等对手落子" };

describe("ContinuationKernel · P4 合法等待不计空转 (Req 2.5)", () => {
  it("waiting + 绑定 WakeCondition ⟹ isLegitimateWait=true", () => {
    expect(isLegitimateWait("waiting", wake)).toBe(true);
  });
  it("waiting 无 WakeCondition ⟹ false", () => {
    expect(isLegitimateWait("waiting", undefined)).toBe(false);
  });
  it("非 waiting ⟹ false", () => {
    expect(isLegitimateWait("running", wake)).toBe(false);
  });
});

describe("ContinuationKernel · P5 终止条件正确 (Req 2.4)", () => {
  it("userAbort 优先于一切 ⟹ abort", () => {
    const d = decideContinuation({
      recentOutcomes: ["achieved"], working, doneReached: true, pendingWake: wake,
      userAbort: true, stallBudget: 6, stepsUsed: 1, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("abort");
  });

  it("doneReached ⟹ complete", () => {
    const d = decideContinuation({
      recentOutcomes: ["achieved"], working, doneReached: true,
      userAbort: false, stallBudget: 6, stepsUsed: 1, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("complete");
  });

  it("超过硬上限 ⟹ stop_loss", () => {
    const d = decideContinuation({
      recentOutcomes: ["achieved"], working, doneReached: false,
      userAbort: false, stallBudget: 6, stepsUsed: 200, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("stop_loss");
  });

  it("连续低产步达预算 ⟹ stop_loss", () => {
    const d = decideContinuation({
      recentOutcomes: ["no_effect", "unknown", "no_effect"], working, doneReached: false,
      userAbort: false, stallBudget: 3, stepsUsed: 3, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("stop_loss");
  });

  it("正常推进 ⟹ continue", () => {
    const d = decideContinuation({
      recentOutcomes: ["achieved", "achieved"], working, doneReached: false,
      userAbort: false, stallBudget: 6, stepsUsed: 2, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("continue");
  });

  it("∀ 序列：非 continue/wait 的终态仅在 done/止损/abort 之一成立时出现", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ActionOutcome>("achieved", "no_effect", "wrong_effect", "unknown"), { maxLength: 10 }),
        fc.boolean(), fc.boolean(),
        fc.integer({ min: 0, max: 250 }),
        (outcomes, doneReached, userAbort, steps) => {
          const d = decideContinuation({
            recentOutcomes: outcomes, working, doneReached,
            userAbort, stallBudget: 6, stepsUsed: steps, maxStepsHardCap: 200,
          });
          if (d.next === "complete") expect(doneReached || userAbort).toBe(true);
          if (d.next === "abort") expect(userAbort).toBe(true);
          if (d.next === "stop_loss") {
            const lowTail = (() => { let c = 0; for (let i = outcomes.length - 1; i >= 0; i--) { if (outcomes[i] === "no_effect" || outcomes[i] === "unknown") c++; else break; } return c; })();
            expect(steps >= 200 || lowTail >= 6).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("ContinuationKernel · P6 不自转 (Req 2.2)", () => {
  it("wait 必带 WakeCondition", () => {
    const d = decideContinuation({
      recentOutcomes: ["achieved"], working, doneReached: false, pendingWake: wake,
      userAbort: false, stallBudget: 6, stepsUsed: 1, maxStepsHardCap: 200,
    });
    expect(d.next).toBe("wait");
    expect(d.wake).toBeDefined();
    expect(d.wake?.describe).toBeTruthy();
  });

  it("无 pendingWake ⟹ 永不产出 wait", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ActionOutcome>("achieved", "no_effect", "wrong_effect", "unknown"), { maxLength: 8 }),
        fc.integer({ min: 0, max: 50 }),
        (outcomes, steps) => {
          const d = decideContinuation({
            recentOutcomes: outcomes, working, doneReached: false,
            userAbort: false, stallBudget: 6, stepsUsed: steps, maxStepsHardCap: 200,
          });
          expect(d.next).not.toBe("wait");
        },
      ),
      { numRuns: 200 },
    );
  });
});
