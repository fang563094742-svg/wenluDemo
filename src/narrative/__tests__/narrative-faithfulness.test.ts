/**
 * 叙事输出层 · 忠实性门测试（narrative-faithfulness.ts）
 * ------------------------------------------------------------------
 * 覆盖 tasks.md 任务 3.2 / 3.3 / 3.4 / 3.5 / 3.6 / 3.7：
 *  - 3.2 Property 1：忠实度评分恒在 [0,1]（Requirements 2.1）
 *  - 3.3 Property 2：评分确定性（纯函数）（Requirements 2.2, 9.4）
 *  - 3.4 Property 3：无实质断言 ⟹ 满分忠实（Requirements 2.3, 2.8）
 *  - 3.5 Property 4：空来源索引下任何实质断言均不被支撑（Requirements 2.4, 2.7）
 *  - 3.6 Property 5：来源单调性 —— 加来源不降忠实度（Requirements 2.5）
 *  - 3.7 后段加重与子集性单元测试（Requirements 2.6, 2.8）
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MindReadLike, NarrativeVoiceConfig } from "../narrative-config.js";
import { buildSourceIndex, type NarrativeSourceIndex } from "../narrative-source.js";
import {
  extractAssertions,
  scoreFaithfulness,
} from "../narrative-faithfulness.js";

// ------------------------------------------------------------------
// 生成器（generators）
// ------------------------------------------------------------------

/** 合法 NarrativeVoiceConfig 生成器（各字段落在合法值域内）。 */
const cfgArb: fc.Arbitrary<NarrativeVoiceConfig> = fc.record({
  mode: fc.constantFrom("dry-run", "enforce"),
  passThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
  supportThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
  lateBoost: fc.float({ min: 0, max: 2, noNaN: true }),
  annotateMode: fc.constantFrom("off", "inline-tier", "footnote"),
  extraForbiddenPatterns: fc.array(fc.string(), { maxLength: 4 }),
}) as fc.Arbitrary<NarrativeVoiceConfig>;

/** 上游 source 字段取值池。 */
const sourceArb = fc.constantFrom(
  "web-verified",
  "file-observed",
  "observed",
  "user-said",
  "inferred",
  "inferred-unverified",
  "unknown-engine",
);

/** 非空内容片段（含中英数字，覆盖关键词抽取的两条路径）。 */
const contentFragmentArb = fc.constantFrom(
  "用户在做 iOS 上架",
  "卡在 TestFlight 审核",
  "deadline next week",
  "项目 v2 重构",
  "需要尽快交付 demo",
  "budget 5000",
  "hello world foundation",
  "时空签名 scene tokyo",
);

/** knowledge 数组（content 加唯一前缀，保证活跃且唯一）。 */
const knowledgeArrayArb = fc
  .array(fc.record({ source: sourceArb, frag: contentFragmentArb }), {
    maxLength: 6,
  })
  .map((items) =>
    items.map((it, i) => ({ content: `k${i}_${it.frag}`, source: it.source })),
  );

/** beliefs 数组（全部活跃，correctedBy 未设）。 */
const beliefsArrayArb = fc
  .array(fc.record({ source: sourceArb, frag: contentFragmentArb }), {
    maxLength: 6,
  })
  .map((items) =>
    items.map((it, i) => ({
      id: `b${i}`,
      content: `b${i}_${it.frag}`,
      confidence: 0.7,
      source: it.source,
    })),
  );

/** userModel 数组（全部活跃，supersededBy 未设）。 */
const userModelArrayArb = fc
  .array(fc.record({ frag: contentFragmentArb }), { maxLength: 6 })
  .map((items) =>
    items.map((it, i) => ({
      id: `u${i}`,
      aspect: `aspect${i}`,
      content: `u${i}_${it.frag}`,
      confidence: 0.8,
    })),
  );

/** 完整 mind 生成器。 */
const mindArb: fc.Arbitrary<MindReadLike> = fc.record({
  knowledge: knowledgeArrayArb,
  beliefs: beliefsArrayArb,
  userModel: userModelArrayArb,
}) as unknown as fc.Arbitrary<MindReadLike>;

/** 来源索引生成器（由 mind 构建，固定 nowMs 保证可复现）。 */
const FIXED_MS = 1_700_000_000_000;
const indexArb: fc.Arbitrary<NarrativeSourceIndex> = mindArb.map((mind) =>
  buildSourceIndex(mind, FIXED_MS),
);

/** 任意文本生成器（随机串 + 构造句混合）。 */
const textArb = fc.oneof(
  fc.string(),
  fc.string({ maxLength: 200 }),
  fc
    .array(contentFragmentArb, { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("。") + "。"),
);

/** 保证含实质断言的文本（陈述句，末尾句号；非疑问/寒暄/元话语）。 */
const substantiveSentenceArb = fc.constantFrom(
  "用户正在做iOS上架项目",
  "项目deadline在下周三",
  "预算大约5000元",
  "团队需要交付demo版本",
  "服务器部署在东京区域",
  "客户来自上海的科技公司",
);
const substantiveTextArb = fc
  .array(substantiveSentenceArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("。") + "。");

/** 纯寒暄 / 纯提问文本（无任何实质断言）。 */
const pleasantryTermArb = fc.constantFrom(
  "你好",
  "您好",
  "谢谢",
  "感谢",
  "再见",
  "hello",
  "hi",
  "thanks",
);
const questionBaseArb = fc.constantFrom(
  "今天天气如何",
  "项目进展怎样",
  "你觉得这样可以",
  "what time is it",
  "how are you",
);
const nonSubstantiveTextArb = fc
  .array(
    fc.oneof(
      pleasantryTermArb.map((t) => `${t}。`),
      questionBaseArb.map((q) => `${q}？`),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((parts) => parts.join(""));

// ------------------------------------------------------------------
// 任务 3.2 — Property 1：忠实度评分恒在 [0,1]
// Validates: Requirements 2.1
// ------------------------------------------------------------------

describe("Property 1: 忠实度评分恒在 [0,1] (任务 3.2)", () => {
  it("对随机 text / index / 合法 cfg，score ∈ [0,1]", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const report = scoreFaithfulness(text, index, cfg);
        expect(report.score).toBeGreaterThanOrEqual(0);
        expect(report.score).toBeLessThanOrEqual(1);
        expect(Number.isFinite(report.score)).toBe(true);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 3.3 — Property 2：评分确定性（纯函数）
// Validates: Requirements 2.2, 9.4
// ------------------------------------------------------------------

describe("Property 2: 评分确定性（纯函数）(任务 3.3)", () => {
  it("相同 (text, index, cfg) 多次调用 score 与 unsupported 完全相等", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const a = scoreFaithfulness(text, index, cfg);
        const b = scoreFaithfulness(text, index, cfg);
        const c = scoreFaithfulness(text, index, cfg);
        expect(b.score).toBe(a.score);
        expect(c.score).toBe(a.score);
        expect(b.assertionCount).toBe(a.assertionCount);
        expect(b.unsupported).toEqual(a.unsupported);
        expect(c.unsupported).toEqual(a.unsupported);
        expect(b.matchedSourceIds).toEqual(a.matchedSourceIds);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 3.4 — Property 3：无实质断言 ⟹ 满分忠实
// Validates: Requirements 2.3, 2.8
// ------------------------------------------------------------------

describe("Property 3: 无实质断言 ⟹ 满分忠实 (任务 3.4)", () => {
  it("纯寒暄 / 纯提问文本：score=1 且 unsupported=[]", () => {
    fc.assert(
      fc.property(nonSubstantiveTextArb, indexArb, cfgArb, (text, index, cfg) => {
        // 前置：生成器保证无实质断言。
        const substantive = extractAssertions(text).filter((s) => s.substantive);
        fc.pre(substantive.length === 0);

        const report = scoreFaithfulness(text, index, cfg);
        expect(report.score).toBe(1);
        expect(report.unsupported).toEqual([]);
        expect(report.assertionCount).toBe(0);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 3.5 — Property 4：空来源索引下任何实质断言均不被支撑
// Validates: Requirements 2.4, 2.7
// ------------------------------------------------------------------

describe("Property 4: 空来源索引下任何实质断言均不被支撑 (任务 3.5)", () => {
  const emptyIndex: NarrativeSourceIndex = {
    sources: [],
    keywordIndex: new Map(),
    builtAt: new Date(FIXED_MS).toISOString(),
  };

  it("含实质断言 + 空来源：unsupported.length === assertionCount 且 score=0", () => {
    fc.assert(
      fc.property(substantiveTextArb, cfgArb, (text, cfg) => {
        const substantive = extractAssertions(text).filter((s) => s.substantive);
        // 前置：生成器保证至少一个实质断言。
        fc.pre(substantive.length > 0);

        const report = scoreFaithfulness(text, emptyIndex, cfg);
        expect(report.assertionCount).toBe(substantive.length);
        expect(report.unsupported.length).toBe(report.assertionCount);
        expect(report.score).toBe(0);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 3.6 — Property 5：来源单调性 —— 加来源不降忠实度
// Validates: Requirements 2.5
// ------------------------------------------------------------------

describe("Property 5: 加来源不降忠实度 (任务 3.6)", () => {
  it("index2.sources ⊇ index1.sources ⟹ score(text, index2) ≥ score(text, index1)", () => {
    fc.assert(
      fc.property(
        mindArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        textArb,
        cfgArb,
        (mind, ka, kb, ku, text, cfg) => {
          // 由 mind 的前缀子集构建 index1（子集），全集构建 index2（超集）。
          const subMind: MindReadLike = {
            knowledge: mind.knowledge.slice(0, ka % (mind.knowledge.length + 1)),
            beliefs: mind.beliefs.slice(0, kb % (mind.beliefs.length + 1)),
            userModel: mind.userModel.slice(0, ku % (mind.userModel.length + 1)),
          } as MindReadLike;

          const index1 = buildSourceIndex(subMind, FIXED_MS);
          const index2 = buildSourceIndex(mind, FIXED_MS);

          // 校验 index2.sources ⊇ index1.sources（按稳定 id）。
          const ids2 = new Set(index2.sources.map((s) => s.id));
          for (const s of index1.sources) {
            expect(ids2.has(s.id)).toBe(true);
          }

          const score1 = scoreFaithfulness(text, index1, cfg).score;
          const score2 = scoreFaithfulness(text, index2, cfg).score;

          // 加来源不降忠实度（容忍浮点误差）。
          expect(score2).toBeGreaterThanOrEqual(score1 - 1e-9);
        },
      ),
    );
  });
});

// ------------------------------------------------------------------
// 任务 3.7 — 后段加重与子集性单元测试
// Requirements: 2.6, 2.8
// ------------------------------------------------------------------

describe("后段加重：靠后的断言权重更高 (任务 3.7, R2.6)", () => {
  it("受支撑断言越靠后，整体忠实度越高", () => {
    // 来源仅支撑关键词 "alpha"。
    const index = buildSourceIndex(
      { knowledge: [{ content: "alpha", source: "web-verified" }], beliefs: [], userModel: [] } as MindReadLike,
      FIXED_MS,
    );

    const cfg: NarrativeVoiceConfig = {
      mode: "dry-run",
      passThreshold: 0.6,
      supportThreshold: 0.3,
      lateBoost: 1,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };

    // 两段实质断言：一段含 alpha（受支撑），一段 beta（不受支撑）。
    // 文本长度相同，仅顺序不同 → totalWeight 相同，受支撑段越靠后权重越大。
    const supportedEarly = "alpha matches。beta unmatched。";
    const supportedLate = "beta unmatched。alpha matches。";

    const scoreEarly = scoreFaithfulness(supportedEarly, index, cfg).score;
    const scoreLate = scoreFaithfulness(supportedLate, index, cfg).score;

    // 健全性：两段都恰有一个受支撑断言。
    expect(scoreFaithfulness(supportedEarly, index, cfg).matchedSourceIds.length).toBeGreaterThan(0);
    expect(scoreFaithfulness(supportedLate, index, cfg).matchedSourceIds.length).toBeGreaterThan(0);

    // 后段加重：受支撑断言靠后时忠实度更高。
    expect(scoreLate).toBeGreaterThan(scoreEarly);
  });

  it("lateBoost=0 时位置不影响评分（退化为均权）", () => {
    const index = buildSourceIndex(
      { knowledge: [{ content: "alpha", source: "web-verified" }], beliefs: [], userModel: [] } as MindReadLike,
      FIXED_MS,
    );
    const cfg: NarrativeVoiceConfig = {
      mode: "dry-run",
      passThreshold: 0.6,
      supportThreshold: 0.3,
      lateBoost: 0,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };
    const a = scoreFaithfulness("alpha matches。beta unmatched。", index, cfg).score;
    const b = scoreFaithfulness("beta unmatched。alpha matches。", index, cfg).score;
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("子集性：unsupported ⊆ 实质断言集 (任务 3.7, R2.8)", () => {
  it("报告中每个 unsupported 都是实质断言且属于 extractAssertions 的实质子集", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const report = scoreFaithfulness(text, index, cfg);
        const substantive = extractAssertions(text).filter((s) => s.substantive);
        const key = (s: { text: string; offset: number }) => `${s.offset}::${s.text}`;
        const substantiveKeys = new Set(substantive.map(key));

        for (const span of report.unsupported) {
          // 每个 unsupported 自身必须是实质断言。
          expect(span.substantive).toBe(true);
          // 且必属于实质断言集合。
          expect(substantiveKeys.has(key(span))).toBe(true);
        }
        // unsupported 数量不超过实质断言总数。
        expect(report.unsupported.length).toBeLessThanOrEqual(substantive.length);
      }),
    );
  });
});
