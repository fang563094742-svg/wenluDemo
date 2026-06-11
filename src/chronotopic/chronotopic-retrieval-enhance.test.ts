/**
 * 时空校准层 · V2 检索增强集成测试（chronotopic-retrieval-enhance.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 10.2（集成测试：增强不破坏既有检索行为）。
 *
 * 验证 rankByTriSignal 作为「增强层」的语义：对一组模拟检索结果（河床节点 /
 * 记忆 Episode），用与 riverMain 接线等价的 project 逻辑跑 rankByTriSignal，断言：
 *  - 输出是输入的排列（同元素集合，不丢不增）—— 证明「增强只重排、不改变候选集合」；
 *  - 越新鲜（age 小）+ 越高 confidence/importance 的节点排越前。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-decay.js。
 * 不 import riverMain.ts、不 import 3.1/3.2、不 node:sqlite。模拟节点结构在本测试
 * 内自定义，project 逻辑复刻接线意图（不依赖宿主源码）。
 *
 * _Requirements: 8.1, 8.2, 8.3_
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  rankByTriSignal,
  temporalDecay,
  type TriSignalInput,
} from "./chronotopic-decay.js";

const MS_PER_DAY = 86_400_000;
const HALF_LIFE: number = 7 * MS_PER_DAY; // 7 天半衰期（与典型新鲜度设定一致）

/** 模拟河床节点：带 updatedAt（ISO 串）、confidence、severity、interruptAuthority。 */
interface MockRiverbedNode {
  id: string;
  updatedAt: string;
  confidence: number; // BM25 归一分 / packet.confidence 的替身，∈[0,1]
  severity: number; // ∈[0,1]
  interruptAuthority: number; // ∈[0,1]
}

/** 模拟记忆 Episode：带 createdAt（ISO 串）、importance、semantic（BM25 归一分）。 */
interface MockEpisode {
  id: string;
  createdAt: string;
  importance: number; // ∈[0,1]
  semantic: number; // ∈[0,1]
}

/**
 * 河床节点 → 三信号（复刻 riverMain 10.1 接线意图）：
 *  decay = temporalDecay(now - updatedAt)、semantic = confidence、
 *  cognitive = severity × interruptAuthority。
 */
function projectNode(now: number): (n: MockRiverbedNode) => TriSignalInput {
  return (n) => ({
    decay: temporalDecay(Math.max(0, now - Date.parse(n.updatedAt)), { halfLifeMs: HALF_LIFE }),
    semantic: n.confidence,
    cognitive: n.severity * n.interruptAuthority,
  });
}

/** 记忆 Episode → 三信号：decay 由 createdAt，semantic 复用 BM25，cognitive = importance。 */
function projectEpisode(now: number): (e: MockEpisode) => TriSignalInput {
  return (e) => ({
    decay: temporalDecay(Math.max(0, now - Date.parse(e.createdAt)), { halfLifeMs: HALF_LIFE }),
    semantic: e.semantic,
    cognitive: e.importance,
  });
}

describe("V2 检索增强：rankByTriSignal 不破坏候选集合（R8.3）", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  const nodeArb: fc.Arbitrary<MockRiverbedNode> = fc.record({
    id: fc.uuid(),
    updatedAt: fc
      .integer({ min: 0, max: 60 * MS_PER_DAY })
      .map((ageDaysMs) => new Date(now - ageDaysMs).toISOString()),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    severity: fc.double({ min: 0, max: 1, noNaN: true }),
    interruptAuthority: fc.double({ min: 0, max: 1, noNaN: true }),
  });

  it("河床节点：增强输出是输入的排列（同元素集合，不丢不增）", () => {
    fc.assert(
      fc.property(fc.array(nodeArb, { maxLength: 40 }), (nodes) => {
        const enhanced = rankByTriSignal(nodes, projectNode(now));
        expect(enhanced.length).toBe(nodes.length);
        const byId = (a: MockRiverbedNode, b: MockRiverbedNode) => a.id.localeCompare(b.id);
        expect([...enhanced].sort(byId)).toEqual([...nodes].sort(byId));
        // 引用一致：只重排不复制
        for (const e of enhanced) expect(nodes).toContain(e);
      }),
    );
  });

  it("记忆 Episode：增强输出是输入的排列（同元素集合，不丢不增）", () => {
    const episodeArb: fc.Arbitrary<MockEpisode> = fc.record({
      id: fc.uuid(),
      createdAt: fc
        .integer({ min: 0, max: 60 * MS_PER_DAY })
        .map((ageDaysMs) => new Date(now - ageDaysMs).toISOString()),
      importance: fc.double({ min: 0, max: 1, noNaN: true }),
      semantic: fc.double({ min: 0, max: 1, noNaN: true }),
    });

    fc.assert(
      fc.property(fc.array(episodeArb, { maxLength: 40 }), (eps) => {
        const enhanced = rankByTriSignal(eps, projectEpisode(now));
        expect(enhanced.length).toBe(eps.length);
        const byId = (a: MockEpisode, b: MockEpisode) => a.id.localeCompare(b.id);
        expect([...enhanced].sort(byId)).toEqual([...eps].sort(byId));
      }),
    );
  });

  it("空候选集合：增强返回空数组（既有行为保持原状）", () => {
    expect(rankByTriSignal<MockRiverbedNode>([], projectNode(now))).toEqual([]);
  });
});

describe("V2 检索增强：越新鲜 + 越高权重的节点排越前", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it("两条河床节点：新鲜且高 confidence/severity 者排在前", () => {
    const fresh: MockRiverbedNode = {
      id: "fresh-strong",
      updatedAt: new Date(now - 1 * MS_PER_DAY).toISOString(), // 1 天前
      confidence: 0.9,
      severity: 0.9,
      interruptAuthority: 0.9,
    };
    const stale: MockRiverbedNode = {
      id: "stale-weak",
      updatedAt: new Date(now - 50 * MS_PER_DAY).toISOString(), // 50 天前
      confidence: 0.1,
      severity: 0.1,
      interruptAuthority: 0.1,
    };

    // 即便输入顺序把弱节点放前面，增强后强且新鲜的节点也应排到第 0 位。
    const enhanced = rankByTriSignal([stale, fresh], projectNode(now));
    expect(enhanced[0].id).toBe("fresh-strong");
    expect(enhanced[1].id).toBe("stale-weak");
  });

  it("两条记忆 Episode：新鲜且高 importance 者排在前", () => {
    const fresh: MockEpisode = {
      id: "fresh-important",
      createdAt: new Date(now - 1 * MS_PER_DAY).toISOString(),
      importance: 0.95,
      semantic: 0.9,
    };
    const stale: MockEpisode = {
      id: "stale-trivial",
      createdAt: new Date(now - 60 * MS_PER_DAY).toISOString(),
      importance: 0.05,
      semantic: 0.1,
    };

    const enhanced = rankByTriSignal([stale, fresh], projectEpisode(now));
    expect(enhanced[0].id).toBe("fresh-important");
    expect(enhanced[1].id).toBe("stale-trivial");
  });
});
