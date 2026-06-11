/**
 * 时空校准层 · Hindsight 式分层压缩属性测试（chronotopic-compress.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 13.2（Property 16：分层压缩可追溯 / sourceIds 守恒），并补充
 * mental_model 吸收态与 signatureId 选取逻辑的单元测试。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-compress.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  liftTier,
  type CompressionTier,
  type CompressedEntry,
} from "./chronotopic-compress.js";

/** 三种压缩层级。 */
const TIERS: CompressionTier[] = ["raw_fact", "observation", "mental_model"];

/** 任意压缩层级。 */
const tierArb = fc.constantFrom<CompressionTier>(...TIERS);

/** 任意一条 CompressedEntry。 */
const entryArb: fc.Arbitrary<CompressedEntry> = fc.record({
  tier: tierArb,
  content: fc.string(),
  sourceIds: fc.array(fc.string(), { maxLength: 8 }),
  signatureId: fc.option(fc.string(), { nil: null }),
});

/** 任意 CompressedEntry 数组。 */
const entriesArb = fc.array(entryArb, { maxLength: 20 });

/** 收集一组条目的 sourceIds 去重并集（作为 Set，便于无序比较）。 */
function sourceIdUnion(entries: CompressedEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    for (const id of e.sourceIds) set.add(id);
  }
  return set;
}

describe("liftTier（Property 16：分层压缩可追溯 / sourceIds 守恒）", () => {
  // **Validates: Requirements 10.1, 10.2**
  it("sourceIds 守恒：输出并集（去重）=== 输入并集（去重）", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const out = liftTier(entries);
        const inUnion = sourceIdUnion(entries);
        const outUnion = sourceIdUnion(out);
        // 集合相等：大小一致且互相包含（无遗漏、无凭空新增）。
        expect(outUnion.size).toBe(inUnion.size);
        for (const id of inUnion) expect(outUnion.has(id)).toBe(true);
        for (const id of outUnion) expect(inUnion.has(id)).toBe(true);
      }),
    );
  });

  // **Validates: Requirements 10.1**
  it("层级恰提升一档：输出不含 raw_fact，且每条输出 tier 由某输入 tier 提升一档而来", () => {
    const expectedLift: Record<CompressionTier, CompressionTier> = {
      raw_fact: "observation",
      observation: "mental_model",
      mental_model: "mental_model",
    };
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const out = liftTier(entries);
        // 输入中出现的层级集合，提升后应等于输出层级集合。
        const inputTiers = new Set(entries.map((e) => e.tier));
        const expectedOutTiers = new Set(
          [...inputTiers].map((t) => expectedLift[t]),
        );
        const actualOutTiers = new Set(out.map((e) => e.tier));
        // 输出绝不含 raw_fact（吸收态最低为 observation）。
        expect(actualOutTiers.has("raw_fact")).toBe(false);
        // 输出层级集合 === 输入层级提升一档的集合。
        expect(actualOutTiers.size).toBe(expectedOutTiers.size);
        for (const t of expectedOutTiers) expect(actualOutTiers.has(t)).toBe(true);
        for (const t of actualOutTiers) expect(expectedOutTiers.has(t)).toBe(true);
      }),
    );
  });

  // **Validates: Requirements 10.1, 10.2**
  it("确定性：同输入两次调用结果深度相等", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const a = liftTier(entries);
        const b = liftTier(entries);
        expect(a).toStrictEqual(b);
      }),
    );
  });

  // **Validates: Requirements 10.1, 10.2**
  it("空输入 → 空输出", () => {
    expect(liftTier([])).toStrictEqual([]);
  });
});

describe("liftTier 单元测试：mental_model 吸收态", () => {
  // **Validates: Requirements 10.1**
  it("输入纯 mental_model → 输出仍 mental_model", () => {
    const entries: CompressedEntry[] = [
      { tier: "mental_model", content: "m1", sourceIds: ["a"], signatureId: "s1" },
      { tier: "mental_model", content: "m2", sourceIds: ["b"], signatureId: "s2" },
    ];
    const out = liftTier(entries);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe("mental_model");
    expect(new Set(out[0]!.sourceIds)).toStrictEqual(new Set(["a", "b"]));
  });
});

describe("liftTier 单元测试：signatureId 选取逻辑", () => {
  // **Validates: Requirements 10.2**
  it("取该组输入顺序中最后一个非空 signatureId", () => {
    const entries: CompressedEntry[] = [
      { tier: "raw_fact", content: "c1", sourceIds: ["a"], signatureId: "sig-1" },
      { tier: "raw_fact", content: "c2", sourceIds: ["b"], signatureId: null },
      { tier: "raw_fact", content: "c3", sourceIds: ["c"], signatureId: "sig-3" },
    ];
    const out = liftTier(entries);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe("observation");
    expect(out[0]!.signatureId).toBe("sig-3");
  });

  it("整组无非空签名 → signatureId 为 null", () => {
    const entries: CompressedEntry[] = [
      { tier: "observation", content: "c1", sourceIds: ["a"], signatureId: null },
      { tier: "observation", content: "c2", sourceIds: ["b"], signatureId: null },
    ];
    const out = liftTier(entries);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe("mental_model");
    expect(out[0]!.signatureId).toBeNull();
  });

  it("末位非空签名即便其后再无签名也被选中（不同层级各自独立选取）", () => {
    const entries: CompressedEntry[] = [
      { tier: "raw_fact", content: "r", sourceIds: ["a"], signatureId: "raw-sig" },
      { tier: "observation", content: "o", sourceIds: ["b"], signatureId: "obs-sig" },
    ];
    const out = liftTier(entries);
    // 两个层级分别聚合：raw_fact→observation、observation→mental_model。
    const byTier = new Map(out.map((e) => [e.tier, e]));
    expect(byTier.get("observation")!.signatureId).toBe("raw-sig");
    expect(byTier.get("mental_model")!.signatureId).toBe("obs-sig");
  });
});
