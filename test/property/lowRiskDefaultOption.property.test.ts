// Feature: proactive-awareness-demo, Property 9: *For any* 当前聚焦阶段不含高风险模糊前提、且仅剩低风险模糊前提的 ClarifierState，`next` 生成的每个针对该前提的问题都附带 `defaultOption`（给出明确的具体默认值）。
//
// **Validates: Requirements 8.3**
//
// 被测编排单元：`LlmClarifier.begin` / `LlmClarifier.next`（任务 7.9，R8 核心）。
// 用可控 mock `LLM_Provider`（按请求的 jsonSchema.required 区分 begin / next 两段，
// 参考 questionLimitPhaseUnbounded.property.test.ts 的写法）。
//
// 构造一个「当前聚焦阶段仅剩低风险模糊前提」的局面：让 next 段的 LLM 评估恒返回
// 一组 **risk_level=low、status=ambiguous、无 proposedDefault、无 resolvedBy** 的执行前提
// （related_action 取良性描述，不触发风险注入的强制高危规则）。此时 `evaluateReadiness`
// 必走「仅剩低/中风险模糊前提 → ask(attachDefaults=true)」分支，从而 `buildQuestions`
// 为每个低风险前提的问题附上 `defaultOption`。
//
// 不变量（与 LLM 给出的问题文本无关，仅由「仅剩低风险模糊前提」决定）：
//   每个**针对某低风险前提**的澄清问题（targetPreconditionIds 非空）都带有 `defaultOption`，
//   且其 `value` 为非空的具体默认值（R8.3 / Property 9）。
// 期望值由场景构造语义直接给出（仅剩低风险模糊前提 ⇒ 必附默认值选项），不复用被测逻辑做 oracle。

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
// 据此把受控载荷分派到对应阶段；本属性只触达 begin / next 两段
//（焦点阶段含未消解低风险模糊前提 ⇒ 恒走「提问」分支，绝不到 sufficient）。
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
    // sufficient 段：本属性场景恒落在「继续提问」分支，不应被触达。
    throw new Error(
      "Property 9 测试不应触达 sufficient 段（应始终停留在低风险提问分支）。",
    );
  }

  completeWithTools(): Promise<LlmToolResponse> {
    throw new Error("Property 9 测试不应触达 completeWithTools。");
  }
}

/** Clarifier 仅从 Awareness_Item 取 title/rationale/evidence 构造 prompt，mock 忽略其内容。 */
const ITEM: Awareness_Item = {
  id: "aw-1",
  title: "整理项目配置",
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
 * 构造 LLM 的 next 输出载荷：m 个**低风险、模糊、未消解、无 proposedDefault** 的执行前提。
 * - related_action 取良性描述（不触发风险注入的强制高危规则），保证风险注入后仍为 low，
 *   使 evaluateReadiness 稳定走「仅剩低风险模糊前提 → ask(attachDefaults=true)」分支；
 * - 同时给出 m 个候选问题，各自指向对应前提（1-based 序号）；
 * - `llmProvidesDefault` 为 true 时，让 LLM 在问题上直接给出具体的 defaultOption.value，
 *   否则省略，迫使编排层走「合成默认值」兜底——两种情况都必须产出非空默认值。
 */
function makeNextPayload(m: number, llmProvidesDefault: boolean): object {
  return {
    preconditions: Array.from({ length: m }, (_, i) => ({
      description: `低风险前提${i + 1}`,
      status: "ambiguous",
      risk_level: "low",
      related_action: `查看配置项 ${i + 1}`,
      // 刻意不给 proposedDefault：保证该前提进入 midLowUnresolved（被提问）。
    })),
    phaseSaturated: false,
    deferRemaining: false,
    questions: Array.from({ length: m }, (_, i) => {
      const q: Record<string, unknown> = {
        text: `关于低风险前提${i + 1}能否进一步明确？`,
        targetPreconditionIndexes: [i + 1],
      };
      if (llmProvidesDefault) {
        q.defaultOption = { label: `默认 ${i + 1}`, value: `默认值-${i + 1}` };
      }
      return q;
    }),
  };
}

describe("Property 9: 低风险模糊前提提问附明确默认值选项", () => {
  it("仅剩低风险模糊前提时，每个针对该前提的问题都附带非空 defaultOption", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 焦点阶段的低风险模糊前提数量（含远超单轮上限者，用以同时覆盖截断后仍带默认值）。
        fc.integer({ min: 1, max: 8 }),
        // 单轮提问上限（注入到 ClarifierState.perRoundQuestionLimit）。
        fc.integer({ min: 1, max: 6 }),
        // 任务被分解出的阶段数（保持较小，避免与收敛建议/阶段推进纠缠）。
        fc.integer({ min: 1, max: 3 }),
        // LLM 是否直接在问题上给出 defaultOption.value（否则走合成兜底）。
        fc.boolean(),
        async (
          preconditionCount,
          perRoundQuestionLimit,
          phaseCount,
          llmProvidesDefault,
        ) => {
          const provider = new MockClarifierProvider(
            makeBeginPayload(phaseCount),
            makeNextPayload(preconditionCount, llmProvidesDefault),
          );
          // 抬高收敛阈值，确保不因「阶段过多」前置收敛建议问题，从而隔离本属性。
          const clarifier = new LlmClarifier(provider, {
            perRoundQuestionLimit,
            topPhaseConvergenceThreshold: 1000,
          });

          const state = await clarifier.begin(ITEM, createInitialSession());
          const step = await clarifier.next(state);

          // 焦点阶段仅剩低风险模糊前提 → 必走「提问」分支（非充分/僵局）。
          expect(step.kind).toBe("questions");
          if (step.kind !== "questions") return;

          // 至少产出一个问题（焦点阶段存在 ≥1 个待消解低风险前提）。
          expect(step.questions.length).toBeGreaterThanOrEqual(1);

          // 核心不变量：每个**针对某前提**的问题都附带非空具体默认值（R8.3）。
          const targetedQuestions = step.questions.filter(
            (q) => q.targetPreconditionIds.length > 0,
          );
          // 本场景所有问题都针对低风险前提（无收敛建议、无 intent_not_testable）。
          expect(targetedQuestions.length).toBe(step.questions.length);

          for (const q of targetedQuestions) {
            expect(q.defaultOption).toBeDefined();
            expect(typeof q.defaultOption!.value).toBe("string");
            expect(q.defaultOption!.value.trim().length).toBeGreaterThan(0);
            // defaultOption 须明确作用于该问题所针对的前提。
            expect(q.defaultOption!.appliesTo).toEqual(q.targetPreconditionIds);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("边界：单个低风险模糊前提且 LLM 未给默认值时，走合成兜底仍产出非空默认值（示例）", async () => {
    const provider = new MockClarifierProvider(
      makeBeginPayload(1),
      makeNextPayload(1, false),
    );
    const clarifier = new LlmClarifier(provider, {
      perRoundQuestionLimit: 3,
      topPhaseConvergenceThreshold: 1000,
    });

    const state = await clarifier.begin(ITEM, createInitialSession());
    const step = await clarifier.next(state);

    expect(step.kind).toBe("questions");
    if (step.kind !== "questions") return;
    expect(step.questions.length).toBe(1);
    const q = step.questions[0]!;
    expect(q.defaultOption).toBeDefined();
    expect(q.defaultOption!.value.trim().length).toBeGreaterThan(0);
  });
});
