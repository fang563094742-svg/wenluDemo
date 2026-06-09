// Feature: proactive-awareness-demo, Property 8: 单轮提问数量受上限约束而阶段数不受限 —— *For any* ClarifierState，`next` 一轮产出的 questions 数量 ≤ `perRoundQuestionLimit`；同时对任意（含很大）数量的逻辑阶段，`begin` 产出的 phases 数量等于 LLM 给出的阶段数，不被截断。
//
// **Validates: Requirements 8.4, 8.5**
//
// 被测编排单元：`LlmClarifier.begin` / `LlmClarifier.next`（任务 7.9，R8 核心）。
// 用可控 mock `LLM_Provider`（按请求的 jsonSchema 区分 begin / next 两类调用），
// 让 LLM **故意返回大量阶段 / 大量前提与候选问题**，从而对偶地验证两个相反方向：
//   A. begin（R8.5）：阶段数**不设硬上限、不被截断** —— 产出 phases 数量恒等于 LLM 给出数，
//      即使该数量远超单轮提问上限（3）与顶层收敛阈值（6）。
//   B. next（R8.4）：单轮**提问数量受上限约束** —— 无论 LLM 抛出多少前提/问题，
//      本轮 `questions` 数量恒 ≤ 状态中的 `perRoundQuestionLimit`。
// 期望值由各场景的构造语义直接给出（A：等于注入的阶段数；B：≤ 注入的上限），不复用被测逻辑做 oracle。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { LlmClarifier } from "../../src/clarifier/clarifier.js";
import type { Awareness_Item } from "../../src/analyzer/analyzer.js";
import { createInitialSession } from "../../src/orchestrator/session.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";

// ---------------------------------------------------------------------------
// 可控 mock LLM_Provider
//
// LlmClarifier 对每一段都带不同的输出 JSON schema（见 clarifier.ts）：
//   - begin（任务分解）       required 含 "phases"
//   - next（前提评估 + 提问） required 含 "preconditions"
//   - sufficient（Task_Frame）required 含 "objective"
// 据此把受控载荷分派到对应阶段；本属性只触达 begin / next 两段。
// ---------------------------------------------------------------------------
class MockClarifierProvider implements LLM_Provider {
  readonly providerKey = "mock";

  constructor(
    private readonly beginPayload: unknown,
    private readonly nextPayload: unknown,
  ) {}

  complete(req: LlmRequest): Promise<LlmResponse> {
    const required =
      (req.jsonSchema as { required?: string[] } | undefined)?.required ?? [];
    if (required.includes("phases")) {
      return Promise.resolve({ text: JSON.stringify(this.beginPayload) });
    }
    if (required.includes("preconditions")) {
      return Promise.resolve({ text: JSON.stringify(this.nextPayload) });
    }
    // sufficient 段：本属性的场景恒落在「继续提问」分支，不应被触达。
    throw new Error("Property 8 测试不应触达 sufficient 段（应始终停留在提问分支）。");
  }

  completeWithTools(): Promise<LlmToolResponse> {
    throw new Error("Property 8 测试不应触达 completeWithTools。");
  }
}

/** Clarifier 仅从 Awareness_Item 取 title/rationale/evidence 构造 prompt，mock 忽略其内容。 */
const ITEM: Awareness_Item = {
  id: "aw-1",
  title: "整理项目结构",
  rationale: "依据扫描摘要推断的最近最需要做的事。",
  evidence: ["扫描条目-1"],
};

/** 构造 LLM 的 begin 输出载荷：n 个标题非空、order 递增的逻辑阶段。 */
function makeBeginPayload(n: number): object {
  return {
    phases: Array.from({ length: n }, (_, i) => ({
      title: `阶段${i + 1}`,
      order: i + 1,
    })),
    convergenceSuggested: false,
  };
}

/**
 * 构造 LLM 的 next 输出载荷：m 个**低风险、模糊、未消解**的执行前提。
 * - related_action 刻意取良性描述（不触发风险注入的强制高危规则），
 *   使 evaluateReadiness 稳定走「仅剩低风险模糊前提 → ask(attachDefaults)」分支；
 * - 同时给出 m 个候选问题（数量同样可能远超上限），用以检验 next 的提问截断。
 */
function makeNextPayload(m: number): object {
  return {
    preconditions: Array.from({ length: m }, (_, i) => ({
      description: `前提${i + 1}`,
      status: "ambiguous",
      risk_level: "low",
      related_action: `查看配置项 ${i + 1}`,
    })),
    phaseSaturated: false,
    deferRemaining: false,
    questions: Array.from({ length: m }, (_, i) => ({
      text: `关于前提${i + 1}能否进一步明确？`,
      targetPreconditionIndexes: [i + 1],
    })),
  };
}

describe("Property 8: 单轮提问数量受上限约束而阶段数不受限", () => {
  // -------------------------------------------------------------------------
  // A. begin —— 阶段数不被截断（R8.5）
  // -------------------------------------------------------------------------
  it("begin 产出的 phases 数量恒等于 LLM 给出的阶段数（含远超上限/阈值的很大数量）", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 覆盖 1..50：既含 ≤ 单轮上限(3)/收敛阈值(6) 的小数量，也含远超它们的大数量。
        fc.integer({ min: 1, max: 50 }),
        // 单轮提问上限独立变化，证明它绝不影响阶段数。
        fc.integer({ min: 1, max: 6 }),
        async (phaseCount, perRoundQuestionLimit) => {
          const provider = new MockClarifierProvider(
            makeBeginPayload(phaseCount),
            makeNextPayload(1),
          );
          const clarifier = new LlmClarifier(provider, { perRoundQuestionLimit });

          const state = await clarifier.begin(ITEM, createInitialSession());

          // 阶段数 = LLM 给出数，绝不被截断（即使远超 perRoundQuestionLimit / 收敛阈值）。
          expect(state.phases.length).toBe(phaseCount);
          // 恰有一个被聚焦，其余为待处理（不丢弃任何阶段）。
          const focused = state.phases.filter((p) => p.status === "focused");
          expect(focused.length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // B. next —— 单轮提问数量受上限约束（R8.4）
  // -------------------------------------------------------------------------
  it("next 一轮产出的 questions 数量恒 ≤ perRoundQuestionLimit（无论 LLM 抛出多少前提/问题）", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 任务被分解出的阶段数（含远超阈值的大数量，附带验证此时仍受同一上限约束）。
        fc.integer({ min: 1, max: 20 }),
        // LLM 单轮抛出的前提/候选问题数量（常远超上限，用以触发截断）。
        fc.integer({ min: 1, max: 15 }),
        // 单轮提问上限（注入到 ClarifierState.perRoundQuestionLimit）。
        fc.integer({ min: 1, max: 6 }),
        async (phaseCount, llmQuestionCount, perRoundQuestionLimit) => {
          const provider = new MockClarifierProvider(
            makeBeginPayload(phaseCount),
            makeNextPayload(llmQuestionCount),
          );
          const clarifier = new LlmClarifier(provider, { perRoundQuestionLimit });

          const state = await clarifier.begin(ITEM, createInitialSession());
          // begin 应把上限如实落入状态。
          expect(state.perRoundQuestionLimit).toBe(perRoundQuestionLimit);

          const step = await clarifier.next(state);

          // 焦点阶段含未消解低风险模糊前提 → 必走「提问」分支（非充分/僵局）。
          expect(step.kind).toBe("questions");
          if (step.kind === "questions") {
            // 核心不变量：单轮提问数量受上限约束（R8.4），与 LLM 抛出的数量无关。
            expect(step.questions.length).toBeLessThanOrEqual(
              state.perRoundQuestionLimit,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
