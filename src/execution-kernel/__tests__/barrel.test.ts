/**
 * barrel 导出契约测试 — Task 7.2
 * 断言 index.ts 导出预期公共符号。
 * Validates: Requirements 6.7
 */
import { describe, it, expect } from "vitest";
import * as EK from "../index.js";

describe("execution-kernel barrel 导出契约 (Req 6.7)", () => {
  it("导出全部预期公共值符号", () => {
    const expected = [
      "DEFAULT_EXECUTION_KERNEL", "resolveExecutionConfig",
      "newStepId", "newPlanId",
      "PerceptionLoop", "observeAction", "judgeOutcome", "probeState",
      "ContinuationKernel", "decideContinuation", "isLegitimateWait",
      "buildDefinitionOfDone", "remainingToDone",
      "StrategyKernel", "buildMidPlan", "detectPlanDrift", "validateCandidate",
      "MetaControl", "suggestAttentionRedirect",
    ];
    for (const name of expected) {
      expect(EK).toHaveProperty(name);
      expect((EK as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("默认配置为 observe 且全 stage false（缺省零改变）", () => {
    expect(EK.DEFAULT_EXECUTION_KERNEL.mode).toBe("observe");
    expect(Object.values(EK.DEFAULT_EXECUTION_KERNEL.enabledStages).every((v) => v === false)).toBe(true);
  });
});
