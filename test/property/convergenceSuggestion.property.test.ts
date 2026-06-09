// Feature: proactive-awareness-demo, Property 12: *For any* 任务分解出的逻辑阶段集合，当顶层阶段数量 > `topPhaseConvergenceThreshold` 时，Clarifier 产出一个 `isConvergenceSuggestion=true` 的收敛聚焦建议问题；当 ≤ 阈值时不产出该建议。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { LlmClarifier } from "../../src/clarifier/clarifier.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type { ClarifierState, LogicalPhase } from "../../src/clarifier/types.js";

/**
 * Property 12: 范围过大主动收敛
 *
 * Validates: Requirements 8.13
 *
 * 不变量（与 LLM 评估出的前提内容无关，仅由"顶层阶段数 vs 阈值"决定）：
 *  - 当 `phases.length > topPhaseConvergenceThreshold` 时，`next()` 产出的提问中
 *    恰好有一个 `isConvergenceSuggestion === true` 的收敛聚焦建议问题；
 *  - 当 `phases.length ≤ topPhaseConvergenceThreshold` 时，不产出任何收敛建议问题。
 *
 * 设计依据：design.md「Clarifier 算法详解」buildQuestions——顶层阶段数 > 阈值时
 * 前置恰好一个 `buildConvergenceQuestion`（R8.13）。
 */

// ---------------------------------------------------------------------------
// Mock LLM_Provider：complete 返回受控的 next 阶段（schema b）JSON。
// 让 focused 阶段恒含一个"高风险且模糊"的前提，从而 evaluateReadiness 必走 `ask`
// 分支，进入 buildQuestions（收敛建议的唯一注入点）。
// next() 只需调用一次 complete（高风险 ask 不会触发 advance_phase 重评）。
// ---------------------------------------------------------------------------
class MockLlmProvider implements LLM_Provider {
  readonly providerKey = "mock";

  constructor(private readonly payload: unknown) {}

  complete(_req: LlmRequest): Promise<LlmResponse> {
    return Promise.resolve({ text: JSON.stringify(this.payload) });
  }

  completeWithTools(): Promise<LlmToolResponse> {
    throw new Error("Property 12 测试不应触达 completeWithTools");
  }
}

/**
 * focused 阶段评估的受控输出：一个高风险且模糊的执行前提 + 一个普通候选问题。
 * 高风险（risk_level=high）保证 evaluateReadiness 返回 `ask`；related_action 不含
 * 任何高危关键词，风险注入只升级不降级，故等级保持 high。
 */
const NEXT_PAYLOAD = {
  preconditions: [
    {
      description: "需要明确的操作对象",
      status: "ambiguous",
      risk_level: "high",
      related_action: "执行关键修改",
    },
  ],
  phaseSaturated: false,
  questions: [
    {
      text: "请明确操作对象的具体路径？",
      targetPreconditionIndexes: [1],
    },
  ],
};

/** 确定性 id 生成器（避免依赖 randomUUID，便于复现）。 */
function makeIdFactory(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

/**
 * 构造一个直接可喂给 `next()` 的澄清会话状态：
 *  - `phaseCount` 个逻辑阶段（第一个 focused，其余 pending）；
 *  - `round = 0`（next 内 +1 = 1 < maxRounds，绝不进入软上限僵局）；
 *  - 携带受测阈值与单轮提问上限。
 */
function buildState(
  phaseCount: number,
  threshold: number,
  perRoundQuestionLimit: number,
): ClarifierState {
  const phases: LogicalPhase[] = Array.from({ length: phaseCount }, (_, i) => ({
    id: `phase-${i}`,
    title: `阶段 ${i + 1}`,
    order: i + 1,
    status: i === 0 ? "focused" : "pending",
  }));

  return {
    awarenessItemId: "aw-1",
    phases,
    preconditions: [],
    focusedPhaseId: phases[0]!.id,
    round: 0,
    maxRounds: 8,
    perRoundQuestionLimit,
    topPhaseConvergenceThreshold: threshold,
  };
}

/** 计数本轮提问中的收敛建议问题。 */
async function countConvergence(
  phaseCount: number,
  threshold: number,
  perRoundQuestionLimit: number,
): Promise<number> {
  const clarifier = new LlmClarifier(new MockLlmProvider(NEXT_PAYLOAD), {
    idFactory: makeIdFactory(),
  });
  const step = await clarifier.next(
    buildState(phaseCount, threshold, perRoundQuestionLimit),
  );

  expect(step.kind).toBe("questions");
  if (step.kind !== "questions") return -1;

  return step.questions.filter((q) => q.isConvergenceSuggestion === true).length;
}

describe("Property 12: 范围过大主动收敛", () => {
  it("阶段数 > 阈值恰好产出一个收敛建议，≤ 阈值则不产出（任意阶段数/阈值/单轮上限）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 16 }), // phaseCount
        fc.integer({ min: 1, max: 8 }), // topPhaseConvergenceThreshold
        fc.integer({ min: 1, max: 5 }), // perRoundQuestionLimit
        async (phaseCount, threshold, limit) => {
          const convergenceCount = await countConvergence(
            phaseCount,
            threshold,
            limit,
          );

          if (phaseCount > threshold) {
            // 范围过大：恰好一个 isConvergenceSuggestion=true 的建议（R8.13）。
            expect(convergenceCount).toBe(1);
          } else {
            // 范围未超阈值：绝不产出收敛建议。
            expect(convergenceCount).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("边界：阶段数恰等于阈值时不产出收敛建议（示例）", async () => {
    expect(await countConvergence(6, 6, 3)).toBe(0);
  });

  it("边界：阶段数为阈值+1 时产出恰好一个收敛建议（示例）", async () => {
    expect(await countConvergence(7, 6, 3)).toBe(1);
  });

  it("单轮提问上限=1 时收敛建议仍被保留（前置不被截断，示例）", async () => {
    expect(await countConvergence(10, 6, 1)).toBe(1);
  });
});
