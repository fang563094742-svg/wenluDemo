import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { clamp01 } from "./riverbed-util.js";

describe("clamp01", () => {
  it("把 NaN 归一到 0", () => {
    expect(clamp01(NaN)).toBe(0);
  });

  it("把负数归一到 0", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-9999)).toBe(0);
  });

  it("把大于 1 的值归一到 1", () => {
    expect(clamp01(1.2)).toBe(1);
    expect(clamp01(9999)).toBe(1);
  });

  it("保留 [0,1] 区间内的值", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
  });

  it("把非有限值（Infinity / -Infinity）归一到 0", () => {
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it("对任意数值输出恒落在 [0,1] 区间（属性）", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double(),
          fc.double({ min: -1e6, max: 1e6 }),
          fc.constantFrom(NaN, Infinity, -Infinity),
        ),
        (value) => {
          const out = clamp01(value);
          return out >= 0 && out <= 1;
        },
      ),
    );
  });
});
