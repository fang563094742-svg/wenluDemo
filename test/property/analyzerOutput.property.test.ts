// Feature: proactive-awareness-demo, Property 4: *For any* LLM 返回的候选察觉项集合（数量可能超过 3），Analyzer 校验后的输出长度 ≤ 3，且每一条 Awareness_Item 的 evidence 数组非空。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { LlmAnalyzer, MAX_AWARENESS_ITEMS } from "../../src/analyzer/analyzer.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type { Scan_Summary } from "../../src/scanner/types.js";

/**
 * Property 4: Analyzer 输出至多 3 条且每条带 evidence
 *
 * Validates: Requirements 5.2, 5.3
 *
 * 不变量（与候选集合的数量/形态无关，恒成立）：
 *  - 规整后的输出长度 ≤ `MAX_AWARENESS_ITEMS`（= 3，R5.2）；
 *  - 每一条 Awareness_Item 的 evidence 为非空数组，且每个引用 trim 后非空（R5.3）。
 */

// ---------------------------------------------------------------------------
// Mock LLM_Provider：complete 返回受控 JSON（由 fast-check 生成的候选载荷）。
// Analyzer 只调用 complete；completeWithTools 在本属性中不会被触达。
// ---------------------------------------------------------------------------
class MockLlmProvider implements LLM_Provider {
  readonly providerKey = "mock";

  /** @param payload 将被 JSON.stringify 后作为 LLM 文本返回（受控输出）。 */
  constructor(private readonly payload: unknown) {}

  complete(_req: LlmRequest): Promise<LlmResponse> {
    return Promise.resolve({ text: JSON.stringify(this.payload) });
  }

  completeWithTools(): Promise<LlmToolResponse> {
    throw new Error("Analyzer 属性测试不应触达 completeWithTools");
  }
}

/** 确定性 id 生成器（避免依赖 randomUUID，便于断言可复现）。 */
function makeIdFactory(): () => string {
  let n = 0;
  return () => `item-${n++}`;
}

/** Analyzer 仅用 summary 构造 prompt，mock 忽略其内容，故用最小合法摘要即可。 */
const SUMMARY: Scan_Summary = {
  scannedAt: new Date(0).toISOString(),
  platform: "darwin",
  recentDays: 7,
  items: [],
};

// ---------------------------------------------------------------------------
// 生成器：覆盖各种条目数 / title-rationale 缺失 / evidence 组合。
// ---------------------------------------------------------------------------

/** 字符串字段：可能缺失(undefined)、空串、纯空白、任意串、或明确非空串。 */
const maybeStringArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("   "),
  fc.string(),
  fc.string({ minLength: 1 }).map((s) => `X${s}`),
);

/** 单条 evidence 引用：可能为空串/纯空白/任意串/明确非空串/非字符串(异常类型)。 */
const evidenceEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(""),
  fc.constant("  "),
  fc.string(),
  fc.string({ minLength: 1 }).map((s) => `证据:${s}`),
  fc.integer(), // 非字符串项，应被规整逻辑剔除
);

/** evidence 字段：可能缺失/非数组/空数组/含各种引用的数组。 */
const evidenceArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant([]),
  fc.constant("not-an-array"),
  fc.array(evidenceEntryArb, { maxLength: 5 }),
);

/** 单个候选察觉项（字段可缺失、类型可异常）。 */
const candidateArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    title: maybeStringArb,
    rationale: maybeStringArb,
    evidence: evidenceArb,
  },
  { requiredKeys: [] },
);

/** 候选集合：0~8 条，数量可能超过上限 3。 */
const itemsArb: fc.Arbitrary<Record<string, unknown>[]> = fc.array(candidateArb, {
  maxLength: 8,
});

describe("Property 4: Analyzer 输出至多 3 条且每条带 evidence", () => {
  it("对任意候选集合，analyze() 输出 ≤ 3 条且每条 evidence 非空", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const analyzer = new LlmAnalyzer(
          new MockLlmProvider({ items }),
          makeIdFactory(),
        );

        const result = await analyzer.analyze(SUMMARY);

        // R5.2：至多 3 条。
        expect(result.length).toBeLessThanOrEqual(MAX_AWARENESS_ITEMS);

        // R5.3：每条 evidence 为非空数组，且每个引用 trim 后非空。
        for (const item of result) {
          expect(Array.isArray(item.evidence)).toBe(true);
          expect(item.evidence.length).toBeGreaterThan(0);
          for (const e of item.evidence) {
            expect(typeof e).toBe("string");
            expect(e.trim().length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("候选条数超过 3 时截断为至多 3 条（示例）", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      title: `任务 ${i}`,
      rationale: `推断 ${i}`,
      evidence: [`证据 ${i}`],
    }));
    const analyzer = new LlmAnalyzer(new MockLlmProvider({ items }), makeIdFactory());

    const result = await analyzer.analyze(SUMMARY);

    expect(result.length).toBe(MAX_AWARENESS_ITEMS);
    expect(result.every((it) => it.evidence.length > 0)).toBe(true);
  });

  it("evidence 为空 / 全空白的候选被剔除（示例）", async () => {
    const items = [
      { title: "保留", rationale: "有据", evidence: ["真凭实据"] },
      { title: "丢弃-空数组", rationale: "无据", evidence: [] },
      { title: "丢弃-全空白", rationale: "无据", evidence: ["", "   "] },
    ];
    const analyzer = new LlmAnalyzer(new MockLlmProvider({ items }), makeIdFactory());

    const result = await analyzer.analyze(SUMMARY);

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("保留");
    expect(result[0]?.evidence).toEqual(["真凭实据"]);
  });
});
