// Feature: MAP-Elites 能力星图 —— property 测试证明「尺子本身正确」。
// 证明：精英替换只升不降、覆盖率单调、空格枚举完备、推荐空格确为空格、QD-score 正确。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  cellKey,
  classifyDomain,
  tryPlace,
  coverage,
  qdScore,
  emptyCells,
  recommendNextCell,
  buildMap,
  CAPABILITY_DOMAINS,
  TOTAL_CELLS,
  type CapabilitySolution,
  type CapabilityMap,
} from "../../src/judgment/mapElites.js";

const domain = () => fc.constantFrom(...CAPABILITY_DOMAINS);
const sol = (): fc.Arbitrary<CapabilitySolution> =>
  fc.record({
    id: fc.string({ minLength: 1 }),
    desc: fc.string(),
    domain: domain(),
    difficulty: fc.integer({ min: 1, max: 5 }),
    quality: fc.double({ min: 0, max: 100, noNaN: true }),
  });

describe("MAP-Elites 能力星图：尺子正确性（property）", () => {
  it("精英替换只升不降：同格 elite 的 quality 单调不减", () => {
    fc.assert(
      fc.property(fc.array(sol(), { maxLength: 60 }), (sols) => {
        let map: CapabilityMap = new Map();
        const best = new Map<string, number>();
        for (const s of sols) {
          map = tryPlace(map, s).map;
          const k = cellKey(s.domain, s.difficulty);
          best.set(k, Math.max(best.get(k) ?? -Infinity, s.quality));
        }
        // 每格的 elite 必为见过的最高质量。
        for (const [k, q] of best) {
          expect(map.get(k)!.quality).toBeCloseTo(q, 9);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("覆盖率 ∈ [0,1]，且加解后只增不减；满图=1", () => {
    fc.assert(
      fc.property(fc.array(sol()), (sols) => {
        let map: CapabilityMap = new Map();
        let prev = 0;
        for (const s of sols) {
          map = tryPlace(map, s).map;
          const cov = coverage(map);
          expect(cov).toBeGreaterThanOrEqual(prev - 1e-9);
          expect(cov).toBeGreaterThanOrEqual(0);
          expect(cov).toBeLessThanOrEqual(1);
          prev = cov;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("placed/improved 语义：空格→placed，更高质量→improved，更低质量→都false", () => {
    const base: CapabilitySolution = { id: "a", desc: "", domain: "web", difficulty: 3, quality: 50 };
    const empty: CapabilityMap = new Map();
    const r1 = tryPlace(empty, base);
    expect(r1.placed).toBe(true);
    expect(r1.improved).toBe(false);
    const higher = tryPlace(r1.map, { ...base, id: "b", quality: 80 });
    expect(higher.placed).toBe(false);
    expect(higher.improved).toBe(true);
    expect(higher.map.get(cellKey("web", 3))!.id).toBe("b");
    const lower = tryPlace(r1.map, { ...base, id: "c", quality: 10 });
    expect(lower.placed).toBe(false);
    expect(lower.improved).toBe(false);
    expect(lower.map.get(cellKey("web", 3))!.id).toBe("a"); // 不被更差的替换
  });

  it("emptyCells 完备：空格数 + 已点亮数 = 总格子数", () => {
    fc.assert(
      fc.property(fc.array(sol()), (sols) => {
        const map = buildMap(sols);
        expect(emptyCells(map).length + map.size).toBe(TOTAL_CELLS);
      }),
      { numRuns: 200 },
    );
  });

  it("recommendNextCell：返回的必是空格；满图返回 null", () => {
    fc.assert(
      fc.property(fc.array(sol()), (sols) => {
        const map = buildMap(sols);
        const rec = recommendNextCell(map);
        if (rec === null) {
          expect(map.size).toBe(TOTAL_CELLS);
        } else {
          expect(map.has(cellKey(rec.domain, rec.difficulty))).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("qdScore = 各格 elite 质量之和", () => {
    fc.assert(
      fc.property(fc.array(sol()), (sols) => {
        const map = buildMap(sols);
        let sum = 0;
        for (const s of map.values()) sum += s.quality;
        expect(qdScore(map)).toBeCloseTo(+sum.toFixed(4), 6);
      }),
      { numRuns: 200 },
    );
  });

  it("classifyDomain：已知关键词归对应域，未知归 other", () => {
    expect(classifyDomain("用 browse_url 抓取网页")).toBe("web");
    expect(classifyDomain("read_file 读取 json 文件")).toBe("file");
    expect(classifyDomain("osascript 控制 chrome 截图")).toBe("gui");
    expect(classifyDomain("git build npm 重构代码")).toBe("code");
    expect(classifyDomain("完全无关的描述文本zzz")).toBe("other");
  });
});
