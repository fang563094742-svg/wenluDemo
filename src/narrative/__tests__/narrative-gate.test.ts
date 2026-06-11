/**
 * 叙事输出层 · 质量门编排器测试（narrative-gate.ts）
 * ------------------------------------------------------------------
 * 覆盖 tasks.md 任务 7.2 / 7.3 / 7.4 / 7.5 / 7.6：
 *  - 7.2 Property 6：gateNarrative 永不空、永不抛（Requirements 5.1, 5.2, 5.9, 9.5）
 *  - 7.3 Property 7：dry-run 行为零改变（pass 分支）（Requirements 5.4, 5.5, 8.4）
 *  - 7.4 Property 8：annotate 原文是结果前缀（Requirements 4.2, 4.3, 4.4, 5.6）
 *  - 7.5 Property 12：叙事层不夹带可执行指令（Requirements 7.4）
 *  - 7.6 enforce 裁决与 note 隔离单元测试（Requirements 5.7, 5.8, 5.10）
 *  - 贯穿：verdict 恒为四种之一（Requirements 5.3）
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MindReadLike, NarrativeVoiceConfig } from "../narrative-config.js";
import { buildSourceIndex, type NarrativeSourceIndex } from "../narrative-source.js";
import {
  gateNarrative,
  type NarrativeVerdict,
} from "../narrative-gate.js";

// ------------------------------------------------------------------
// 常量与工具
// ------------------------------------------------------------------

const FIXED_MS = 1_700_000_000_000;

/** 四种合法 verdict 集合（Requirements 5.3）。 */
const VALID_VERDICTS: ReadonlySet<NarrativeVerdict> = new Set([
  "pass",
  "annotate",
  "fallback",
  "reject",
]);

/** 禁止出现的引擎触发字段名（no-engine-trigger，Requirements 7.4）。 */
const FORBIDDEN_ENGINE_TOKENS = [
  "enginePacket",
  "executionAllowed",
  "selectedEngine",
] as const;

/** 空来源索引（用于强制低忠实度 / 无支撑场景）。 */
const emptyIndex: NarrativeSourceIndex = {
  sources: [],
  keywordIndex: new Map(),
  builtAt: new Date(FIXED_MS).toISOString(),
};

/** 递归收集对象所有字段名（用于 Property 12 字段名扫描）。 */
function collectFieldNames(value: unknown, acc: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      if (typeof k === "string") acc.add(k);
      collectFieldNames(v, acc, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFieldNames(item, acc, depth + 1);
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    acc.add(key);
    collectFieldNames((value as Record<string, unknown>)[key], acc, depth + 1);
  }
}

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

/** 上游 source 字段取值池（含 inferred 以便触发 annotate）。 */
const sourceArb = fc.constantFrom(
  "web-verified",
  "file-observed",
  "observed",
  "user-said",
  "inferred",
  "inferred-unverified",
  "unknown-engine",
);

/** 非空内容片段（含中英数字）。 */
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

const knowledgeArrayArb = fc
  .array(fc.record({ source: sourceArb, frag: contentFragmentArb }), {
    maxLength: 6,
  })
  .map((items) =>
    items.map((it, i) => ({ content: `k${i}_${it.frag}`, source: it.source })),
  );

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

const mindArb: fc.Arbitrary<MindReadLike> = fc.record({
  knowledge: knowledgeArrayArb,
  beliefs: beliefsArrayArb,
  userModel: userModelArrayArb,
}) as unknown as fc.Arbitrary<MindReadLike>;

const indexArb: fc.Arbitrary<NarrativeSourceIndex> = mindArb.map((mind) =>
  buildSourceIndex(mind, FIXED_MS),
);

/** 任意文本生成器（随机串、空串、超长、特殊字符、构造句混合）。 */
const textArb = fc.oneof(
  fc.string(),
  fc.constant(""),
  fc.string({ maxLength: 500 }),
  fc.constant("作为一个AI，我无法提供帮助。😀\u0000\t特殊字符\n换行"),
  fc.constant("x".repeat(5000)),
  fc
    .array(contentFragmentArb, { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("。") + "。"),
);

// ------------------------------------------------------------------
// 任务 7.2 — Property 6：gateNarrative 永不空、永不抛
// Validates: Requirements 5.1, 5.2, 5.9, 9.5
// ------------------------------------------------------------------

describe("Property 6: gateNarrative 永不空、永不抛 (任务 7.2)", () => {
  it("随机字符串（含空串/超长/特殊字符）：不抛异常，输入非空时 text 非空", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const result = gateNarrative(text, index, cfg);
        // 不抛异常（能走到这里即已满足）。
        // verdict 恒为四种之一（R5.3）。
        expect(VALID_VERDICTS.has(result.verdict)).toBe(true);
        // text 恒为字符串。
        expect(typeof result.text).toBe("string");
        // 输入非空 ⟹ 输出非空。
        if (String(text ?? "").length > 0) {
          expect(result.text.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("各种异常形态的 index / cfg 也不抛错（降级安全 fail-open）", () => {
    fc.assert(
      fc.property(textArb, (text) => {
        // 故意传入结构异常的 index / cfg，验证 fail-open。
        const brokenIndex = {
          sources: null,
          keywordIndex: undefined,
          builtAt: "",
        } as unknown as NarrativeSourceIndex;
        const brokenCfg = {} as unknown as NarrativeVoiceConfig;
        const result = gateNarrative(text, brokenIndex, brokenCfg);
        expect(VALID_VERDICTS.has(result.verdict)).toBe(true);
        if (String(text ?? "").length > 0) {
          expect(result.text.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 7.3 — Property 7：dry-run 行为零改变（pass 分支）
// Validates: Requirements 5.4, 5.5, 8.4
// ------------------------------------------------------------------

describe("Property 7: dry-run 行为零改变（pass 分支）(任务 7.3)", () => {
  it("dry-run 且 verdict=pass ⟹ result.text === 输入 text", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const dryCfg: NarrativeVoiceConfig = { ...cfg, mode: "dry-run" };
        const result = gateNarrative(text, index, dryCfg);
        // dry-run 仅产出 pass / annotate（R5.4）。
        expect(["pass", "annotate"]).toContain(result.verdict);
        if (result.verdict === "pass") {
          expect(result.text).toBe(String(text ?? ""));
        }
      }),
    );
  });

  it("dry-run + annotateMode=off ⟹ 恒为 pass 且逐字节恒等（零回归）", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const dryCfg: NarrativeVoiceConfig = {
          ...cfg,
          mode: "dry-run",
          annotateMode: "off",
        };
        const result = gateNarrative(text, index, dryCfg);
        expect(result.verdict).toBe("pass");
        expect(result.text).toBe(String(text ?? ""));
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 7.4 — Property 8：annotate 原文是结果前缀
// Validates: Requirements 4.2, 4.3, 4.4, 5.6
// ------------------------------------------------------------------

describe("Property 8: annotate 原文是结果前缀 (任务 7.4)", () => {
  it("verdict=annotate ⟹ result.text 以原文 text 为前缀", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const result = gateNarrative(text, index, cfg);
        if (result.verdict === "annotate") {
          expect(result.text.startsWith(String(text ?? ""))).toBe(true);
        }
      }),
    );
  });

  it("构造能触发 annotate 的场景：inferred 来源支撑 + annotateMode 开启 + 原文为前缀", () => {
    // mind 内含 inferred 来源（source=inferred），文本复用其关键词以获得支撑命中。
    const mind: MindReadLike = {
      knowledge: [{ content: "项目重构计划 alpha beta", source: "inferred" }],
      beliefs: [],
      userModel: [],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);
    const text = "项目重构计划 alpha beta 已经确定。";
    const cfg: NarrativeVoiceConfig = {
      mode: "dry-run",
      passThreshold: 0.6,
      supportThreshold: 0.1,
      lateBoost: 0.5,
      annotateMode: "inline-tier",
      extraForbiddenPatterns: [],
    };
    const result = gateNarrative(text, index, cfg);
    // 命中 inferred 支撑应走 annotate 分支。
    expect(result.verdict).toBe("annotate");
    expect(result.text.startsWith(text)).toBe(true);
    // 仅追加、不删改：结果长度 >= 原文。
    expect(result.text.length).toBeGreaterThanOrEqual(text.length);
  });
});

// ------------------------------------------------------------------
// 任务 7.5 — Property 12：叙事层不夹带可执行指令
// Validates: Requirements 7.4
// ------------------------------------------------------------------

describe("Property 12: 叙事层不夹带可执行指令 (任务 7.5)", () => {
  it("随机输入：输出文本与返回对象（递归）字段名均不含引擎触发字段", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const result = gateNarrative(text, index, cfg);

        // 1. 输出文本不含引擎触发 token。
        for (const token of FORBIDDEN_ENGINE_TOKENS) {
          expect(result.text.includes(token)).toBe(false);
        }

        // 2. 返回对象所有字段名（递归 Object.keys）不含引擎触发字段。
        const fieldNames = new Set<string>();
        collectFieldNames(result, fieldNames);
        for (const token of FORBIDDEN_ENGINE_TOKENS) {
          expect(fieldNames.has(token)).toBe(false);
        }
      }),
    );
  });
});

// ------------------------------------------------------------------
// 任务 7.6 — enforce 裁决与 note 隔离单元测试
// Requirements: 5.7, 5.8, 5.10（兼顾 5.3）
// ------------------------------------------------------------------

describe("enforce 裁决与 note 隔离 (任务 7.6)", () => {
  it("enforce + persona 违规（内置禁用模式）⟹ reject（中性重述提示）", () => {
    const cfg: NarrativeVoiceConfig = {
      mode: "enforce",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };
    // 文本含内置禁用模式「作为一个AI」。
    const text = "作为一个AI，我来帮你分析这个项目。";
    const result = gateNarrative(text, emptyIndex, cfg);
    expect(result.verdict).toBe("reject");
    // reject 文本是中性重述提示，不等于原文（不泄露违规原文）。
    expect(result.persona.consistent).toBe(false);
    expect(result.text).not.toBe(text);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("enforce + persona 违规（extraForbiddenPatterns 命中）⟹ reject", () => {
    const cfg: NarrativeVoiceConfig = {
      mode: "enforce",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: ["禁忌口头禅"],
    };
    const text = "这里有一句禁忌口头禅出现了。";
    const result = gateNarrative(text, emptyIndex, cfg);
    expect(result.verdict).toBe("reject");
    expect(result.persona.consistent).toBe(false);
  });

  it("enforce + 低忠实度（实质断言 + 空来源）⟹ fallback 放行原文", () => {
    const cfg: NarrativeVoiceConfig = {
      mode: "enforce",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };
    // 实质断言文本 + 空来源 ⟹ score=0 < passThreshold ⟹ fallback。
    const text = "服务器部署在东京区域，预算大约五千元。";
    const result = gateNarrative(text, emptyIndex, cfg);
    expect(result.verdict).toBe("fallback");
    // fallback 放行原文（逐字节）。
    expect(result.text).toBe(text);
    // 忠实度确实低于阈值。
    expect(result.faithfulness.score).toBeLessThan(cfg.passThreshold);
  });

  it("note 内容不泄露进 text（各裁决分支）", () => {
    const baseCfg: NarrativeVoiceConfig = {
      mode: "enforce",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };

    // reject 分支
    const rejectRes = gateNarrative("作为一个AI 帮你。", emptyIndex, baseCfg);
    expect(rejectRes.verdict).toBe("reject");
    expect(rejectRes.note.length).toBeGreaterThan(0);
    expect(rejectRes.text.includes(rejectRes.note)).toBe(false);

    // fallback 分支
    const fallbackRes = gateNarrative(
      "服务器部署在东京区域，预算大约五千元。",
      emptyIndex,
      baseCfg,
    );
    expect(fallbackRes.verdict).toBe("fallback");
    expect(fallbackRes.note.length).toBeGreaterThan(0);
    expect(fallbackRes.text.includes(fallbackRes.note)).toBe(false);
  });

  it("verdict 恒为四种之一（R5.3）跨 dry-run/enforce 随机校验", () => {
    fc.assert(
      fc.property(textArb, indexArb, cfgArb, (text, index, cfg) => {
        const result = gateNarrative(text, index, cfg);
        expect(VALID_VERDICTS.has(result.verdict)).toBe(true);
      }),
    );
  });
});
