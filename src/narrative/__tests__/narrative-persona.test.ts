/**
 * 叙事输出层 · 人格一致性门测试（narrative-persona.ts）
 * ------------------------------------------------------------------
 * 覆盖：
 *  - 任务 5.2 / Property 9：人格门尊重既有军法
 *    （命中至少一个 legacyPatterns ⟹ consistent === false）。
 *    **Validates: Requirements 3.2, 3.5, 8.2**
 *  - 任务 5.3 / Property 10：人格门确定性且与原文无副作用
 *    （相同输入恒返回相等 PersonaReport；调用前后 text 与 legacyPatterns 不变）。
 *    **Validates: Requirements 3.6, 3.7**
 *  - 任务 5.4：各违规类型命中、违规 kind 与 offset 记录、干净文本 consistent；
 *    内置词表与 extraForbiddenPatterns 合并而非替换。
 *    _Requirements: 3.3, 3.4_
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./narrative-persona.js、
 * ./narrative-config.js。不 import 任何 3.1/3.2 路径、不 node:sqlite、
 * 不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  checkPersona,
  BUILTIN_FORBIDDEN,
  type PersonaViolation,
} from "../narrative-persona.js";
import {
  DEFAULT_NARRATIVE_VOICE,
  type NarrativeVoiceConfig,
} from "../narrative-config.js";

/** 以 DEFAULT 为底构造合法 cfg，仅替换 extraForbiddenPatterns。 */
function cfgWith(extra: string[] = []): NarrativeVoiceConfig {
  return { ...DEFAULT_NARRATIVE_VOICE, extraForbiddenPatterns: [...extra] };
}

/** 内置禁用模式串清单（用于校验生成的"干净文本"不含任何内置子串）。 */
const BUILTIN_PATTERNS: readonly string[] = BUILTIN_FORBIDDEN.map(
  (b) => b.pattern,
);

/** 判断一段文本是否含任意内置禁用模式（用于生成干净文本的过滤）。 */
function containsAnyBuiltin(text: string): boolean {
  return BUILTIN_PATTERNS.some((p) => p.length > 0 && text.includes(p));
}

// =====================================================================
// 任务 5.2 / Property 9：人格门尊重既有军法（Req 3.2, 3.5, 8.2）
// =====================================================================
describe("narrative-persona · Property 9 人格门尊重既有军法 (Req 3.2/3.5/8.2)", () => {
  it("文本含至少一个 legacyPatterns 模式 ⟹ consistent === false", () => {
    fc.assert(
      fc.property(
        // 非空的 legacyPatterns 列表，元素为非空字符串
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.nat(),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (legacyPatterns, idx, prefix, suffix) => {
          // 选定其中一个模式，字面嵌入文本，保证 indexOf 命中
          const chosen = legacyPatterns[idx % legacyPatterns.length];
          const text = prefix + chosen + suffix;

          const report = checkPersona(text, legacyPatterns, cfgWith());

          // 命中至少一个军法模式 ⟹ 人格不一致
          expect(report.consistent).toBe(false);
          // 且违规列表中应含一条 legacy-fallback 记录命中该模式
          const hit = report.violations.find(
            (v) => v.kind === "legacy-fallback" && v.pattern === chosen,
          );
          expect(hit).toBeDefined();
        },
      ),
      { numRuns: 400 },
    );
  });
});

// =====================================================================
// 任务 5.3 / Property 10：确定性 + 无副作用（Req 3.6, 3.7）
// =====================================================================
describe("narrative-persona · Property 10 确定性且与原文无副作用 (Req 3.6/3.7)", () => {
  it("相同输入恒返回相等 PersonaReport（确定性，Req 3.6）", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
        (text, legacyPatterns, extra) => {
          const cfg = cfgWith(extra);
          const a = checkPersona(text, legacyPatterns, cfg);
          const b = checkPersona(text, legacyPatterns, cfg);
          expect(a).toEqual(b);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("调用前后 text 与 legacyPatterns 不变（无副作用，Req 3.7）", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
        (text, legacyPatterns, extra) => {
          const textBefore = text;
          const legacyBefore = structuredClone(legacyPatterns);
          const cfg = cfgWith(extra);
          const cfgBefore = structuredClone(cfg);

          checkPersona(text, legacyPatterns, cfg);

          // 字符串不可变，引用值未被替换
          expect(text).toBe(textBefore);
          // legacyPatterns 数组内容逐元素不变
          expect(legacyPatterns).toEqual(legacyBefore);
          // cfg（含 extraForbiddenPatterns）未被修改
          expect(cfg).toEqual(cfgBefore);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// =====================================================================
// 任务 5.4：各违规类型命中 / kind / offset / 干净文本 / 合并语义（Req 3.3, 3.4）
// =====================================================================
describe("narrative-persona · 任务 5.4 各违规类型与合并语义 (Req 3.3/3.4)", () => {
  it("命中 ai-self-reference 类内置模式：kind 与 offset 记录正确", () => {
    const pattern = "作为一个AI"; // BUILTIN_FORBIDDEN 中归类 ai-self-reference
    const prefix = "你好，";
    const text = prefix + pattern + "，我帮你看看。";

    const report = checkPersona(text, [], cfgWith());

    expect(report.consistent).toBe(false);
    const hit = report.violations.find((v) => v.pattern === pattern);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("ai-self-reference");
    expect(hit!.offset).toBe(text.indexOf(pattern));
    expect(hit!.offset).toBe(prefix.length);
  });

  it("命中 disclaimer-hedge 类内置模式：kind 与 offset 记录正确", () => {
    const pattern = "建议咨询专业人士"; // BUILTIN_FORBIDDEN 中归类 disclaimer-hedge
    const prefix = "这事我先说一句，";
    const text = prefix + pattern + "。";

    const report = checkPersona(text, [], cfgWith());

    expect(report.consistent).toBe(false);
    const hit = report.violations.find((v) => v.pattern === pattern);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("disclaimer-hedge");
    expect(hit!.offset).toBe(text.indexOf(pattern));
  });

  it("命中 legacy-fallback（既有军法）模式：kind 与 offset 记录正确", () => {
    const pattern = "【系统繁忙】";
    const prefix = "稍等，";
    const text = prefix + pattern + "请重试。";

    const report = checkPersona(text, [pattern], cfgWith());

    expect(report.consistent).toBe(false);
    const hit = report.violations.find((v) => v.pattern === pattern);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("legacy-fallback");
    expect(hit!.offset).toBe(prefix.length);
  });

  it("干净文本（无任何禁用/军法模式）⟹ consistent === true，violations 为空", () => {
    const text = "今天的安排我列一下：先去取件，再顺路买点水果，傍晚一起散步。";
    expect(containsAnyBuiltin(text)).toBe(false);

    const report = checkPersona(text, ["【系统繁忙】", "服务暂不可用"], cfgWith());

    expect(report.consistent).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("内置词表与 extraForbiddenPatterns 合并而非替换：仅命中 extra 也被标记", () => {
    const extra = "禁用口头禅XYZ";
    const text = "顺便说一句" + extra + "好了。";
    // 该文本不含任何内置模式，只命中 extra
    expect(containsAnyBuiltin(text)).toBe(false);

    const report = checkPersona(text, [], cfgWith([extra]));

    expect(report.consistent).toBe(false);
    const hit = report.violations.find((v) => v.pattern === extra);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("disclaimer-hedge");
    expect(hit!.offset).toBe(text.indexOf(extra));
  });

  it("存在 extra 时仍能命中内置模式（合并不替换，内置未被覆盖）", () => {
    const builtin = "我是GPT"; // ai-self-reference 内置
    const extra = "禁用口头禅XYZ";
    const text = "实话说，" + builtin + "这点先放一边。";
    // 文本只含内置模式，不含 extra
    expect(text.includes(extra)).toBe(false);

    const report = checkPersona(text, [], cfgWith([extra]));

    expect(report.consistent).toBe(false);
    const hit = report.violations.find((v) => v.pattern === builtin);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("ai-self-reference");
  });

  it("同时命中内置 + extra + legacy 三类：分别以正确 kind 记录", () => {
    const builtin = "我是Claude"; // ai-self-reference
    const extra = "免责套话ABC"; // -> disclaimer-hedge
    const legacy = "【降级回复】"; // -> legacy-fallback
    const text = `${builtin}……${extra}……${legacy}`;

    const report = checkPersona(text, [legacy], cfgWith([extra]));

    expect(report.consistent).toBe(false);
    const kinds = (k: PersonaViolation["kind"]) =>
      report.violations.filter((v) => v.kind === k).map((v) => v.pattern);
    expect(kinds("ai-self-reference")).toContain(builtin);
    expect(kinds("disclaimer-hedge")).toContain(extra);
    expect(kinds("legacy-fallback")).toContain(legacy);
  });
});
