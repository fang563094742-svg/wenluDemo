// Feature: proactive-awareness-demo, Property 3: *For any* 带打分的候选条目集合与正整数 N，`selectTopN` 的结果长度 ≤ N，结果元素全部来自输入集合，且为按分数降序排列的前 N 个（不重复、不引入外来项）。
//
// **Validates: Requirements 3.4, 1.4**
//
// 本测试聚焦任务 4.4 的被测纯函数 `selectTopN(items, n)`（scanner/selectTopN.ts）。
// 策略：以「引用同一性」为底座检验四个不变量——
//  1. 长度 ≤ N（且正整数 N 时长度 = min(N, 输入数)）；
//  2. 结果元素全部来自输入集合（按引用判定，不引入外来项）；
//  3. 无重复（同一输入对象不被纳入多次，结果引用集合大小 = 结果长度）；
//  4. 「前 N 个」= 分数最高的 N 条：结果按 score 降序排列，且未入选项的分数 ≤ 入选项最小分。
// 另以「同输入 → 同输出」覆盖 R1.4 扫描产出确定性（纯函数语义）。
// 生成器特意让 score 取小范围整数以制造大量平分（ties），逼出「前 N 个」与稳定排序的边界行为。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { selectTopN } from "../../src/scanner/selectTopN.js";
import type { ScanSummaryItem } from "../../src/scanner/types.js";

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 单条带打分候选项。Property 3 仅关心 `score`，故只填充 kind + score（file/git/app
 * 均为可选）。fast-check 为数组每个元素生成全新对象实例，因此可用引用同一性判定
 * 「来自输入集合」与「无重复」。score 取小范围整数以高概率制造平分。
 */
const itemArb: fc.Arbitrary<ScanSummaryItem> = fc.record({
  kind: fc.constantFrom<"file" | "git" | "app">("file", "git", "app"),
  score: fc.integer({ min: -50, max: 50 }),
});

/** 候选集合（允许为空，覆盖边界）。 */
const itemsArb = fc.array(itemArb, { maxLength: 40 });

/** 正整数 N（Property 3 限定「正整数 N」）。 */
const positiveN = fc.integer({ min: 1, max: 50 });

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe("Property 3: Top N 精选正确性", () => {
  it("结果长度 ≤ N，且正整数 N 时长度 = min(N, 输入数)", () => {
    fc.assert(
      fc.property(itemsArb, positiveN, (items, n) => {
        const result = selectTopN(items, n);
        expect(result.length).toBeLessThanOrEqual(n);
        expect(result.length).toBe(Math.min(n, items.length));
      }),
      { numRuns: 100 },
    );
  });

  it("结果元素全部来自输入集合且无重复（按引用判定，不引入外来项）", () => {
    fc.assert(
      fc.property(itemsArb, positiveN, (items, n) => {
        const result = selectTopN(items, n);
        const inputRefs = new Set<ScanSummaryItem>(items);
        // 来自输入集合：每个结果项都是某个输入对象的同一引用。
        for (const r of result) {
          expect(inputRefs.has(r)).toBe(true);
        }
        // 无重复：结果中不存在重复引用 → 去重后大小不变。
        expect(new Set<ScanSummaryItem>(result).size).toBe(result.length);
      }),
      { numRuns: 100 },
    );
  });

  it("按 score 降序排列，且为分数最高的前 N 个（未入选项分数 ≤ 入选项最小分）", () => {
    fc.assert(
      fc.property(itemsArb, positiveN, (items, n) => {
        const result = selectTopN(items, n);

        // 降序：相邻项 score 非递增。
        for (let i = 1; i < result.length; i++) {
          expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
        }

        // 「前 N 个」= 最高分：任何未入选的输入项，其分数都 ≤ 入选项的最小分。
        if (result.length > 0) {
          const selected = new Set<ScanSummaryItem>(result);
          const minSelectedScore = Math.min(...result.map((r) => r.score));
          for (const item of items) {
            if (!selected.has(item)) {
              expect(item.score).toBeLessThanOrEqual(minSelectedScore);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("确定性：同输入 → 同输出（R1.4，纯函数且不修改入参）", () => {
    fc.assert(
      fc.property(itemsArb, positiveN, (items, n) => {
        const snapshot = [...items];
        const first = selectTopN(items, n);
        const second = selectTopN(items, n);
        // 两次调用结果逐项引用一致。
        expect(first.length).toBe(second.length);
        for (let i = 0; i < first.length; i++) {
          expect(first[i]).toBe(second[i]);
        }
        // 入参未被修改（顺序与引用均保持）。
        expect(items.length).toBe(snapshot.length);
        for (let i = 0; i < items.length; i++) {
          expect(items[i]).toBe(snapshot[i]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
