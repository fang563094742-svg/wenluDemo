// Feature: proactive-awareness-demo, Property 10: Confidence_Statement 划分完备且不重叠。For any 已消解前提集合，由 `resolvedBy` 机械生成的 Confidence_Statement 满足：`basedOnUserInput` 恰含所有 resolvedBy="user_input" 的前提，`basedOnDefaultAssumption` 恰含所有 resolvedBy="default_accepted" 的前提，两列表并集等于全部已消解前提且交集为空。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generateConfidenceStatement } from "../../src/clarifier/confidence.js";
import type {
  Execution_Precondition,
  PreconditionStatus,
  RiskLevel,
} from "../../src/clarifier/types.js";

/**
 * Property 10: Confidence_Statement 划分完备且不重叠
 *
 * Validates: Requirements 8.8
 *
 * 对任一已消解前提集合，`generateConfidenceStatement` 按 `resolvedBy` 机械划分：
 *  - `basedOnUserInput` 恰含所有 `resolvedBy === "user_input"` 的前提；
 *  - `basedOnDefaultAssumption` 恰含所有 `resolvedBy === "default_accepted"` 的前提；
 *  - 两列表并集等于全部已消解前提（`resolvedBy` 落在上述两类之一者）；
 *  - 两列表交集为空（任一前提至多归入一类）。
 *
 * 说明：`resolvedBy` 未设置（尚未消解）的前提既非用户输入也非默认假设，
 * 不属于「已消解前提」全集，故被排除在两列表之外——这正是划分在
 * 「已消解前提」全集上既完备又不重叠的边界条件。
 */

// ── 智能生成器：把输入空间约束为「带唯一标识的前提集合」 ──────────────────────
// 关键约束：description 以序号前缀保证全局唯一，使得 Confidence_Statement 中
// 仅含 {precondition, value} 的条目可被无歧义地反查到来源前提，从而能精确
// 校验「恰含」「并集」「交集为空」三项。

const statusArb: fc.Arbitrary<PreconditionStatus> = fc.constantFrom(
  "known",
  "ambiguous",
  "unknown",
);

const riskArb: fc.Arbitrary<RiskLevel> = fc.constantFrom("low", "medium", "high");

/** resolvedBy 三态：已由用户消解 / 已接受默认 / 尚未消解（undefined）。 */
const resolvedByArb: fc.Arbitrary<Execution_Precondition["resolvedBy"]> =
  fc.constantFrom("user_input", "default_accepted", undefined);

/** 与实现一致的对外披露值：resolvedValue ?? proposedDefault ?? ""。 */
function disclosedValue(p: Execution_Precondition): string {
  return p.resolvedValue ?? p.proposedDefault ?? "";
}

/**
 * 单个前提的「可变部分」生成器（不含唯一序号——序号在数组层用 index 注入，
 * 以保证 description 全局唯一）。
 */
const preconditionPartsArb = fc.record({
  status: statusArb,
  risk_level: riskArb,
  resolvedBy: resolvedByArb,
  // 这两个可选字段独立缺省，覆盖 disclosedValue 的三条退化路径。
  resolvedValue: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
  proposedDefault: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
  descTail: fc.string({ maxLength: 8 }),
});

/** 任意长度的前提集合：每个前提带唯一序号，description 因此互不相同。 */
const preconditionsArb: fc.Arbitrary<Execution_Precondition[]> = fc
  .array(preconditionPartsArb, { maxLength: 16 })
  .map((parts) =>
    parts.map((p, i): Execution_Precondition => ({
      id: `pre-${i}`,
      phaseId: `phase-${i % 3}`,
      description: `前提#${i}:${p.descTail}`,
      status: p.status,
      risk_level: p.risk_level,
      related_action: `action-${i}`,
      ...(p.proposedDefault !== undefined
        ? { proposedDefault: p.proposedDefault }
        : {}),
      ...(p.resolvedBy !== undefined ? { resolvedBy: p.resolvedBy } : {}),
      ...(p.resolvedValue !== undefined
        ? { resolvedValue: p.resolvedValue }
        : {}),
    })),
  );

/** 把 Confidence_Statement 条目映射为可用于集合比较的稳定键（含来源 description）。 */
const entryKey = (e: { precondition: string; value: string }): string =>
  `${e.precondition}\u0000${e.value}`;

describe("Property 10: Confidence_Statement 划分完备且不重叠", () => {
  it("basedOnUserInput 恰含所有 resolvedBy=user_input 的前提（按序、含值）", () => {
    fc.assert(
      fc.property(preconditionsArb, (pres) => {
        const cs = generateConfidenceStatement(pres);
        const expected = pres
          .filter((p) => p.resolvedBy === "user_input")
          .map((p) => ({ precondition: p.description, value: disclosedValue(p) }));
        expect(cs.basedOnUserInput).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("basedOnDefaultAssumption 恰含所有 resolvedBy=default_accepted 的前提（按序、含值）", () => {
    fc.assert(
      fc.property(preconditionsArb, (pres) => {
        const cs = generateConfidenceStatement(pres);
        const expected = pres
          .filter((p) => p.resolvedBy === "default_accepted")
          .map((p) => ({ precondition: p.description, value: disclosedValue(p) }));
        expect(cs.basedOnDefaultAssumption).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("两列表并集等于全部已消解前提（resolvedBy ∈ {user_input, default_accepted}）", () => {
    fc.assert(
      fc.property(preconditionsArb, (pres) => {
        const cs = generateConfidenceStatement(pres);
        const unionKeys = new Set(
          [...cs.basedOnUserInput, ...cs.basedOnDefaultAssumption].map(entryKey),
        );
        const resolved = pres.filter(
          (p) =>
            p.resolvedBy === "user_input" || p.resolvedBy === "default_accepted",
        );
        const expectedKeys = new Set(
          resolved.map((p) =>
            entryKey({ precondition: p.description, value: disclosedValue(p) }),
          ),
        );
        // 并集大小 = 已消解前提数（description 唯一 ⇒ 无键碰撞），且键集相等。
        expect(
          cs.basedOnUserInput.length + cs.basedOnDefaultAssumption.length,
        ).toBe(resolved.length);
        expect(unionKeys).toEqual(expectedKeys);
        // 未消解（resolvedBy=undefined）的前提一律不出现在并集中。
        for (const p of pres) {
          if (p.resolvedBy === undefined) {
            expect(unionKeys.has(entryKey({ precondition: p.description, value: disclosedValue(p) }))).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("两列表交集为空（任一前提至多归入一类）", () => {
    fc.assert(
      fc.property(preconditionsArb, (pres) => {
        const cs = generateConfidenceStatement(pres);
        const userKeys = new Set(cs.basedOnUserInput.map(entryKey));
        const defKeys = new Set(cs.basedOnDefaultAssumption.map(entryKey));
        for (const k of userKeys) {
          expect(defKeys.has(k)).toBe(false);
        }
        // 以来源 description 维度再校验一次（更强：连「同一前提」都不可跨类）。
        const userDescs = new Set(cs.basedOnUserInput.map((e) => e.precondition));
        const defDescs = new Set(
          cs.basedOnDefaultAssumption.map((e) => e.precondition),
        );
        for (const d of userDescs) {
          expect(defDescs.has(d)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
