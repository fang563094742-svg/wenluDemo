/**
 * 认知核三段脊柱 · 输出核测试（output-kernel.ts）
 * ------------------------------------------------------------------
 * 任务 5.2（属性测试 · Property 8/9/10/11/3 + 类型可解析）：
 *  - Property 8: 碎片预告归零 — ∀ signal.kind="progress"，
 *    shouldEmit(signal,*).emit === false。
 *  - Property 9: 真节点必开口 — ∀ signal.kind ∈ {done,blocked,needs_user}，
 *    shouldEmit(signal,*).emit === true。
 *  - Property 10: 超长治理 — ∀ Output（audience="user"），condense 产出的
 *    text.length ≤ ctx.outputCharBudget。
 *  - Property 11: 方向分有界 — ∀ Output，directionAlignmentScore ∈ [0,1]
 *    （含负 / 超 100 / NaN / Infinity 边界 gap）。
 *  - Property 3: dry-run 零外溢 — ∀ ctx mode="dry-run"，condense 产出
 *    Output.status === "suppressed"。
 *  - 补充: inferOutputType 返回的 type 恒能被
 *    createDefaultOutputTypeRegistry().resolve 解析。
 *  **Validates: Requirements 3.1, 3.2, 3.3, 5.1**
 *
 * 任务 5.3（单元测试）：
 *  - inferOutputType 关键词推断真值（汇报→content、代码→product、对齐→
 *    relationship_action、拍板/needs_user→decision、其余→asset）。
 *  - condense 缺 summary 时空摘要兜底不报错。
 *  - condense 的 LLM 增强：非空字符串则采用、抛错则退回 deterministicCondense。
 *  - Output 状态机：dry-run→suppressed；enforce→drafted。
 *  _Requirements: 3.5, 9.3, 11.2, 11.3, 12.3_
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ../output-kernel.js、
 * ../cognitive-registry.js、../types.js。不 import 任何 3.1/3.2 路径、不
 * node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  shouldEmit,
  condense,
  inferOutputType,
  deterministicCondense,
} from "../output-kernel.js";
import { createDefaultOutputTypeRegistry } from "../cognitive-registry.js";
import type {
  Intent,
  LlmLike,
  NodeSignal,
  OutputContext,
  PrefrontalReadLike,
} from "../types.js";

// ─── 工具：最小 Intent 构造 ───────────────────────────────────

/** 造一个最小 Intent（占位字段填稳定值；goal/expectedResult 是推断重点）。 */
function makeIntent(goal: string, expectedResult: string): Intent {
  return {
    id: "intent_test_0",
    sourceUtterance: null,
    goal,
    subgoals: [],
    expectedResult,
    acceptanceLine: "验收线",
    status: "planned",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "enforce",
  };
}

// ─── 生成器 ───────────────────────────────────────────────────

/** 真节点种类（done/blocked/needs_user）。 */
function arbRealKind(): fc.Arbitrary<NodeSignal["kind"]> {
  return fc.constantFrom("done", "blocked", "needs_user");
}

/** 全部节点种类（含 progress）。 */
function arbAnyKind(): fc.Arbitrary<NodeSignal["kind"]> {
  return fc.constantFrom("done", "blocked", "needs_user", "progress");
}

/** 随机 NodeSignal（kind 可指定，summary 任意字符串）。 */
function arbSignal(
  kind: fc.Arbitrary<NodeSignal["kind"]>,
): fc.Arbitrary<NodeSignal> {
  return fc.record({
    kind,
    summary: fc.string({ maxLength: 300 }),
  });
}

/** 随机 PrefrontalReadLike 时机信号（不应影响 kind 真值裁决）。 */
function arbTiming(): fc.Arbitrary<PrefrontalReadLike> {
  return fc.record({
    action: fc.string({ maxLength: 30 }),
    priority: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
    context: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
  });
}

/**
 * 随机 gap：含正常值、负值、超 100、NaN、±Infinity 边界，覆盖 Property 11
 * 的兜底路径。
 */
function arbGap(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: -50, max: 200 }),
    fc.double({ min: -1000, max: 1000, noNaN: true }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  );
}

/** 随机 OutputContext（northStarGap 可缺省，mode 任意，budget ≥ 0）。 */
function arbCtx(): fc.Arbitrary<OutputContext> {
  return fc.record({
    northStarGap: fc.option(
      fc.record({ gap: arbGap() }),
      { nil: undefined },
    ),
    mode: fc.constantFrom("dry-run", "enforce"),
    // 预算是非负字符上界（含 0 边界）。
    outputCharBudget: fc.integer({ min: 0, max: 500 }),
  });
}

// ─── 任务 5.2 · Property 8 碎片预告归零 (Req 3.1) ─────────────

describe("shouldEmit · Property 8 碎片预告归零 (Req 3.1)", () => {
  it("∀ signal.kind='progress'，shouldEmit(signal,*).emit === false", () => {
    fc.assert(
      fc.property(
        arbSignal(fc.constant("progress")),
        arbTiming(),
        (signal, timing) => {
          const decision = shouldEmit(signal, timing);
          expect(decision.emit).toBe(false);
          expect(decision.reason).toBe("silent");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.2 · Property 9 真节点必开口 (Req 3.2) ─────────────

describe("shouldEmit · Property 9 真节点必开口 (Req 3.2)", () => {
  it("∀ signal.kind∈{done,blocked,needs_user}，shouldEmit(signal,*).emit === true", () => {
    fc.assert(
      fc.property(arbSignal(arbRealKind()), arbTiming(), (signal, timing) => {
        const decision = shouldEmit(signal, timing);
        expect(decision.emit).toBe(true);
        expect(decision.reason).toBe(signal.kind);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.2 · Property 10 超长治理 (Req 3.3) ────────────────

describe("condense · Property 10 超长治理 (Req 3.3)", () => {
  it("∀ Output(audience='user')，text.length ≤ ctx.outputCharBudget", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 随机长 goal / summary（BMP 字符，码点数即 .length）。
        fc.string({ maxLength: 800 }),
        fc.string({ maxLength: 800 }),
        arbSignal(arbAnyKind()),
        arbCtx(),
        async (goal, expectedResult, signal, ctx) => {
          const intent = makeIntent(goal, expectedResult);
          const out = await condense(intent, signal, ctx);
          expect(out.audience).toBe("user");
          expect(out.text.length).toBeLessThanOrEqual(ctx.outputCharBudget);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.2 · Property 11 方向分有界 (Req 3.1) ──────────────

describe("condense · Property 11 方向分有界 (Req 3.1)", () => {
  it("∀ Output，directionAlignmentScore ∈ [0,1]（含 NaN/Inf/负/超100 边界）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 100 }),
        arbSignal(arbAnyKind()),
        arbCtx(),
        async (goal, signal, ctx) => {
          const intent = makeIntent(goal, "预期结果");
          const out = await condense(intent, signal, ctx);
          expect(Number.isFinite(out.directionAlignmentScore)).toBe(true);
          expect(out.directionAlignmentScore).toBeGreaterThanOrEqual(0);
          expect(out.directionAlignmentScore).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.2 · Property 3 dry-run 零外溢 (Req 5.1) ───────────

describe("condense · Property 3 dry-run 零外溢 (Req 5.1)", () => {
  it("∀ ctx mode='dry-run'，condense 产出 Output.status === 'suppressed'", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 100 }),
        arbSignal(arbAnyKind()),
        arbCtx(),
        async (goal, signal, ctxBase) => {
          const ctx: OutputContext = { ...ctxBase, mode: "dry-run" };
          const out = await condense(makeIntent(goal, "预期结果"), signal, ctx);
          expect(out.status).toBe("suppressed");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.2 · 补充：inferOutputType 类型恒可解析 ────────────

describe("inferOutputType · 推断类型恒可被默认 registry 解析 (Req 3.2)", () => {
  it("∀ intent/signal，registry.resolve(inferOutputType(...)) !== undefined", () => {
    const registry = createDefaultOutputTypeRegistry();
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        arbSignal(arbAnyKind()),
        (goal, expectedResult, signal) => {
          const intent = makeIntent(goal, expectedResult);
          const type = inferOutputType(intent, signal);
          expect(registry.resolve(type)).not.toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 5.3 · inferOutputType 关键词推断真值 (Req 3.5/11.2) ──

describe("inferOutputType · 关键词推断真值 (Req 3.5, 11.2)", () => {
  const progress: NodeSignal = { kind: "progress", summary: "" };

  it("含『汇报』⟹ content", () => {
    expect(inferOutputType(makeIntent("给老板汇报进展", ""), progress)).toBe(
      "content",
    );
  });

  it("含『代码』⟹ product", () => {
    expect(inferOutputType(makeIntent("写一段代码", ""), progress)).toBe(
      "product",
    );
  });

  it("含『对齐』⟹ relationship_action", () => {
    expect(
      inferOutputType(makeIntent("和团队对齐目标", ""), progress),
    ).toBe("relationship_action");
  });

  it("含『拍板』⟹ decision", () => {
    expect(inferOutputType(makeIntent("需要你拍板方案", ""), progress)).toBe(
      "decision",
    );
  });

  it("signal.kind='needs_user' ⟹ decision（无关键词时）", () => {
    const needsUser: NodeSignal = { kind: "needs_user", summary: "" };
    expect(inferOutputType(makeIntent("随便做点事", ""), needsUser)).toBe(
      "decision",
    );
  });

  it("无任何关键词且非 needs_user ⟹ asset 兜底", () => {
    expect(inferOutputType(makeIntent("随便做点事", ""), progress)).toBe(
      "asset",
    );
  });

  it("优先级：同时含『内容』与『代码』时 content 优先于 product", () => {
    expect(
      inferOutputType(makeIntent("写内容也写代码", ""), progress),
    ).toBe("content");
  });

  it("signal.summary 也纳入推断语料（summary 含『网站』⟹ product）", () => {
    const signal: NodeSignal = { kind: "done", summary: "做好了网站" };
    expect(inferOutputType(makeIntent("随便", ""), signal)).toBe("product");
  });
});

// ─── 任务 5.3 · condense 缺 summary 兜底不报错 (Req 12.3) ──────

describe("condense · 缺 summary 兜底不报错 (Req 12.3)", () => {
  const ctx: OutputContext = { mode: "enforce", outputCharBudget: 200 };

  it("summary 为 undefined 时不抛错且产出非空兜底文本", async () => {
    // 故意构造缺 summary 的 signal（运行时缺字段，类型断言绕过）。
    const signal = { kind: "done" } as unknown as NodeSignal;
    const out = await condense(makeIntent("交付目标", "结果"), signal, ctx);
    expect(typeof out.text).toBe("string");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).toContain("已完成");
  });

  it("deterministicCondense 在缺 summary 时只产出前缀+目标段（无尾段）", () => {
    const signal = { kind: "done" } as unknown as NodeSignal;
    const text = deterministicCondense(makeIntent("交付目标", "结果"), signal);
    expect(text).toBe("已完成：交付目标");
  });
});

// ─── 任务 5.3 · condense 的 LLM 增强 (Req 9.3, 12.3) ──────────

describe("condense · LLM 增强与 fail-open 兜底 (Req 9.3, 12.3)", () => {
  const ctx: OutputContext = { mode: "enforce", outputCharBudget: 200 };
  const signal: NodeSignal = { kind: "done", summary: "做完了" };

  it("LLM 返回非空字符串则采用其增强文本", async () => {
    const llm: LlmLike = {
      refinePlan: async (base) => base,
      condenseOutput: async () => "这是 LLM 凝练后的人话",
    };
    const out = await condense(makeIntent("交付目标", "结果"), signal, ctx, llm);
    expect(out.text).toBe("这是 LLM 凝练后的人话");
  });

  it("LLM 抛错则退回 deterministicCondense（不冒泡、不阻断）", async () => {
    const llm: LlmLike = {
      refinePlan: async (base) => base,
      condenseOutput: async () => {
        throw new Error("LLM 崩了");
      },
    };
    const intent = makeIntent("交付目标", "结果");
    const out = await condense(intent, signal, ctx, llm);
    expect(out.text).toBe(deterministicCondense(intent, signal));
  });

  it("LLM 返回空字符串则退回 deterministicCondense", async () => {
    const llm: LlmLike = {
      refinePlan: async (base) => base,
      condenseOutput: async () => "",
    };
    const intent = makeIntent("交付目标", "结果");
    const out = await condense(intent, signal, ctx, llm);
    expect(out.text).toBe(deterministicCondense(intent, signal));
  });
});

// ─── 任务 5.3 · Output 状态机 (Req 11.2, 11.3) ────────────────

describe("condense · Output 状态机 dry-run→suppressed / enforce→drafted (Req 11.2, 11.3)", () => {
  const signal: NodeSignal = { kind: "done", summary: "做完了" };

  it("dry-run 模式 ⟹ status='suppressed'", async () => {
    const ctx: OutputContext = { mode: "dry-run", outputCharBudget: 200 };
    const out = await condense(makeIntent("目标", "结果"), signal, ctx);
    expect(out.status).toBe("suppressed");
  });

  it("enforce 模式 ⟹ status='drafted'", async () => {
    const ctx: OutputContext = { mode: "enforce", outputCharBudget: 200 };
    const out = await condense(makeIntent("目标", "结果"), signal, ctx);
    expect(out.status).toBe("drafted");
  });

  it("condense 产出固定字段 audience='user'、nodeKind 跟随真节点 kind", async () => {
    const ctx: OutputContext = { mode: "enforce", outputCharBudget: 200 };
    const blocked: NodeSignal = { kind: "blocked", summary: "卡住" };
    const out = await condense(makeIntent("目标", "结果"), blocked, ctx);
    expect(out.audience).toBe("user");
    expect(out.nodeKind).toBe("blocked");
  });
});
