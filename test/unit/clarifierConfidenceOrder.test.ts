/**
 * 任务 7.14：Clarifier `confidenceScore` 提问排序单元测试（vitest，非 property）。
 *
 * 覆盖 `LlmClarifier.next` 的提问排序（R8.8，可选增强项「不确定性数值化」）：
 *  - 例子1：同等风险（都 medium、都 ambiguous 未消解）但 `confidenceScore` 不同的多个前提，
 *    断言 `next` 产出的问题顺序中——`confidenceScore` 更低（越不确定）的前提对应的问题排在更前。
 *  - 例子2：所有前提都不带 `confidenceScore` 时，排序退化为按 `risk_level`/`status`
 *    （与基线一致、行为不变）——断言不报错，且问题集合覆盖各前提，并体现「高风险优先」。
 *
 * 按 design「可选增强项的测试归属」：不新增 Correctness Property，仅以少量 unit 例子覆盖；
 * `confidenceScore` 缺省时主流程不受影响、顺序退化为仅按 risk_level/status 判定。
 *
 * 与已有 `clarifier.test.ts` / `lowRiskDefaultOption.property.test.ts` 一致地使用可控 mock
 * `LLM_Provider`：按请求 `jsonSchema.required` 区分 begin（含 "phases"）/ next（含 "preconditions"）段。
 * 两个例子均**只触达 begin / next 两段**（焦点阶段恒有未消解模糊前提 ⇒ 恒走「提问」分支，不到 sufficient）。
 *
 * _Requirements: 8.8_
 */

import { describe, it, expect } from "vitest";

import { LlmClarifier } from "../../src/clarifier/clarifier.js";
import { createInitialSession } from "../../src/orchestrator/session.js";
import type { Awareness_Item } from "../../src/analyzer/analyzer.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 一条最小可用的察觉项（begin 的输入；Clarifier 仅取 title/rationale/evidence 构造 prompt）。 */
const ITEM: Awareness_Item = {
  id: "aw-1",
  title: "整理项目配置文件",
  rationale: "依据扫描摘要推断的最近最需要做的事。",
  evidence: ["扫描条目-1"],
};

/** begin 输出：恰一个逻辑阶段（阶段数远小于收敛阈值，绝不前置收敛建议问题）。 */
const BEGIN_ONE_PHASE = JSON.stringify({
  phases: [{ title: "实现改动", order: 1 }],
  convergenceSuggested: false,
});

/** 按 jsonSchema.required 判定当前是哪一段 LLM 调用（参考既有 clarifier 测试写法）。 */
type ClarifierStage = "begin" | "next" | "sufficient";
function stageOf(req: LlmRequest): ClarifierStage {
  const required =
    ((req.jsonSchema as { required?: string[] } | undefined)?.required ??
      []) as string[];
  if (required.includes("phases")) return "begin";
  if (required.includes("preconditions")) return "next";
  if (required.includes("objective")) return "sufficient";
  throw new Error(
    `无法依据 schema.required 判定澄清阶段：${JSON.stringify(required)}`,
  );
}

/** 可控 mock LLM_Provider：begin 段恒返回单阶段；next 段返回受控前提清单。 */
function makeProvider(nextPayload: unknown): LLM_Provider {
  return {
    providerKey: "mock",
    complete(req: LlmRequest): Promise<LlmResponse> {
      const stage = stageOf(req);
      if (stage === "begin") {
        return Promise.resolve({ text: BEGIN_ONE_PHASE });
      }
      if (stage === "next") {
        return Promise.resolve({ text: JSON.stringify(nextPayload) });
      }
      // 本测试场景焦点阶段恒有未消解模糊前提 ⇒ 恒走「提问」分支，不应触达 sufficient。
      throw new Error("confidenceScore 排序测试不应触达 sufficient 段。");
    },
    completeWithTools(_req: LlmToolRequest): Promise<LlmToolResponse> {
      throw new Error("not used in clarifier confidence-order tests");
    },
  };
}

/** 固定自增 id 工厂，便于得到确定性输出。 */
function seqIdFactory(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/**
 * 单个 next 段前提的构造工具。
 * - `related_action` 取良性中文描述，绝不触发风险注入的强制高危规则（保持 LLM 给出的等级）；
 * - 不给 `proposedDefault`、不给 `resolvedBy`，保证该前提进入「待消解」集合而被提问。
 */
function pc(opts: {
  description: string;
  risk_level: "low" | "medium";
  confidenceScore?: number;
}): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    description: opts.description,
    status: "ambiguous",
    risk_level: opts.risk_level,
    related_action: `查看并整理「${opts.description}」`,
  };
  if (typeof opts.confidenceScore === "number") {
    obj.confidenceScore = opts.confidenceScore;
  }
  return obj;
}

/** 为第 i 个前提（1-based）构造一个文本可辨识的候选问题。 */
function q(marker: string, index1Based: number): Record<string, unknown> {
  return { text: marker, targetPreconditionIndexes: [index1Based] };
}

/** 在问题数组中找出首个文本包含给定标记的问题的下标（找不到返回 -1）。 */
function indexOfMarker(
  questions: { text: string }[],
  marker: string,
): number {
  return questions.findIndex((qq) => qq.text.includes(marker));
}

// ===========================================================================
// 例子1：同等风险下，confidenceScore 更低（越不确定）的前提对应问题排在更前
// ===========================================================================

describe("LlmClarifier confidenceScore 提问排序（R8.8）", () => {
  it("同等风险（都 medium、都 ambiguous 未消解）下，低 confidenceScore 的前提问题排在更前", async () => {
    // 三个同为 medium、ambiguous、未消解的前提，confidenceScore 各不相同。
    // 数组初始顺序刻意为 高→低→中（0.9, 0.3, 0.6），以确保「排序」确实发生了作用，
    // 而非碰巧沿用初始顺序。
    const nextPayload = {
      preconditions: [
        pc({ description: "PC-A", risk_level: "medium", confidenceScore: 0.9 }),
        pc({ description: "PC-B", risk_level: "medium", confidenceScore: 0.3 }),
        pc({ description: "PC-C", risk_level: "medium", confidenceScore: 0.6 }),
      ],
      phaseSaturated: false,
      deferRemaining: false,
      questions: [q("Q-A", 1), q("Q-B", 2), q("Q-C", 3)],
    };

    const clarifier = new LlmClarifier(makeProvider(nextPayload), {
      idFactory: seqIdFactory(),
      // 抬高收敛阈值，确保不因「阶段过多」前置收敛建议问题；保证单轮上限 ≥ 前提数。
      topPhaseConvergenceThreshold: 1000,
      perRoundQuestionLimit: 5,
    });

    const state = await clarifier.begin(ITEM, createInitialSession());
    const step = await clarifier.next(state);

    expect(step.kind).toBe("questions");
    if (step.kind !== "questions") throw new Error("unreachable");

    // 三个前提都被提问（无截断、无收敛前置）。
    expect(step.questions).toHaveLength(3);

    const iB = indexOfMarker(step.questions, "Q-B"); // confidence 0.3（最不确定）
    const iC = indexOfMarker(step.questions, "Q-C"); // confidence 0.6
    const iA = indexOfMarker(step.questions, "Q-A"); // confidence 0.9（最确定）
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iC).toBeGreaterThanOrEqual(0);
    expect(iA).toBeGreaterThanOrEqual(0);

    // 核心断言：confidenceScore 升序排列 ⇒ 越不确定越靠前（0.3 → 0.6 → 0.9）。
    expect(iB).toBeLessThan(iC);
    expect(iC).toBeLessThan(iA);

    // 低于披露阈值（0.7）的前提，问题文本前置「把握」披露；0.9 不披露。
    const qB = step.questions[iB]!;
    const qA = step.questions[iA]!;
    expect(qB.text).toContain("把握");
    expect(qA.text).not.toContain("把握");
  });

  // =========================================================================
  // 例子2：所有前提都不带 confidenceScore → 退化为按 risk_level/status 排序（行为不变）
  // =========================================================================

  it("无 confidenceScore 时，排序退化为按 risk_level/status：不报错、覆盖各前提且高风险优先", async () => {
    // 两个未消解模糊前提：一个 medium、一个 low，均不带 confidenceScore。
    // 数组初始顺序刻意把 low 放前面，以验证退化排序仍按 risk_level（medium 在前）。
    const nextPayload = {
      preconditions: [
        pc({ description: "PC-LOW", risk_level: "low" }),
        pc({ description: "PC-MED", risk_level: "medium" }),
      ],
      phaseSaturated: false,
      deferRemaining: false,
      questions: [q("Q-LOW", 1), q("Q-MED", 2)],
    };

    const clarifier = new LlmClarifier(makeProvider(nextPayload), {
      idFactory: seqIdFactory(),
      topPhaseConvergenceThreshold: 1000,
      perRoundQuestionLimit: 5,
    });

    const state = await clarifier.begin(ITEM, createInitialSession());

    // 不报错（confidenceScore 缺省不影响主流程）。
    const step = await clarifier.next(state);
    expect(step.kind).toBe("questions");
    if (step.kind !== "questions") throw new Error("unreachable");

    // 问题集合覆盖各前提（两个前提各对应一个问题，无截断）。
    expect(step.questions).toHaveLength(2);
    const iMed = indexOfMarker(step.questions, "Q-MED");
    const iLow = indexOfMarker(step.questions, "Q-LOW");
    expect(iMed).toBeGreaterThanOrEqual(0);
    expect(iLow).toBeGreaterThanOrEqual(0);

    // 退化排序：无 confidenceScore ⇒ 仅按 risk_level（medium 高于 low）排序，medium 在前；
    // 与基线一致、行为不变（不因缺省 confidence 报错或乱序）。
    expect(iMed).toBeLessThan(iLow);

    // 无 confidenceScore ⇒ 不出现「把握」披露话术（行为不变）。
    for (const qq of step.questions) {
      expect(qq.text).not.toContain("把握");
    }
  });
});
