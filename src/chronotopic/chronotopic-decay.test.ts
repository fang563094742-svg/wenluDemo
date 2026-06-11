/**
 * 时空校准层 · 时间衰减与三信号融合属性测试（chronotopic-decay.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 9.2（Property 8：时间衰减值域与边界）、9.3（Property 9：衰减对 age
 * 单调非增）、9.4（Property 10：三信号融合单调性）、9.5（Property 11：三信号
 * 重排是排列且稳定）。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-decay.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  temporalDecay,
  fuseTriSignal,
  rankByTriSignal,
  DEFAULT_TRI_SIGNAL_WEIGHTS,
  type TriSignalInput,
  type TriSignalWeights,
} from "./chronotopic-decay.js";

/** 任意有效 age（毫秒，≥ 0）。 */
const ageArb = fc.double({ min: 0, max: 1_000 * 365 * 86_400_000, noNaN: true });
/** 任意有效半衰期（毫秒，> 0）。 */
const halfLifeArb = fc.double({ min: 1, max: 365 * 86_400_000, noNaN: true });
/** 任意信号分量（含越界 / NaN，验证 clamp01 防护）。 */
const signalArb = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.double({ min: -100, max: 100, noNaN: true }),
  fc.constantFrom(NaN, Infinity, -Infinity, 0, 1, -0.5, 1.5),
);
/** 任意非负权重。 */
const nonNegWeightArb = fc.double({ min: 0, max: 10, noNaN: true });

describe("temporalDecay（Property 8：时间衰减值域与边界）", () => {
  // **Validates: Requirements 6.1, 6.2, 6.3**
  it("任意 age≥0 且 halfLifeMs>0：返回值 ∈ (0,1]", () => {
    fc.assert(
      fc.property(ageArb, halfLifeArb, (age, halfLifeMs) => {
        const out = temporalDecay(age, { halfLifeMs });
        expect(Number.isNaN(out)).toBe(false);
        expect(out).toBeGreaterThan(0);
        expect(out).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("age=0 恒返回 1", () => {
    fc.assert(
      fc.property(halfLifeArb, (halfLifeMs) => {
        expect(temporalDecay(0, { halfLifeMs })).toBe(1);
      }),
    );
  });

  it("age=halfLifeMs 在容差内返回 0.5", () => {
    fc.assert(
      fc.property(halfLifeArb, (halfLifeMs) => {
        expect(temporalDecay(halfLifeMs, { halfLifeMs })).toBeCloseTo(0.5, 10);
      }),
    );
  });
});

describe("temporalDecay（Property 9：对 age 单调非增）", () => {
  // **Validates: Requirements 6.4**
  it("固定 halfLifeMs，a ≤ b ⇒ temporalDecay(a) ≥ temporalDecay(b)", () => {
    fc.assert(
      fc.property(halfLifeArb, ageArb, ageArb, (halfLifeMs, x, y) => {
        const a = Math.min(x, y);
        const b = Math.max(x, y);
        const da = temporalDecay(a, { halfLifeMs });
        const db = temporalDecay(b, { halfLifeMs });
        // 容差 1e-9（工程稳健）而非 1e-12（理论紧）：a/halfLife 的除法是 IEEE 正确舍入
        // 因而单调，但 Math.pow(2, x) 在 ECMAScript 中并不保证正确舍入 / 单调——符合规范
        // 的 libm 实现允许若干 ULP 误差，极端 age/halfLife 比值下可能让 da 比 db 小约
        // 1e-15。1e-12 依赖的是「未被规范保证」的 pow 精度；放宽到 1e-9 即可摆脱对 pow
        // 实现精度的依赖，同时（返回值 ∈ (0,1]）仍是极紧的相对容差，不弱化单调性的实质验证。
        expect(da).toBeGreaterThanOrEqual(db - 1e-9);
      }),
      { numRuns: 500 },
    );
  });
});

describe("fuseTriSignal（Property 10：三信号融合单调性）", () => {
  // **Validates: Requirements 7.3**
  // 固定其余两信号与非负权重，增大被测分量（在 [0,1] 内），fused 不减。
  const weightsArb: fc.Arbitrary<TriSignalWeights> = fc.record({
    temporal: nonNegWeightArb,
    semantic: nonNegWeightArb,
    cognitive: nonNegWeightArb,
  });
  // 用 [0,1] 内的有序对验证单调性（clamp01 在边界外饱和，单调性在区间内体现）。
  const unitPairArb = fc
    .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([p, q]) => [Math.min(p, q), Math.max(p, q)] as const);

  it("对 decay 分量单调非减", () => {
    fc.assert(
      fc.property(weightsArb, unitPairArb, signalArb, signalArb, (w, [lo, hi], semantic, cognitive) => {
        const low = fuseTriSignal({ decay: lo, semantic, cognitive }, w);
        const high = fuseTriSignal({ decay: hi, semantic, cognitive }, w);
        expect(high).toBeGreaterThanOrEqual(low - 1e-9);
      }),
    );
  });

  it("对 semantic 分量单调非减", () => {
    fc.assert(
      fc.property(weightsArb, unitPairArb, signalArb, signalArb, (w, [lo, hi], decay, cognitive) => {
        const low = fuseTriSignal({ decay, semantic: lo, cognitive }, w);
        const high = fuseTriSignal({ decay, semantic: hi, cognitive }, w);
        expect(high).toBeGreaterThanOrEqual(low - 1e-9);
      }),
    );
  });

  it("对 cognitive 分量单调非减", () => {
    fc.assert(
      fc.property(weightsArb, unitPairArb, signalArb, signalArb, (w, [lo, hi], decay, semantic) => {
        const low = fuseTriSignal({ decay, semantic, cognitive: lo }, w);
        const high = fuseTriSignal({ decay, semantic, cognitive: hi }, w);
        expect(high).toBeGreaterThanOrEqual(low - 1e-9);
      }),
    );
  });
});

describe("rankByTriSignal（Property 11：重排是排列且稳定）", () => {
  // **Validates: Requirements 7.4, 7.5, 7.6**
  interface Item {
    id: number;
    input: TriSignalInput;
  }

  const itemArb: fc.Arbitrary<Item> = fc.record({
    id: fc.integer(),
    input: fc.record({
      decay: fc.double({ min: 0, max: 1, noNaN: true }),
      semantic: fc.double({ min: 0, max: 1, noNaN: true }),
      cognitive: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  });

  // 给每个 item 赋唯一序号，便于在 id 重复时仍能精确比对多重集合与稳定性。
  const itemsArb = fc
    .array(itemArb, { maxLength: 50 })
    .map((arr) => arr.map((it, i) => ({ ...it, uid: i })));

  it("输出与输入同长、同元素多重集合（不丢不增不改）", () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const out = rankByTriSignal(items, (it) => it.input);
        expect(out.length).toBe(items.length);
        const sortUid = (a: { uid: number }, b: { uid: number }) => a.uid - b.uid;
        expect([...out].sort(sortUid)).toEqual([...items].sort(sortUid));
        // 元素引用未被复制 / 修改：每个输出都是输入中的同一引用
        for (const o of out) {
          expect(items).toContain(o);
        }
      }),
    );
  });

  it("按 fused 降序输出", () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const out = rankByTriSignal(items, (it) => it.input);
        for (let i = 1; i < out.length; i++) {
          const prev = fuseTriSignal(out[i - 1].input);
          const cur = fuseTriSignal(out[i].input);
          // 与 Property 9 同类的浮点比较容差：此处 prev/cur 是对同一纯函数 fuseTriSignal
          // 在相同输入上的重算，理论上逐位相等；为与本层其余浮点比较口径一致、并防御
          // 未来实现里引入非正确舍入运算（如 pow/exp）造成的 ULP 级抖动，统一用 1e-9。
          expect(prev).toBeGreaterThanOrEqual(cur - 1e-9);
        }
      }),
    );
  });

  it("fused 相等时保持输入相对顺序（稳定）", () => {
    // 构造一批 fused 完全相等的元素：所有信号分量相同，仅 uid/id 不同。
    const equalFusedItemsArb = fc
      .array(fc.integer(), { minLength: 0, maxLength: 30 })
      .map((ids) =>
        ids.map((id, i) => ({
          id,
          uid: i,
          input: { decay: 0.5, semantic: 0.5, cognitive: 0.5 } as TriSignalInput,
        })),
      );

    fc.assert(
      fc.property(equalFusedItemsArb, (items) => {
        const out = rankByTriSignal(items, (it) => it.input);
        // fused 全相等 ⇒ 输出顺序应与输入顺序完全一致
        expect(out.map((o) => o.uid)).toEqual(items.map((it) => it.uid));
      }),
    );
  });

  it("每个元素只调用一次 project", () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const calls = new Map<number, number>();
        rankByTriSignal(items, (it) => {
          calls.set(it.uid, (calls.get(it.uid) ?? 0) + 1);
          return it.input;
        });
        for (const it of items) {
          expect(calls.get(it.uid)).toBe(1);
        }
      }),
    );
  });

  it("默认权重与显式 DEFAULT 权重结果一致", () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const a = rankByTriSignal(items, (it) => it.input);
        const b = rankByTriSignal(items, (it) => it.input, DEFAULT_TRI_SIGNAL_WEIGHTS);
        expect(a.map((o) => o.uid)).toEqual(b.map((o) => o.uid));
      }),
    );
  });
});
