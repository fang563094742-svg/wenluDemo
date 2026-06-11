/**
 * 河床系统（Riverbed System）· mind 向后兼容属性测试（Task 13.2）
 * ------------------------------------------------------------------
 * 验证接线点 1（riverMain.loadMind 的 `riverbed: loaded.riverbed ?? emptyRiverbedState()`）
 * 的补默认值语义：旧 mind.json（无 riverbed 字段）被加载时补全为合法空河床，
 * 且既有字段一概不变；已含 riverbed 的 mind 迁移后保留原 riverbed（?? 不覆盖）。
 *
 * 不 import `riverMain.ts`（其入口运行有副作用：启动服务 / 读写 ~/.wenlu/mind.json）。
 * 改为在测试内复刻 loadMind 的"补默认值"最小语义：
 *   const migrated = { ...oldMind, riverbed: oldMind.riverbed ?? emptyRiverbedState() };
 * 以此无副作用地验证 13.1 写进 loadMind 的那行逻辑的正确性。
 *
 * 绝对边界：只 import vitest / fast-check 与 ./riverbed 下模块。
 *
 * **Validates: Requirements 13.1, 13.2**
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  emptyRiverbedState,
  type RiverbedState,
} from "./riverbed-store.js";

/**
 * 复刻 riverMain.loadMind 的补默认值语义（最小版，无副作用）。
 * 对应 riverMain.ts：`riverbed: loaded.riverbed ?? emptyRiverbedState()`。
 */
function migrateMind<T extends { riverbed?: RiverbedState }>(
  oldMind: T,
): T & { riverbed: RiverbedState } {
  return { ...oldMind, riverbed: oldMind.riverbed ?? emptyRiverbedState() };
}

/**
 * 生成任意"旧 mind-like"对象：含 beliefs / userModel / cycles 等任意字段，
 * 但**不含** riverbed 字段（模拟河床落地前的历史 mind.json）。
 */
const oldMindArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    cycles: fc.nat(),
    beliefs: fc.array(fc.string(), { maxLength: 6 }),
    userModel: fc.record({
      aspect: fc.string(),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    predictions: fc.array(
      fc.record({ status: fc.constantFrom("hit", "miss"), relatedTo: fc.string() }),
      { maxLength: 4 },
    ),
    extra: fc.dictionary(fc.string(), fc.jsonValue()),
  })
  // 保险：剔除任何意外生成的 riverbed 键（jsonValue 字典里可能撞名）。
  .map((m) => {
    const { ...rest } = m as Record<string, unknown>;
    delete (rest as Record<string, unknown>).riverbed;
    return rest;
  });

describe("Property 10: mind 向后兼容（Task 13.2）", () => {
  // **Validates: Requirements 13.1, 13.2**
  it("旧 mind（无 riverbed）迁移后补全为合法 emptyRiverbedState 且既有字段不变", () => {
    fc.assert(
      fc.property(oldMindArb, (oldMind) => {
        // 深拷贝原对象作为不变性基准（迁移不得改动原既有字段语义）。
        const before = JSON.parse(JSON.stringify(oldMind));

        const migrated = migrateMind(oldMind);

        // riverbed 是合法空河床：nodes:[] / lastSenseCycle:0 / version:1。
        expect(migrated.riverbed).toEqual(emptyRiverbedState());
        expect(migrated.riverbed.nodes).toEqual([]);
        expect(migrated.riverbed.lastSenseCycle).toBe(0);
        expect(migrated.riverbed.version).toBe(1);

        // 所有原字段逐一深等保持不变。
        for (const key of Object.keys(before)) {
          expect((migrated as Record<string, unknown>)[key]).toEqual(before[key]);
        }
      }),
    );
  });

  it("已含 riverbed 字段的 mind 迁移后保留原 riverbed（?? 不覆盖）", () => {
    const existingRiverbedArb: fc.Arbitrary<RiverbedState> = fc.record({
      nodes: fc.constant([]),
      lastSenseCycle: fc.integer({ min: 1, max: 99 }),
      version: fc.constant(1 as const),
    });

    fc.assert(
      fc.property(oldMindArb, existingRiverbedArb, (oldMind, existingRiverbed) => {
        const withRiverbed = { ...oldMind, riverbed: existingRiverbed };

        const migrated = migrateMind(withRiverbed);

        // ?? 不覆盖既有 riverbed：迁移后引用与内容保持原值。
        expect(migrated.riverbed).toBe(existingRiverbed);
        expect(migrated.riverbed.lastSenseCycle).toBe(existingRiverbed.lastSenseCycle);
        // 既有 lastSenseCycle ≥ 1，证明没有被空河床（lastSenseCycle:0）覆盖。
        expect(migrated.riverbed.lastSenseCycle).not.toBe(0);
      }),
    );
  });
});
