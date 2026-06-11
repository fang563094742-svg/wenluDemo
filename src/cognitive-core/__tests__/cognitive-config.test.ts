/**
 * 认知核三段脊柱 · 配置层测试（cognitive-config.ts）
 * ------------------------------------------------------------------
 * 覆盖：
 *  - 任务 1.2 / Property 12：配置向后兼容
 *    ∀ mind 无 cognitiveCore 字段 ⟹ resolveCognitiveConfig(mind) 深度等于
 *    DEFAULT_COGNITIVE_CORE，且不修改入参 mind（前后深快照相等）。
 *    **Validates: Requirements 5.1**
 *  - 补充：返回深拷贝（修改返回值不污染 DEFAULT 常量，含 enabledStages 对象）；
 *    含 cognitiveCore 时返回该配置。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./cognitive-config.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_COGNITIVE_CORE,
  resolveCognitiveConfig,
  type CognitiveCoreConfig,
  type MindConfigReadLike,
} from "../cognitive-config.js";

/**
 * 生成一个合法 MindConfigReadLike，但**不含** cognitiveCore 字段。
 * 随机填充任意无关字段，确保回退与无关字段无关（结构子类型友好）。
 */
function arbMindWithoutCognitiveCore(): fc.Arbitrary<MindConfigReadLike> {
  return fc
    .dictionary(
      fc.string().filter((k) => k !== "cognitiveCore"),
      fc.anything(),
      { maxKeys: 6 },
    )
    .map((extra) => {
      // 二次保险：剔除任何意外生成的 cognitiveCore 键
      const { cognitiveCore: _drop, ...rest } = extra as Record<
        string,
        unknown
      >;
      return rest as MindConfigReadLike;
    });
}

/** 生成任意合法 CognitiveCoreConfig。 */
function arbCognitiveCoreConfig(): fc.Arbitrary<CognitiveCoreConfig> {
  return fc.record({
    mode: fc.constantFrom("dry-run" as const, "enforce" as const),
    maxParallel: fc.integer({ min: 1, max: 64 }),
    outputCharBudget: fc.integer({ min: 0, max: 4000 }),
    enabledStages: fc.record({
      plan: fc.boolean(),
      dispatch: fc.boolean(),
      output: fc.boolean(),
    }),
  });
}

describe("cognitive-config · Property 12 配置向后兼容 (Req 5.1)", () => {
  it("不含 cognitiveCore 的 mind ⟹ resolveCognitiveConfig 深度等于 DEFAULT_COGNITIVE_CORE", () => {
    fc.assert(
      fc.property(arbMindWithoutCognitiveCore(), (mind) => {
        const resolved = resolveCognitiveConfig(mind);
        expect(resolved).toEqual(DEFAULT_COGNITIVE_CORE);
      }),
      { numRuns: 300 },
    );
  });

  it("resolveCognitiveConfig 不修改入参 mind：前后深快照相等", () => {
    fc.assert(
      fc.property(arbMindWithoutCognitiveCore(), (mind) => {
        const before = structuredClone(mind);
        resolveCognitiveConfig(mind);
        expect(mind).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });
});

describe("cognitive-config · 返回深拷贝且不污染常量", () => {
  it("修改回退返回值不应污染 DEFAULT 常量（含 enabledStages 对象）", () => {
    const mind: MindConfigReadLike = {};
    const resolved = resolveCognitiveConfig(mind);

    resolved.mode = "enforce";
    resolved.maxParallel = 999;
    resolved.outputCharBudget = 1;
    resolved.enabledStages.plan = true;
    resolved.enabledStages.dispatch = true;
    resolved.enabledStages.output = true;

    // 常量默认逐字段未被污染
    expect(DEFAULT_COGNITIVE_CORE.mode).toBe("dry-run");
    expect(DEFAULT_COGNITIVE_CORE.maxParallel).toBe(4);
    expect(DEFAULT_COGNITIVE_CORE.outputCharBudget).toBe(200);
    expect(DEFAULT_COGNITIVE_CORE.enabledStages).toEqual({
      plan: false,
      dispatch: false,
      output: false,
    });
  });

  it("enabledStages 为独立新引用，不与常量共享可变状态", () => {
    const a = resolveCognitiveConfig({});
    const b = resolveCognitiveConfig({});
    expect(a.enabledStages).not.toBe(DEFAULT_COGNITIVE_CORE.enabledStages);
    expect(a.enabledStages).not.toBe(b.enabledStages);
  });
});

describe("cognitive-config · 含 cognitiveCore 时返回该配置 (Req 5.1)", () => {
  it("mind 含 cognitiveCore ⟹ resolve 返回该配置且不修改入参", () => {
    fc.assert(
      fc.property(arbCognitiveCoreConfig(), (cognitiveCore) => {
        const mind: MindConfigReadLike = { cognitiveCore };
        const before = structuredClone(mind);
        const resolved = resolveCognitiveConfig(mind);
        // 含字段时返回该配置（深等）
        expect(resolved).toEqual(cognitiveCore);
        // 不修改入参
        expect(mind).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});
