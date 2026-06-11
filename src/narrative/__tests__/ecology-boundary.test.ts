/**
 * 叙事输出层 · 生态平衡 / 职责边界硬覆盖测试（最高约束，不可跳过）
 * ==================================================================
 * 对应 tasks.md 任务 10.2。这是本功能**最高约束**的硬覆盖测试，必须真实通过——
 * 若实现违反职责边界（写了 mind、造了新内容、夹带引擎字段、dry-run off 改了文本），
 * 本测试将精确暴露违规，绝不弱化。
 *
 * 断言项（参见 requirements.md Requirement 7 / 8.4）：
 *  (a) buildSourceIndex 调用前后对 mind 做深快照逐字段相等
 *      —— 不写记忆、不调任何 mind 写路径（R7.2 / R7.3）。
 *  (b) 叙事层不生成新 knowledge / 新 belief：buildSourceIndex 输出 source 数 ≤ 输入
 *      归集来源数，且每条 source.content 都能在原 mind 已有内容
 *      （knowledge / beliefs / userModel / riverbed reasons / chronotopic summaries）
 *      中找到对应来源（R7.3 / R7.5）。
 *  (c) gateNarrative 与 renderNarrativeOutput 的返回对象字段名与输出文本
 *      均不含引擎触发字段（enginePacket / executionAllowed / selectedEngine，
 *      no-engine-trigger，R7.4）。
 *  (d) dry-run + annotateMode="off" 下 gateNarrative 输出与输入逐字节相等（零回归，R8.4）。
 *  (e) renderNarrativeOutput 在 annotateMode="off" 下逐字节恒等（R7.6 忠实表达 / R8.4）。
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MindReadLike, NarrativeVoiceConfig } from "../narrative-config.js";
import {
  buildSourceIndex,
  safeReadRiverbedReasons,
  safeReadChronoSummaries,
  type NarrativeSourceIndex,
} from "../narrative-source.js";
import { gateNarrative } from "../narrative-gate.js";
import { renderNarrativeOutput } from "../narrative-render.js";
import type { FaithfulnessReport } from "../narrative-faithfulness.js";
import type { PersonaReport } from "../narrative-persona.js";

// ------------------------------------------------------------------
// 常量与工具
// ------------------------------------------------------------------

const FIXED_MS = 1_700_000_000_000;

/** 禁止出现的引擎触发字段名（no-engine-trigger，Requirements 7.4）。 */
const FORBIDDEN_ENGINE_TOKENS = [
  "enginePacket",
  "executionAllowed",
  "selectedEngine",
] as const;

/** 递归收集对象所有字段名（用于字段名扫描）。 */
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

/**
 * 计算 buildSourceIndex 应当归集的「输入来源数」与「合法 content 集合」。
 * 完全复刻 narrative-source 的归集口径（活跃过滤 + 非空 trim + 窄化读取），
 * 作为 (b) 的独立参照，确保叙事层零新增语义。
 */
function deriveAllowed(mind: MindReadLike): {
  candidateCount: number;
  allowedContents: Set<string>;
} {
  const allowed = new Set<string>();
  let count = 0;

  const pushIfNonEmpty = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    allowed.add(trimmed);
    count += 1;
  };

  // knowledge（非空）。
  for (const k of Array.isArray(mind.knowledge) ? mind.knowledge : []) {
    pushIfNonEmpty(k?.content);
  }
  // 活跃 beliefs（correctedBy 未设、非空）。
  for (const b of Array.isArray(mind.beliefs) ? mind.beliefs : []) {
    if (b?.correctedBy !== undefined && b.correctedBy !== null) continue;
    pushIfNonEmpty(b?.content);
  }
  // 活跃 userModel（supersededBy 未设、非空）。
  for (const u of Array.isArray(mind.userModel) ? mind.userModel : []) {
    if (u?.supersededBy !== undefined && u.supersededBy !== null) continue;
    pushIfNonEmpty(u?.content);
  }
  // riverbed reasons（窄化读取，已 trim）。
  for (const reason of safeReadRiverbedReasons(mind.riverbed)) {
    allowed.add(reason);
    count += 1;
  }
  // chronotopic summaries（窄化读取）。
  for (const summary of safeReadChronoSummaries(mind.chronotopic)) {
    allowed.add(summary);
    count += 1;
  }

  return { candidateCount: count, allowedContents: allowed };
}

// ------------------------------------------------------------------
// 生成器（generators）
// ------------------------------------------------------------------

/** 非空内容片段（含中英数字）。 */
const contentFragmentArb = fc.constantFrom(
  "用户在做 iOS 上架",
  "卡在 TestFlight 审核",
  "deadline next week",
  "项目 v2 重构计划",
  "需要尽快交付 demo",
  "budget 5000 元",
  "hello world foundation",
  "服务器部署在东京区域",
);

/** 上游 source 字段取值池（含 inferred 以覆盖各 truthTier）。 */
const sourceArb = fc.constantFrom(
  "web-verified",
  "file-observed",
  "observed",
  "user-said",
  "inferred",
  "inferred-unverified",
  "unknown-source",
);

const knowledgeArrayArb = fc
  .array(fc.record({ source: sourceArb, frag: contentFragmentArb }), {
    maxLength: 5,
  })
  .map((items) =>
    items.map((it, i) => ({ content: `k${i}_${it.frag}`, source: it.source })),
  );

const beliefsArrayArb = fc
  .array(
    fc.record({
      source: sourceArb,
      frag: contentFragmentArb,
      corrected: fc.boolean(),
    }),
    { maxLength: 5 },
  )
  .map((items) =>
    items.map((it, i) => {
      const base = {
        id: `b${i}`,
        content: `b${i}_${it.frag}`,
        confidence: 0.7,
        source: it.source,
      };
      // 部分 belief 被推翻（correctedBy 设置）→ 应被排除。
      return it.corrected ? { ...base, correctedBy: `c${i}` } : base;
    }),
  );

const userModelArrayArb = fc
  .array(fc.record({ frag: contentFragmentArb, superseded: fc.boolean() }), {
    maxLength: 5,
  })
  .map((items) =>
    items.map((it, i) => {
      const base = {
        id: `u${i}`,
        aspect: `aspect${i}`,
        content: `u${i}_${it.frag}`,
        confidence: 0.8,
      };
      return it.superseded ? { ...base, supersededBy: `s${i}` } : base;
    }),
  );

/** 河床结构（窄化读取器可消费：nodes[].packet.reason）。 */
const riverbedArb = fc.option(
  fc
    .array(fc.record({ frag: contentFragmentArb }), { maxLength: 4 })
    .map((items) => ({
      nodes: items.map((it, i) => ({
        id: `n${i}`,
        packet: { reason: `riverbed_${i}_${it.frag}` },
      })),
    })),
  { nil: undefined },
);

/** 时空结构（窄化读取器可消费：signatures[].scene/frontAppName/targetRef.id）。 */
const chronotopicArb = fc.option(
  fc
    .array(fc.record({ frag: contentFragmentArb }), { maxLength: 4 })
    .map((items) => ({
      signatures: items.map((it, i) => ({
        scene: `scene_${i}`,
        frontAppName: it.frag,
        targetRef: { id: `target_${i}` },
      })),
    })),
  { nil: undefined },
);

const mindArb: fc.Arbitrary<MindReadLike> = fc.record({
  knowledge: knowledgeArrayArb,
  beliefs: beliefsArrayArb,
  userModel: userModelArrayArb,
  riverbed: riverbedArb,
  chronotopic: chronotopicArb,
}) as unknown as fc.Arbitrary<MindReadLike>;

/** 合法 NarrativeVoiceConfig 生成器（各字段落在合法值域内）。 */
const cfgArb: fc.Arbitrary<NarrativeVoiceConfig> = fc.record({
  mode: fc.constantFrom("dry-run", "enforce"),
  passThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
  supportThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
  lateBoost: fc.float({ min: 0, max: 2, noNaN: true }),
  annotateMode: fc.constantFrom("off", "inline-tier", "footnote"),
  extraForbiddenPatterns: fc.array(fc.string(), { maxLength: 3 }),
}) as fc.Arbitrary<NarrativeVoiceConfig>;

/** 任意文本生成器（随机串、空串、超长、特殊字符、构造句混合）。 */
const textArb = fc.oneof(
  fc.string(),
  fc.constant(""),
  fc.string({ maxLength: 300 }),
  fc.constant("作为一个AI，我无法提供帮助。😀\u0000\t特殊字符\n换行"),
  fc.constant("x".repeat(3000)),
  fc
    .array(contentFragmentArb, { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("。") + "。"),
);

/** (d)(e) 用的一组代表性样本文本。 */
const SAMPLE_TEXTS: ReadonlyArray<string> = [
  "",
  "你好。",
  "用户在做 iOS 上架，卡在 TestFlight 审核这步。",
  "deadline next week, budget 5000.",
  "服务器部署在东京区域，预算大约五千元。明天交付 demo。",
  "作为一个AI，我无法提供帮助。",
  "多行文本\n第二行\r\n第三行。",
  "特殊字符 😀🚀\u0000\t 末尾。",
  "x".repeat(2000),
  "纯提问吗？这是什么呢？",
];

// ------------------------------------------------------------------
// (a) buildSourceIndex 调用前后 mind 深快照逐字段相等（只读，不写记忆）
// Validates: Requirements 7.2, 7.3
// ------------------------------------------------------------------

describe("(a) buildSourceIndex 只读：调用前后 mind 深快照逐字段相等", () => {
  it("随机 mind：JSON 深快照前后完全相等（不写记忆、不调任何写路径）", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const before = JSON.stringify(mind);
        buildSourceIndex(mind, FIXED_MS);
        const after = JSON.stringify(mind);
        expect(after).toBe(before);
      }),
    );
  });

  it("structuredClone 深比较前后 mind 引用内容不变", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const snapshot = structuredClone(mind);
        buildSourceIndex(mind, FIXED_MS);
        expect(mind).toEqual(snapshot);
      }),
    );
  });
});

// ------------------------------------------------------------------
// (b) 叙事层不生成新 knowledge / 新 belief
// Validates: Requirements 7.3, 7.5
// ------------------------------------------------------------------

describe("(b) 不生成新内容：source 数 ≤ 输入归集数，content 均来自 mind 已有内容", () => {
  it("随机 mind：输出 source 数 ≤ 输入归集来源数", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        const { candidateCount } = deriveAllowed(mind);
        expect(index.sources.length).toBeLessThanOrEqual(candidateCount);
      }),
    );
  });

  it("随机 mind：每条 source.content 都能在原 mind 已有内容中找到对应来源", () => {
    fc.assert(
      fc.property(mindArb, (mind) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        const { allowedContents } = deriveAllowed(mind);
        for (const source of index.sources) {
          // 零新增语义：content 必须是 mind 已有内容（无叙事层捏造）。
          expect(allowedContents.has(source.content)).toBe(true);
        }
      }),
    );
  });

  it("被推翻 belief / 被取代 userModel 不进入 source（不复活旧内容）", () => {
    const mind: MindReadLike = {
      knowledge: [{ content: "活跃知识 alpha", source: "web-verified" }],
      beliefs: [
        { id: "b0", content: "活跃判断 beta", confidence: 0.7, source: "inferred" },
        {
          id: "b1",
          content: "已被推翻的判断 gamma",
          confidence: 0.5,
          source: "inferred",
          correctedBy: "b0",
        },
      ],
      userModel: [
        { id: "u0", aspect: "a", content: "活跃洞察 delta", confidence: 0.8 },
        {
          id: "u1",
          aspect: "a",
          content: "已被取代洞察 epsilon",
          confidence: 0.6,
          supersededBy: "u0",
        },
      ],
    } as MindReadLike;
    const index = buildSourceIndex(mind, FIXED_MS);
    const contents = index.sources.map((s) => s.content);
    expect(contents).toContain("活跃知识 alpha");
    expect(contents).toContain("活跃判断 beta");
    expect(contents).toContain("活跃洞察 delta");
    // 被推翻 / 被取代的内容绝不出现。
    expect(contents).not.toContain("已被推翻的判断 gamma");
    expect(contents).not.toContain("已被取代洞察 epsilon");
  });
});

// ------------------------------------------------------------------
// (c) 返回对象字段名与输出文本不含引擎触发字段（no-engine-trigger）
//     覆盖 gateNarrative 与 renderNarrativeOutput 的返回
// Validates: Requirements 7.4
// ------------------------------------------------------------------

describe("(c) no-engine-trigger：返回字段名与输出文本不含引擎触发字段", () => {
  it("gateNarrative：随机输入下返回对象字段名（递归）与 text 均不含引擎字段", () => {
    fc.assert(
      fc.property(textArb, mindArb, cfgArb, (text, mind, cfg) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        const result = gateNarrative(text, index, cfg);

        for (const token of FORBIDDEN_ENGINE_TOKENS) {
          expect(result.text.includes(token)).toBe(false);
        }
        const fieldNames = new Set<string>();
        collectFieldNames(result, fieldNames);
        for (const token of FORBIDDEN_ENGINE_TOKENS) {
          expect(fieldNames.has(token)).toBe(false);
        }
      }),
    );
  });

  it("renderNarrativeOutput：随机输入下返回文本不含引擎字段", () => {
    const faith: FaithfulnessReport = {
      score: 1,
      assertionCount: 0,
      unsupported: [],
      matchedSourceIds: [],
    };
    const persona: PersonaReport = { consistent: true, violations: [] };
    fc.assert(
      fc.property(textArb, mindArb, cfgArb, (text, mind, cfg) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        // 用 index 中真实命中 id 填充 faith，以触发 footnote / inline-tier 分支。
        const matched = index.sources.slice(0, 3).map((s) => s.id);
        const rendered = renderNarrativeOutput(
          text,
          index,
          { ...faith, matchedSourceIds: matched },
          persona,
          cfg,
        );
        for (const token of FORBIDDEN_ENGINE_TOKENS) {
          expect(rendered.includes(token)).toBe(false);
        }
      }),
    );
  });
});

// ------------------------------------------------------------------
// (d) dry-run + annotateMode="off" 下 gateNarrative 输出逐字节恒等（零回归）
// Validates: Requirements 8.4
// ------------------------------------------------------------------

describe("(d) dry-run(off) 零回归：gateNarrative 输出与输入逐字节相等", () => {
  it("样本文本：dry-run + annotateMode=off ⟹ result.text === 输入（逐字节）", () => {
    const index: NarrativeSourceIndex = buildSourceIndex(
      {
        knowledge: [
          { content: "用户在做 iOS 上架，卡在 TestFlight 审核这步", source: "web-verified" },
          { content: "服务器部署在东京区域", source: "inferred" },
        ],
        beliefs: [],
        userModel: [],
      } as MindReadLike,
      FIXED_MS,
    );
    const cfg: NarrativeVoiceConfig = {
      mode: "dry-run",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };
    for (const text of SAMPLE_TEXTS) {
      const result = gateNarrative(text, index, cfg);
      expect(result.verdict).toBe("pass");
      expect(result.text).toBe(text);
    }
  });

  it("随机文本 + 随机 mind：dry-run + off ⟹ 逐字节恒等", () => {
    fc.assert(
      fc.property(textArb, mindArb, cfgArb, (text, mind, cfg) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        const dryOffCfg: NarrativeVoiceConfig = {
          ...cfg,
          mode: "dry-run",
          annotateMode: "off",
        };
        const result = gateNarrative(text, index, dryOffCfg);
        expect(result.verdict).toBe("pass");
        expect(result.text).toBe(String(text ?? ""));
      }),
    );
  });
});

// ------------------------------------------------------------------
// (e) renderNarrativeOutput 在 annotateMode="off" 下逐字节恒等
// Validates: Requirements 7.6, 8.4
// ------------------------------------------------------------------

describe("(e) renderNarrativeOutput(off) 逐字节恒等", () => {
  const faith: FaithfulnessReport = {
    score: 1,
    assertionCount: 0,
    unsupported: [],
    matchedSourceIds: [],
  };
  const persona: PersonaReport = { consistent: true, violations: [] };

  it("样本文本：annotateMode=off ⟹ 渲染输出 === 输入（逐字节）", () => {
    const index = buildSourceIndex(
      {
        knowledge: [{ content: "用户在做 iOS 上架", source: "inferred" }],
        beliefs: [],
        userModel: [],
      } as MindReadLike,
      FIXED_MS,
    );
    const cfg: NarrativeVoiceConfig = {
      mode: "dry-run",
      passThreshold: 0.6,
      supportThreshold: 0.34,
      lateBoost: 0.5,
      annotateMode: "off",
      extraForbiddenPatterns: [],
    };
    for (const text of SAMPLE_TEXTS) {
      const matched = index.sources.map((s) => s.id);
      const rendered = renderNarrativeOutput(
        text,
        index,
        { ...faith, matchedSourceIds: matched },
        persona,
        cfg,
      );
      expect(rendered).toBe(text);
    }
  });

  it("随机文本 + 随机 mind：annotateMode=off ⟹ 逐字节恒等（即使有命中来源）", () => {
    fc.assert(
      fc.property(textArb, mindArb, cfgArb, (text, mind, cfg) => {
        const index = buildSourceIndex(mind, FIXED_MS);
        const offCfg: NarrativeVoiceConfig = { ...cfg, annotateMode: "off" };
        const matched = index.sources.map((s) => s.id);
        const rendered = renderNarrativeOutput(
          text,
          index,
          { ...faith, matchedSourceIds: matched },
          persona,
          offCfg,
        );
        expect(rendered).toBe(String(text ?? ""));
      }),
    );
  });
});
