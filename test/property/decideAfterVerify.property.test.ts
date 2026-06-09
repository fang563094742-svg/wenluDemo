// Feature: proactive-awareness-demo, Property 26: For any 验收测试结果集合 `results`，`decideAfterVerify(results)` 返回 `"delivered"` 当且仅当 `results` 非空且其中每一条 `passed` 均为 true；否则（空集合，或存在任一 `failed`）返回 `"retry_or_block"`。即任务进入待验收（delivered）的充要条件是"存在且全部验收测试通过"。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decideAfterVerify,
  type AcceptanceTestResult,
} from "../../src/delivery/decideAfterVerify.js";

/**
 * Property 26: 验收门裁决（安全关键）
 *
 * Validates: Requirements 12.5, 15.1
 *
 * 充要条件：`decideAfterVerify(results) === "delivered"` 当且仅当
 * `results` 非空且每条 `passed` 均为 true；其余情况（空集合 / 存在任一 failed）
 * 均返回 `"retry_or_block"`。
 */

/** 生成单条验收测试结果；passed 由参数控制，其余字段任意。 */
const resultArb = (passed?: boolean): fc.Arbitrary<AcceptanceTestResult> =>
  fc.record({
    testId: fc.string(),
    description: fc.string(),
    checkMethod: fc.string(),
    passed: passed === undefined ? fc.boolean() : fc.constant(passed),
    detail: fc.string(),
  });

describe("Property 26: 验收门裁决", () => {
  it("delivered 当且仅当 results 非空且每条 passed 均为 true（充要条件对照参考实现）", () => {
    fc.assert(
      fc.property(fc.array(resultArb()), (results) => {
        const expected =
          results.length > 0 && results.every((r) => r.passed)
            ? "delivered"
            : "retry_or_block";
        expect(decideAfterVerify(results)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("非空且全部 passed=true → delivered（充分性方向）", () => {
    fc.assert(
      fc.property(
        fc.array(resultArb(true), { minLength: 1 }),
        (results) => {
          expect(decideAfterVerify(results)).toBe("delivered");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("含任一 passed=false → retry_or_block（必要性方向）", () => {
    fc.assert(
      fc.property(
        fc.array(resultArb()),
        resultArb(false),
        fc.array(resultArb()),
        (before, failing, after) => {
          // 结果集合中至少嵌入一条 failed，无论其余如何均应裁为 retry_or_block
          const results = [...before, failing, ...after];
          expect(decideAfterVerify(results)).toBe("retry_or_block");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("空集合 → retry_or_block（不得默认放行）", () => {
    expect(decideAfterVerify([])).toBe("retry_or_block");
  });
});
