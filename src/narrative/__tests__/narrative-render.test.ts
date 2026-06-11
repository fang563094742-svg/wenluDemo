/**
 * 叙事输出层 · 可追溯渲染器测试（narrative-render.ts）
 * ------------------------------------------------------------------
 * 覆盖 tasks.md 任务 6.2 / 6.3：
 *  - 6.2 Property 13：annotateMode="off" ⟹ renderNarrativeOutput 恒等（Requirements 4.1）
 *  - 6.3 单元：inline-tier / footnote 模式下原文为结果前缀、原断言语义不变（仅追加）；
 *        渲染异常时 fail-open 返回原文（Requirements 4.2, 4.3, 4.4, 4.6）
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MindReadLike, NarrativeVoiceConfig } from "../narrative-config.js";
import { buildSourceIndex, type NarrativeSourceIndex } from "../narrative-source.js";
import {
  scoreFaithfulness,
  type FaithfulnessReport,
} from "../narrative-faithfulness.js";
import type { PersonaReport } from "../narrative-persona.js";
import { renderNarrativeOutput } from "../narrative-render.js";

// ------------------------------------------------------------------
// 共享脚手架
// ------------------------------------------------------------------

const FIXED_MS = 1_700_000_000_000;

/** 干净的人格报告（渲染当前不依赖其内容，仅契合统一签名）。 */
const CLEAN_PERSONA: PersonaReport = { consistent: true, violations: [] };

/** 构造合法配置（仅 annotateMode 按用例变化）。 */
function makeCfg(
  annotateMode: NarrativeVoiceConfig["annotateMode"],
  supportThreshold = 0.3,
): NarrativeVoiceConfig {
  return {
    mode: "dry-run",
    passThreshold: 0.6,
    supportThreshold,
    lateBoost: 0.5,
    annotateMode,
    extraForbiddenPatterns: [],
  };
}

// ------------------------------------------------------------------
// 任务 6.2 — Property 13：annotateMode="off" ⟹ 渲染恒等
// Validates: Requirements 4.1
// ------------------------------------------------------------------

describe("Property 13: annotateMode=off ⟹ 渲染恒等 (任务 6.2)", () => {
  /** 任意文本生成器（随机串 + 含中英数字的构造句混合）。 */
  const textArb = fc.oneof(
    fc.string(),
    fc.string({ maxLength: 200 }),
    fc.constantFrom(
      "用户正在做iOS上架项目。",
      "项目deadline在下周三。你好。",
      "hello world。预算大约5000元。",
    ),
  );

  /** 随机 mind → 来源索引（off 模式下渲染应与索引/报告无关）。 */
  const indexArb: fc.Arbitrary<NarrativeSourceIndex> = fc
    .array(
      fc.record({
        content: fc.constantFrom(
          "用户在做 iOS 上架",
          "deadline next week",
          "项目 v2 重构",
        ),
        source: fc.constantFrom("web-verified", "inferred", "user-said"),
      }),
      { maxLength: 4 },
    )
    .map((knowledge) => {
      const mind = {
        knowledge: knowledge.map((k, i) => ({
          content: `k${i}_${k.content}`,
          source: k.source,
        })),
        beliefs: [],
        userModel: [],
      } as MindReadLike;
      return buildSourceIndex(mind, FIXED_MS);
    });

  it("对随机 text，off 模式逐字节恒等返回原文", () => {
    fc.assert(
      fc.property(textArb, indexArb, (text, index) => {
        const faith = scoreFaithfulness(text, index, makeCfg("off"));
        const out = renderNarrativeOutput(
          text,
          index,
          faith,
          CLEAN_PERSONA,
          makeCfg("off"),
        );
        expect(out).toBe(text);
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 6.3 — 单元：annotate 前缀语义 + 异常兜底
// Requirements: 4.2, 4.3, 4.4, 4.6
// ------------------------------------------------------------------

describe("inline-tier 模式：未验证来源支撑时追加分层提示，原文为前缀 (任务 6.3, R4.2/R4.4)", () => {
  it("inferred 来源支撑断言 ⟹ 文末追加分层提示，原文恒为结果前缀且原断言语义不变", () => {
    // knowledge.source="inferred" ⟹ truthTier="inferred"（未验证来源）。
    const mind = {
      knowledge: [{ content: "用户正在做iOS上架项目", source: "inferred" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);

    const text = "用户正在做iOS上架项目。";
    const cfg = makeCfg("inline-tier");
    const faith = scoreFaithfulness(text, index, cfg);

    // 健全性：断言确由 inferred 来源命中。
    expect(faith.matchedSourceIds.length).toBeGreaterThan(0);
    const matchedTiers = faith.matchedSourceIds.map(
      (id) => index.sources.find((s) => s.id === id)?.truthTier,
    );
    expect(matchedTiers).toContain("inferred");

    const out = renderNarrativeOutput(text, index, faith, CLEAN_PERSONA, cfg);

    // 原文恒为结果前缀（仅追加、不删改原断言）。
    expect(out.startsWith(text)).toBe(true);
    // 确实追加了分层提示（结果比原文更长）。
    expect(out.length).toBeGreaterThan(text.length);
    // 追加部分仅为分层提示，原断言文本逐字保留。
    expect(out.slice(0, text.length)).toBe(text);
    expect(out).toContain("推断");
  });

  it("无未验证来源支撑时 inline-tier 恒等返回原文（不无故增改）", () => {
    // 全部 verified ⟹ 无 inferred 支撑 ⟹ 不追加提示。
    const mind = {
      knowledge: [{ content: "用户正在做iOS上架项目", source: "web-verified" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);
    const text = "用户正在做iOS上架项目。";
    const cfg = makeCfg("inline-tier");
    const faith = scoreFaithfulness(text, index, cfg);

    const out = renderNarrativeOutput(text, index, faith, CLEAN_PERSONA, cfg);
    expect(out).toBe(text);
  });
});

describe("footnote 模式：命中来源时文末追加脚注，原文为前缀 (任务 6.3, R4.3/R4.4)", () => {
  it("命中来源 ⟹ 文末追加来源脚注，原文恒为结果前缀且原断言语义不变", () => {
    const mind = {
      knowledge: [{ content: "用户正在做iOS上架项目", source: "web-verified" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);

    const text = "用户正在做iOS上架项目。";
    const cfg = makeCfg("footnote");
    const faith = scoreFaithfulness(text, index, cfg);

    // 健全性：确有命中来源。
    expect(faith.matchedSourceIds.length).toBeGreaterThan(0);

    const out = renderNarrativeOutput(text, index, faith, CLEAN_PERSONA, cfg);

    // 原文恒为结果前缀，脚注仅追加在其后。
    expect(out.startsWith(text)).toBe(true);
    expect(out.length).toBeGreaterThan(text.length);
    expect(out.slice(0, text.length)).toBe(text);
    // 脚注区出现来源标题。
    expect(out).toContain("来源：");
  });

  it("无命中来源时 footnote 恒等返回原文", () => {
    // 文本与任何来源无关键词重叠 ⟹ 无命中 ⟹ 不追加脚注。
    const mind = {
      knowledge: [{ content: "完全无关的内容alpha", source: "web-verified" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);
    const text = "毫不相干的另一句话beta。";
    const cfg = makeCfg("footnote");
    const faith = scoreFaithfulness(text, index, cfg);

    expect(faith.matchedSourceIds.length).toBe(0);
    const out = renderNarrativeOutput(text, index, faith, CLEAN_PERSONA, cfg);
    expect(out).toBe(text);
  });
});

describe("annotate 前缀属性：非 off 模式下原文恒为结果前缀 (任务 6.3, R4.4)", () => {
  const mind = {
    knowledge: [
      { content: "用户正在做iOS上架项目", source: "inferred" },
      { content: "项目deadline在下周三", source: "web-verified" },
    ],
    beliefs: [],
    userModel: [],
  } as MindReadLike;
  const index = buildSourceIndex(mind, FIXED_MS);

  const textArb = fc.constantFrom(
    "用户正在做iOS上架项目。",
    "项目deadline在下周三。",
    "用户正在做iOS上架项目。项目deadline在下周三。",
    "完全无关beta。",
    "",
  );
  const modeArb = fc.constantFrom<NarrativeVoiceConfig["annotateMode"]>(
    "inline-tier",
    "footnote",
  );

  it("inline-tier / footnote 下结果恒以原文为前缀", () => {
    fc.assert(
      fc.property(textArb, modeArb, (text, mode) => {
        const cfg = makeCfg(mode);
        const faith = scoreFaithfulness(text, index, cfg);
        const out = renderNarrativeOutput(text, index, faith, CLEAN_PERSONA, cfg);
        expect(out.startsWith(text)).toBe(true);
      }),
    );
  });
});

describe("异常兜底：渲染抛错时 fail-open 返回原文 (任务 6.3, R4.6)", () => {
  it("faith 访问抛错（非 off 模式）⟹ 返回原文，绝不阻断说话", () => {
    const mind = {
      knowledge: [{ content: "用户正在做iOS上架项目", source: "inferred" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);

    const text = "用户正在做iOS上架项目。";
    // 构造在读取 matchedSourceIds 时抛错的恶意/畸形 faith：触发渲染内部 try/catch。
    const malformedFaith = {
      score: 0,
      assertionCount: 0,
      unsupported: [],
      get matchedSourceIds(): string[] {
        throw new Error("boom: malformed faith report");
      },
    } as unknown as FaithfulnessReport;

    // footnote 模式会读取 matchedSourceIds，触发抛错路径。
    const outFootnote = renderNarrativeOutput(
      text,
      index,
      malformedFaith,
      CLEAN_PERSONA,
      makeCfg("footnote"),
    );
    expect(outFootnote).toBe(text);

    // inline-tier 模式同样读取 matchedSourceIds，亦走兜底。
    const outInline = renderNarrativeOutput(
      text,
      index,
      malformedFaith,
      CLEAN_PERSONA,
      makeCfg("inline-tier"),
    );
    expect(outInline).toBe(text);
  });

  it("off 模式即便 faith 畸形也恒等返回原文（早于任何读取）", () => {
    const mind = { knowledge: [], beliefs: [], userModel: [] } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);
    const text = "任意文本content。";
    const malformedFaith = {
      get matchedSourceIds(): string[] {
        throw new Error("boom");
      },
    } as unknown as FaithfulnessReport;

    const out = renderNarrativeOutput(
      text,
      index,
      malformedFaith,
      CLEAN_PERSONA,
      makeCfg("off"),
    );
    expect(out).toBe(text);
  });
});
