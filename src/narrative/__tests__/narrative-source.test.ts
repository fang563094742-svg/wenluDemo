/**
 * 叙事输出层 · 来源归集器测试（narrative-source.ts）
 * ------------------------------------------------------------------
 * 覆盖 tasks.md 任务 2.2 / 2.3 / 2.4：
 *  - 2.2 Property 11：truthTier 仅由上游 source 决定（Requirements 1.5, 1.6, 7.1）
 *  - 2.3 Property 14：buildSourceIndex 不改 mind（Requirements 1.9, 6.4, 7.2, 7.3）
 *  - 2.4 活跃过滤与倒排一致性单元测试（Requirements 1.3, 1.4, 1.7, 1.8, 1.10）
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MindReadLike } from "../narrative-config.js";
import {
  buildSourceIndex,
  mapTruthTier,
  extractKeywords,
  safeReadRiverbedReasons,
  safeReadChronoSummaries,
  type NarrativeSourceKind,
} from "../narrative-source.js";

// ------------------------------------------------------------------
// 生成器（generators）
// ------------------------------------------------------------------

/** 上游 source 字段取值池：覆盖 verified / inferred / 未知三类。 */
const sourceArb = fc.constantFrom(
  "web-verified",
  "file-observed",
  "observed",
  "user-said",
  "user-told",
  "inferred",
  "inferred-unverified",
  "unknown-engine",
  "",
  "random-source",
);

/** 非空、去重友好的内容片段（含中英数字），由调用方再加唯一前缀。 */
const contentFragmentArb = fc.constantFrom(
  "用户在做 iOS 上架",
  "卡在 TestFlight 审核",
  "deadline next week",
  "项目 v2 重构",
  "需要尽快交付 demo",
  "budget 5000",
  "hello world",
  "时空签名 scene",
);

/** knowledge 条目数组（content 加唯一前缀，保证活跃且唯一）。 */
const knowledgeArrayArb = fc
  .array(fc.record({ source: sourceArb, frag: contentFragmentArb }), {
    maxLength: 6,
  })
  .map((items) =>
    items.map((it, i) => ({
      content: `k${i}_${it.frag}`,
      source: it.source,
    })),
  );

/** beliefs 条目数组（带可选 correctedBy）。 */
const beliefsArrayArb = fc
  .array(
    fc.record({
      source: sourceArb,
      frag: contentFragmentArb,
      confidence: fc.float({ min: 0, max: 1, noNaN: true }),
      corrected: fc.option(fc.string({ minLength: 1, maxLength: 6 }), {
        nil: undefined,
      }),
    }),
    { maxLength: 6 },
  )
  .map((items) =>
    items.map((it, i) => ({
      id: `b${i}`,
      content: `b${i}_${it.frag}`,
      confidence: it.confidence,
      source: it.source,
      ...(it.corrected !== undefined ? { correctedBy: it.corrected } : {}),
    })),
  );

/** userModel 条目数组（带可选 supersededBy）。 */
const userModelArrayArb = fc
  .array(
    fc.record({
      frag: contentFragmentArb,
      confidence: fc.float({ min: 0, max: 1, noNaN: true }),
      superseded: fc.option(fc.string({ minLength: 1, maxLength: 6 }), {
        nil: undefined,
      }),
    }),
    { maxLength: 6 },
  )
  .map((items) =>
    items.map((it, i) => ({
      id: `u${i}`,
      aspect: `aspect${i}`,
      content: `u${i}_${it.frag}`,
      confidence: it.confidence,
      ...(it.superseded !== undefined ? { supersededBy: it.superseded } : {}),
    })),
  );

/** 完整 mind 生成器（含可选 riverbed / chronotopic 任意 JSON 结构）。 */
const mindArb: fc.Arbitrary<MindReadLike> = fc.record({
  knowledge: knowledgeArrayArb,
  beliefs: beliefsArrayArb,
  userModel: userModelArrayArb,
  riverbed: fc.option(fc.jsonValue(), { nil: undefined }),
  chronotopic: fc.option(fc.jsonValue(), { nil: undefined }),
}) as unknown as fc.Arbitrary<MindReadLike>;

// ------------------------------------------------------------------
// 任务 2.2 — Property 11：truthTier 仅由上游 source 决定
// Validates: Requirements 1.5, 1.6, 7.1
// ------------------------------------------------------------------

/**
 * 由 mind 构建 (kind::content) → 上游 source 的查找表（仅活跃项）。
 * userModel 无 source 字段，归集器恒以 "user-told" 映射；riverbed/chronotopic 恒 contextual。
 */
function buildUpstreamSourceLookup(mind: MindReadLike): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const k of mind.knowledge) {
    lookup.set(`knowledge::${k.content.trim()}`, k.source);
  }
  for (const b of mind.beliefs) {
    if (b.correctedBy !== undefined && b.correctedBy !== null) continue;
    lookup.set(`belief::${b.content.trim()}`, b.source);
  }
  return lookup;
}

describe("Property 11: truthTier 仅由上游 source 决定 (任务 2.2)", () => {
  it("每条 source.truthTier === mapTruthTier(kind, 上游 source)", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const index = buildSourceIndex(mind, Date.now());
        const lookup = buildUpstreamSourceLookup(mind);

        for (const s of index.sources) {
          let expected;
          if (s.kind === "knowledge" || s.kind === "belief") {
            const upstreamSource = lookup.get(`${s.kind}::${s.content}`);
            expected = mapTruthTier(s.kind, upstreamSource);
          } else if (s.kind === "userModel") {
            expected = mapTruthTier("userModel", "user-told");
          } else {
            // riverbed / chronotopic
            expected = mapTruthTier(s.kind);
          }
          expect(s.truthTier).toBe(expected);
        }
      }),
    );
  });

  it("改变与 source 无关的字段不改变 truthTier", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const tiersOf = (m: MindReadLike): Map<string, string> => {
          const idx = buildSourceIndex(m, Date.now());
          const map = new Map<string, string>();
          for (const s of idx.sources) {
            map.set(`${s.kind}::${s.content}`, s.truthTier);
          }
          return map;
        };

        const before = tiersOf(mind);

        // 构造仅改变 source 无关字段（confidence / id / aspect）的 mind2，
        // 保留 content / source / 活跃状态（correctedBy/supersededBy）不变。
        const mind2: MindReadLike = {
          knowledge: mind.knowledge.map((k) => ({ ...k })),
          beliefs: mind.beliefs.map((b) => ({
            ...b,
            id: `${b.id}_x`,
            confidence: (b.confidence + 0.123) % 1,
          })),
          userModel: mind.userModel.map((u) => ({
            ...u,
            aspect: `${u.aspect}_x`,
            confidence: (u.confidence + 0.321) % 1,
          })),
          riverbed: mind.riverbed,
          chronotopic: mind.chronotopic,
        };

        const after = tiersOf(mind2);

        expect(after).toEqual(before);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 2.3 — Property 14：buildSourceIndex 不改 mind
// Validates: Requirements 1.9, 6.4, 7.2, 7.3
// ------------------------------------------------------------------

describe("Property 14: buildSourceIndex 不改 mind (任务 2.3)", () => {
  it("调用前后 mind 深度快照完全相等", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const snapshotBefore = structuredClone(mind);
        buildSourceIndex(mind, Date.now());
        expect(mind).toStrictEqual(snapshotBefore);
      }),
    );
  });

  it("JSON 序列化快照在调用前后逐字节相等", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const jsonBefore = JSON.stringify(mind);
        buildSourceIndex(mind, Date.now());
        expect(JSON.stringify(mind)).toBe(jsonBefore);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 2.4 — 活跃过滤与倒排一致性单元测试
// Requirements: 1.3, 1.4, 1.7, 1.8, 1.10
// ------------------------------------------------------------------

/** 构造最小 mind（仅填关注字段，其余空数组）。 */
function makeMind(partial: Partial<MindReadLike>): MindReadLike {
  return {
    knowledge: [],
    beliefs: [],
    userModel: [],
    ...partial,
  } as MindReadLike;
}

describe("活跃过滤：correctedBy belief 被排除 (任务 2.4, R1.3)", () => {
  it("设置了 correctedBy 的 belief 不出现在归集结果中", () => {
    const mind = makeMind({
      beliefs: [
        { id: "b1", content: "活跃判断 active belief", confidence: 0.8, source: "observed" },
        {
          id: "b2",
          content: "被推翻判断 corrected belief",
          confidence: 0.5,
          source: "inferred",
          correctedBy: "b1",
        },
      ],
    });

    const index = buildSourceIndex(mind, Date.now());
    const beliefContents = index.sources
      .filter((s) => s.kind === "belief")
      .map((s) => s.content);

    expect(beliefContents).toContain("活跃判断 active belief");
    expect(beliefContents).not.toContain("被推翻判断 corrected belief");
  });
});

describe("活跃过滤：supersededBy userModel 被排除 (任务 2.4, R1.4)", () => {
  it("设置了 supersededBy 的 userModel 不出现在归集结果中", () => {
    const mind = makeMind({
      userModel: [
        { id: "u1", aspect: "goal", content: "当前目标 active goal", confidence: 0.9 },
        {
          id: "u2",
          aspect: "goal",
          content: "旧目标 superseded goal",
          confidence: 0.4,
          supersededBy: "u1",
        },
      ],
    });

    const index = buildSourceIndex(mind, Date.now());
    const umContents = index.sources
      .filter((s) => s.kind === "userModel")
      .map((s) => s.content);

    expect(umContents).toContain("当前目标 active goal");
    expect(umContents).not.toContain("旧目标 superseded goal");
  });
});

describe("关键词抽取确定性 (任务 2.4, R1.7)", () => {
  it("相同 content 多次抽取得到完全相同的关键词集合", () => {
    const content = "用户在做 iOS 上架 TestFlight review 2026";
    const first = extractKeywords(content);
    const second = extractKeywords(content);
    const third = extractKeywords(content);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("关键词集合稳定排序、去重、归一小写", () => {
    const kws = extractKeywords("Hello HELLO hello world");
    // 已去重且小写
    expect(kws).toContain("hello");
    expect(kws).toContain("world");
    // 稳定排序：等于其自身排序结果
    expect(kws).toEqual([...kws].sort());
    // 去重：无重复元素
    expect(new Set(kws).size).toBe(kws.length);
  });
});

describe("倒排一致性：keywordIndex 与 sources 关键词集合一致 (任务 2.4, R1.8)", () => {
  it("keywordIndex 的每个键覆盖且仅覆盖含该关键词的来源 id", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const index = buildSourceIndex(mind, Date.now());

        // 1. 由 sources 重建期望倒排。
        const expected = new Map<string, Set<string>>();
        for (const s of index.sources) {
          for (const kw of s.keywords) {
            const bucket = expected.get(kw) ?? new Set<string>();
            bucket.add(s.id);
            expected.set(kw, bucket);
          }
        }

        // 2. 键集合一致。
        expect(new Set(index.keywordIndex.keys())).toEqual(
          new Set(expected.keys()),
        );

        // 3. 每个键对应的来源 id 集合一致。
        for (const [kw, ids] of index.keywordIndex) {
          expect(new Set(ids)).toEqual(expected.get(kw));
        }

        // 4. 反向：每条 source 的每个关键词都能在倒排中追溯到该 source。
        for (const s of index.sources) {
          for (const kw of s.keywords) {
            expect(index.keywordIndex.get(kw)).toContain(s.id);
          }
        }
      }),
    );
  });
});

describe("riverbed / chronotopic 结构异常按空集处理、不抛错 (任务 2.4, R1.10)", () => {
  const anomalies: unknown[] = [
    undefined,
    null,
    42,
    "not an object",
    [],
    {},
    { nodes: "not-array" },
    { nodes: [null, 1, "x", {}] },
    { nodes: [{ packet: null }, { packet: { reason: 123 } }, { packet: { reason: "" } }] },
    { signatures: "not-array" },
    { signatures: [null, {}, { scene: 123 }] },
  ];

  it("safeReadRiverbedReasons 对各类异常返回空数组且不抛错", () => {
    for (const a of anomalies) {
      expect(() => safeReadRiverbedReasons(a)).not.toThrow();
      const reasons = safeReadRiverbedReasons(a);
      expect(Array.isArray(reasons)).toBe(true);
      // 上述异常样本均无合法 reason，应为空集。
      expect(reasons).toEqual([]);
    }
  });

  it("safeReadChronoSummaries 对各类异常返回空数组且不抛错", () => {
    for (const a of anomalies) {
      expect(() => safeReadChronoSummaries(a)).not.toThrow();
      const summaries = safeReadChronoSummaries(a);
      expect(Array.isArray(summaries)).toBe(true);
      expect(summaries).toEqual([]);
    }
  });

  it("buildSourceIndex 在 riverbed/chronotopic 结构异常时不抛错且跳过这些来源", () => {
    for (const a of anomalies) {
      const mind = makeMind({
        knowledge: [{ content: "已知事实 known fact", source: "web-verified" }],
        riverbed: a,
        chronotopic: a,
      });
      expect(() => buildSourceIndex(mind, Date.now())).not.toThrow();
      const index = buildSourceIndex(mind, Date.now());
      // riverbed/chronotopic 异常按空集处理，只剩 knowledge 来源。
      expect(index.sources.every((s) => s.kind === "knowledge")).toBe(true);
      expect(index.sources).toHaveLength(1);
    }
  });

  it("结构良好的 riverbed/chronotopic 正常归集为 contextual 来源", () => {
    const mind = makeMind({
      riverbed: {
        nodes: [
          { packet: { reason: "河床理由 riverbed reason one" } },
          { packet: { reason: "  河床理由 riverbed reason two  " } },
        ],
      },
      chronotopic: {
        signatures: [
          { scene: "coding", frontAppName: "VSCode", targetRef: { id: "file1" } },
        ],
      },
    });

    const index = buildSourceIndex(mind, Date.now());
    const riverbed = index.sources.filter((s) => s.kind === "riverbed");
    const chrono = index.sources.filter((s) => s.kind === "chronotopic");

    expect(riverbed).toHaveLength(2);
    expect(riverbed.every((s) => s.truthTier === "contextual")).toBe(true);
    // 第二条 reason 已 trim。
    expect(riverbed.map((s) => s.content)).toContain(
      "河床理由 riverbed reason two",
    );

    expect(chrono).toHaveLength(1);
    expect(chrono[0].truthTier).toBe("contextual");
    expect(chrono[0].content).toBe("coding·VSCode·file1");
  });
});

// 防御：确认 mapTruthTier 的 NarrativeSourceKind 类型用于编译期约束。
const _kindCheck: NarrativeSourceKind = "knowledge";
void _kindCheck;
