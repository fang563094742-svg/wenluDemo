/**
 * 配置 + unify 测试 — P8 向后兼容 / P10 收编忠实
 * Validates: Requirements 7.1, 1.4, 7.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  resolveSovereignConfig,
  DEFAULT_SOVEREIGN,
  toDualWriteCommands,
  compareMindVsStore,
  type MindSovereignReadLike,
} from "../index.js";

describe("sovereign-config · P8 向后兼容 (Req 7.1)", () => {
  it("缺省 mind（无 sovereign）⟹ 深度等于 DEFAULT_SOVEREIGN 且不改入参", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (extra) => {
        const mind = { ...extra } as MindSovereignReadLike;
        delete (mind as Record<string, unknown>).sovereign;
        const snap = JSON.stringify(mind);
        const cfg = resolveSovereignConfig(mind);
        expect(cfg).toEqual(DEFAULT_SOVEREIGN);
        expect(JSON.stringify(mind)).toBe(snap);
      }),
      { numRuns: 200 },
    );
  });
  it("缺省必为 shadow + 全 cut 关闭（零行为改变前提）", () => {
    expect(DEFAULT_SOVEREIGN.mode).toBe("shadow");
    expect(Object.values(DEFAULT_SOVEREIGN.enabledCuts).every((v) => v === false)).toBe(true);
  });
  it("河床权重读入超限被钉回 ≤2（且配置层不破坏铁律语义）", () => {
    const cfg = resolveSovereignConfig({ sovereign: { ...DEFAULT_SOVEREIGN, weights: { ...DEFAULT_SOVEREIGN.weights, riverbed: 99 } } });
    expect(cfg.weights.riverbed).toBeLessThanOrEqual(2);
  });
});

describe("unify · P10 收编忠实 (Req 1.4, 7.4)", () => {
  it("已知 kind ⟹ 转发为双写命令；未知 ⟹ 空", () => {
    expect(toDualWriteCommands({ kind: "belief/add", payload: { x: 1 } })).toHaveLength(1);
    expect(toDualWriteCommands({ kind: "unknown/thing", payload: {} })).toHaveLength(0);
  });
  it("投影一致 ⟹ faithful=true；有差异 ⟹ 列 diff", () => {
    const mind = { beliefsCount: 3, goalGap: 0.5, cycles: 10 };
    const storeSame = { beliefsCount: 3, goalGap: 0.5, cycles: 10 };
    const storeDiff = { beliefsCount: 3, goalGap: 0.4, cycles: 10 };
    const keys = ["beliefsCount", "goalGap", "cycles"];
    expect(compareMindVsStore(mind, storeSame, keys).faithful).toBe(true);
    const rep = compareMindVsStore(mind, storeDiff, keys);
    expect(rep.faithful).toBe(false);
    expect(rep.diffs.some((d) => d.field === "goalGap")).toBe(true);
  });
});
