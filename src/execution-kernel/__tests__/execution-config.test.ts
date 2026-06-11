/**
 * execution-config 属性测试 — Task 1.2
 * P12 配置向后兼容：∀ mind 无 executionKernel ⟹ resolveExecutionConfig 深度等于默认且不改入参。
 * Validates: Requirements 7.1
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  resolveExecutionConfig,
  DEFAULT_EXECUTION_KERNEL,
  type MindExecReadLike,
} from "../index.js";

describe("execution-config · P12 配置向后兼容 (Req 7.1)", () => {
  it("缺省 mind（无 executionKernel）⟹ 深度等于 DEFAULT_EXECUTION_KERNEL", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (extra) => {
        const mind = { ...extra } as MindExecReadLike;
        delete (mind as Record<string, unknown>).executionKernel;
        const before = JSON.stringify(mind);
        const cfg = resolveExecutionConfig(mind);
        expect(cfg).toEqual(DEFAULT_EXECUTION_KERNEL);
        // 不改入参
        expect(JSON.stringify(mind)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });

  it("null/undefined ⟹ 返回默认深拷贝且互不共享引用", () => {
    const a = resolveExecutionConfig(null);
    const b = resolveExecutionConfig(undefined);
    expect(a).toEqual(DEFAULT_EXECUTION_KERNEL);
    expect(b).toEqual(DEFAULT_EXECUTION_KERNEL);
    a.enabledStages.perception = true;
    expect(DEFAULT_EXECUTION_KERNEL.enabledStages.perception).toBe(false);
  });

  it("提供 enforce 配置 ⟹ 规整透传", () => {
    const cfg = resolveExecutionConfig({
      executionKernel: {
        mode: "enforce",
        maxStepsHardCap: 50,
        stallBudget: 3,
        driftWindow: 2,
        enabledStages: { perception: true, continuation: true, definitionOfDone: true, strategy: true, metaControl: true },
      },
    });
    expect(cfg.mode).toBe("enforce");
    expect(cfg.maxStepsHardCap).toBe(50);
    expect(cfg.enabledStages.strategy).toBe(true);
  });

  it("非法数值 ⟹ 退回默认值", () => {
    const cfg = resolveExecutionConfig({
      executionKernel: {
        mode: "enforce",
        maxStepsHardCap: -5,
        stallBudget: 0,
        driftWindow: NaN as unknown as number,
        enabledStages: { perception: false, continuation: false, definitionOfDone: false, strategy: false, metaControl: false },
      },
    });
    expect(cfg.maxStepsHardCap).toBe(DEFAULT_EXECUTION_KERNEL.maxStepsHardCap);
    expect(cfg.stallBudget).toBe(DEFAULT_EXECUTION_KERNEL.stallBudget);
    expect(cfg.driftWindow).toBe(DEFAULT_EXECUTION_KERNEL.driftWindow);
  });
});
