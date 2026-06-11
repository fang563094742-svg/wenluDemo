/**
 * 叙事输出层 · 配置层测试（narrative-config.ts）
 * ------------------------------------------------------------------
 * 覆盖：
 *  - 任务 1.2 / Property 15：配置回退向后兼容（无 narrativeVoice ⟹ 深等 DEFAULT）。
 *    **Validates: Requirements 6.1**
 *  - 任务 1.3：DEFAULT 值域合法性 + resolve 不修改入参 mind。
 *    _Requirements: 6.3, 6.4, 6.5_
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./narrative-config.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_NARRATIVE_VOICE,
  resolveNarrativeConfig,
  type MindReadLike,
  type NarrativeVoiceConfig,
} from "../narrative-config.js";

/**
 * 生成一个合法 MindReadLike，但**不含** narrativeVoice 字段。
 * 随机填充叙事层会消费/可能携带的其它字段，确保回退与无关字段无关。
 */
function arbMindWithoutNarrativeVoice(): fc.Arbitrary<MindReadLike> {
  const belief = fc.record({
    id: fc.string(),
    content: fc.string(),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    source: fc.string(),
    // correctedBy 可选：随机出现或缺省
    correctedBy: fc.option(fc.string(), { nil: undefined }),
  });
  const knowledge = fc.record({
    content: fc.string(),
    source: fc.string(),
  });
  const userModelItem = fc.record({
    id: fc.string(),
    aspect: fc.string(),
    content: fc.string(),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    supersededBy: fc.option(fc.string(), { nil: undefined }),
  });

  return fc.record({
    beliefs: fc.array(belief, { maxLength: 5 }),
    knowledge: fc.array(knowledge, { maxLength: 5 }),
    userModel: fc.array(userModelItem, { maxLength: 5 }),
    riverbed: fc.option(fc.anything(), { nil: undefined }),
    chronotopic: fc.option(fc.anything(), { nil: undefined }),
    fallbackReplyPolicy: fc.option(
      fc.record({ legacyPatterns: fc.array(fc.string(), { maxLength: 4 }) }),
      { nil: undefined },
    ),
    // 明确不包含 narrativeVoice
  }) as fc.Arbitrary<MindReadLike>;
}

describe("narrative-config · Property 15 配置回退向后兼容 (Req 6.1)", () => {
  it("不含 narrativeVoice 的 mind ⟹ resolveNarrativeConfig 深度等于 DEFAULT_NARRATIVE_VOICE", () => {
    fc.assert(
      fc.property(arbMindWithoutNarrativeVoice(), (mind) => {
        const resolved = resolveNarrativeConfig(mind);
        expect(resolved).toEqual(DEFAULT_NARRATIVE_VOICE);
      }),
      { numRuns: 300 },
    );
  });

  it("回退结果是深拷贝：修改它不应污染 DEFAULT 常量 (Req 6.1)", () => {
    const mind: MindReadLike = { beliefs: [], knowledge: [], userModel: [] };
    const resolved = resolveNarrativeConfig(mind);
    resolved.passThreshold = 0.99;
    resolved.extraForbiddenPatterns.push("__mutation_probe__");
    // 常量默认未被污染
    expect(DEFAULT_NARRATIVE_VOICE.passThreshold).toBe(0.6);
    expect(DEFAULT_NARRATIVE_VOICE.extraForbiddenPatterns).toEqual([]);
  });
});

describe("narrative-config · 任务 1.3 值域与不变性 (Req 6.3/6.4/6.5)", () => {
  it("DEFAULT 阈值落在各自合法值域内 (Req 6.5)", () => {
    const cfg = DEFAULT_NARRATIVE_VOICE;
    // passThreshold / supportThreshold ∈ [0,1]
    expect(cfg.passThreshold).toBeGreaterThanOrEqual(0);
    expect(cfg.passThreshold).toBeLessThanOrEqual(1);
    expect(cfg.supportThreshold).toBeGreaterThanOrEqual(0);
    expect(cfg.supportThreshold).toBeLessThanOrEqual(1);
    // lateBoost ∈ [0,2]
    expect(cfg.lateBoost).toBeGreaterThanOrEqual(0);
    expect(cfg.lateBoost).toBeLessThanOrEqual(2);
    // annotateMode ∈ 合法枚举
    expect(["off", "inline-tier", "footnote"]).toContain(cfg.annotateMode);
    expect(cfg.extraForbiddenPatterns).toEqual([]);
  });

  it("DEFAULT mode 为 dry-run，使缺省接入零行为改变 (Req 6.3)", () => {
    expect(DEFAULT_NARRATIVE_VOICE.mode).toBe("dry-run");
    // 文档要求的具体 annotateMode 缺省值
    expect(DEFAULT_NARRATIVE_VOICE.annotateMode).toBe("off");
  });

  it("resolveNarrativeConfig 不修改入参 mind：前后深快照相等 (Req 6.4)", () => {
    fc.assert(
      fc.property(arbMindWithoutNarrativeVoice(), (mind) => {
        const before = structuredClone(mind);
        resolveNarrativeConfig(mind);
        expect(mind).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("mind 含 narrativeVoice 时 resolve 不修改入参 (Req 6.4/6.2)", () => {
    const arbConfig: fc.Arbitrary<NarrativeVoiceConfig> = fc.record({
      mode: fc.constantFrom("dry-run" as const, "enforce" as const),
      passThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
      supportThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
      lateBoost: fc.float({ min: 0, max: 2, noNaN: true }),
      annotateMode: fc.constantFrom(
        "off" as const,
        "inline-tier" as const,
        "footnote" as const,
      ),
      extraForbiddenPatterns: fc.array(fc.string(), { maxLength: 4 }),
    });

    fc.assert(
      fc.property(arbConfig, (voice) => {
        const mind: MindReadLike = {
          beliefs: [],
          knowledge: [],
          userModel: [],
          narrativeVoice: voice,
        };
        const before = structuredClone(mind);
        const resolved = resolveNarrativeConfig(mind);
        // 含字段时返回该配置
        expect(resolved).toEqual(voice);
        // 不修改入参
        expect(mind).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});
