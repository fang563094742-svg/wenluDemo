/**
 * 时空校准层 · 时间维度纯函数测试（chronotopic-time.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 1.2（Property 7：temporal 维度值域封闭，fast-check）与
 * 任务 1.3（ageMs 单元测试）。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-time.js。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { deriveTemporalDimension, ageMs, type TimeOfDay } from "./chronotopic-time.js";

describe("deriveTemporalDimension（Property 7：temporal 维度值域封闭）", () => {
  // **Validates: Requirements 1.1, 1.2, 1.3**
  it("对任意 atMs≥0 与任意 tzOffsetMinutes，hourOfDay∈[0,23]、dayOfWeek∈[0,6]", () => {
    fc.assert(
      fc.property(
        // atMs ≥ 0（毫秒戳），覆盖到约公元 5138 年的范围
        fc.integer({ min: 0, max: 1e14 }),
        // 任意时区偏移（分钟），含极端值
        fc.integer({ min: -1440, max: 1440 }),
        (atMs, tzOffsetMinutes) => {
          const dim = deriveTemporalDimension(atMs, tzOffsetMinutes);

          expect(Number.isInteger(dim.hourOfDay)).toBe(true);
          expect(dim.hourOfDay).toBeGreaterThanOrEqual(0);
          expect(dim.hourOfDay).toBeLessThanOrEqual(23);

          expect(Number.isInteger(dim.dayOfWeek)).toBe(true);
          expect(dim.dayOfWeek).toBeGreaterThanOrEqual(0);
          expect(dim.dayOfWeek).toBeLessThanOrEqual(6);

          // isWeekend 与 dayOfWeek 自洽
          expect(dim.isWeekend).toBe(dim.dayOfWeek === 0 || dim.dayOfWeek === 6);
        },
      ),
    );
  });

  // **Validates: Requirements 1.2**
  it("同 (atMs, tz) 两次调用结果完全相同（确定性）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e14 }),
        fc.integer({ min: -1440, max: 1440 }),
        (atMs, tzOffsetMinutes) => {
          const a = deriveTemporalDimension(atMs, tzOffsetMinutes);
          const b = deriveTemporalDimension(atMs, tzOffsetMinutes);
          expect(a).toEqual(b);
        },
      ),
    );
  });

  // **Validates: Requirements 1.2, 1.3**
  it("同 hourOfDay 恒映射同 timeOfDay（时段划分仅由 hourOfDay 决定）", () => {
    // 收集每个 hourOfDay 首次出现的 timeOfDay，断言后续出现一致
    const seen = new Map<number, TimeOfDay>();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e14 }),
        fc.integer({ min: -1440, max: 1440 }),
        (atMs, tzOffsetMinutes) => {
          const dim = deriveTemporalDimension(atMs, tzOffsetMinutes);
          const prev = seen.get(dim.hourOfDay);
          if (prev === undefined) {
            seen.set(dim.hourOfDay, dim.timeOfDay);
          } else {
            expect(dim.timeOfDay).toBe(prev);
          }
        },
      ),
    );
  });
});

describe("ageMs（任务 1.3 单元测试）", () => {
  // _Requirements: 1.4_
  it("未来事件（targetMs > nowMs）返回 0", () => {
    expect(ageMs(2_000, 1_000)).toBe(0);
    expect(ageMs(1_000_000, 0)).toBe(0);
  });

  it("targetMs 与 nowMs 相等返回 0", () => {
    expect(ageMs(1_000, 1_000)).toBe(0);
    expect(ageMs(0, 0)).toBe(0);
  });

  it("过去事件返回正差值", () => {
    expect(ageMs(1_000, 5_000)).toBe(4_000);
    expect(ageMs(0, 86_400_000)).toBe(86_400_000);
  });
});
