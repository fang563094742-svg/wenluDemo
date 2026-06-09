/**
 * 任务 7.13：Clarifier 动态生成与「充分性确认问询」单元测试（vitest，非 property）。
 *
 * 覆盖（mock LLM_Provider，按 jsonSchema.required 区分 begin/next/sufficient 段，不接真实供应方）：
 *  - 问题动态生成（R8.1）：`LlmClarifier.next` 产出的澄清问题文本来自 LLM 输出，
 *    而非固定模板——同一前提、不同 LLM 文本 → 不同问题文本（且不等于确定性兜底模板）。
 *  - 充分性确认问询（R8.10）：声明充分（`sufficient` step）后产出可支撑执行的 Task_Frame，
 *    且 `UNDERSTANDING_CONFIRMATION_PROMPT` 即「基于以上理解，我可以开始执行吗？」的确认问询语义。
 *  - LLM 调用失败时抛 `ClarifierError`（描述性、非致命），而非让进程崩溃——服务保持可继续运行。
 *
 * _Requirements: 8.1, 8.10_
 */

import { describe, it, expect, vi } from "vitest";

import {
  LlmClarifier,
  ClarifierError,
  UNDERSTANDING_CONFIRMATION_PROMPT,
} from "../../src/clarifier/clarifier.js";
import type { ClarifierState } from "../../src/clarifier/types.js";
import { createInitialSession } from "../../src/orchestrator/session.js";
import type { Session } from "../../src/orchestrator/session.js";
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

/** 一条最小可用的察觉项（begin 的输入）。 */
function makeItem(): Awareness_Item {
  return {
    id: "aw-1",
    title: "补全 src/config.ts 缺失的配置字段",
    rationale: "我检测到 config.ts 最近被改动且缺少字段；我猜你想补全它。",
    evidence: ["/Users/demo/work/src/config.ts"],
  };
}

/** 一个最小会话（begin 仅读取 session.scanSummary，缺省即可）。 */
function makeSession(): Session {
  return createInitialSession("sess-1");
}

/** 固定自增 id 工厂，便于得到确定性输出。 */
function seqIdFactory(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/** 澄清三段的标识（依据每段 JSON schema 的 required 字段判定）。 */
type ClarifierStage = "begin" | "next" | "sufficient";

/** 按 jsonSchema.required 推断当前是哪一段 LLM 调用。 */
function stageOf(req: LlmRequest): ClarifierStage {
  const required = ((req.jsonSchema as { required?: string[] } | undefined)
    ?.required ?? []) as string[];
  if (required.includes("phases")) return "begin";
  if (required.includes("preconditions")) return "next";
  if (required.includes("objective")) return "sufficient";
  throw new Error(`无法依据 schema.required 判定澄清阶段：${JSON.stringify(required)}`);
}

/**
 * 可控 mock LLM_Provider：按段分派 responder。
 *  - responder 返回字符串 → 作为 LLM 文本输出。
 *  - responder 内部 throw → 模拟该段调用失败（complete reject）。
 * 记录每段调用次数。
 */
function makeMockProvider(responders: {
  begin?: (req: LlmRequest) => string;
  next?: (req: LlmRequest) => string;
  sufficient?: (req: LlmRequest) => string;
}): { provider: LLM_Provider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => {
    const stage = stageOf(req);
    const responder = responders[stage];
    if (!responder) {
      throw new Error(`未为澄清阶段 ${stage} 配置 responder`);
    }
    return { text: responder(req) }; // responder 内部 throw 即模拟该段调用失败
  });

  const provider: LLM_Provider = {
    providerKey: "mock",
    complete,
    completeWithTools: async (_req: LlmToolRequest): Promise<LlmToolResponse> => {
      throw new Error("not used in clarifier tests");
    },
  };
  return { provider, complete };
}

// 单阶段输出夹具 ------------------------------------------------------------

/** begin 输出：恰一个逻辑阶段（阶段数不触发收敛建议阈值 6）。 */
const BEGIN_ONE_PHASE = JSON.stringify({
  phases: [{ title: "实现改动", order: 1 }],
  convergenceSuggested: false,
});

/** next 输出：一个高风险且模糊的前提 + 一个 LLM 动态生成的、针对该前提的问题。 */
function nextWithHighRiskQuestion(questionText: string): string {
  return JSON.stringify({
    preconditions: [
      {
        description: "操作对象的具体路径",
        status: "ambiguous",
        risk_level: "high",
        related_action: "确定本次改动的目标文件",
      },
    ],
    phaseSaturated: false,
    questions: [{ text: questionText, targetPreconditionIndexes: [1] }],
  });
}

/** next 输出：所有前提均已知、低风险、阶段饱和（驱动 evaluateReadiness 走向 sufficient）。 */
const NEXT_ALL_KNOWN = JSON.stringify({
  preconditions: [
    {
      description: "目标配置文件路径已确认",
      status: "known",
      risk_level: "low",
      related_action: "读取 src/config.ts 并校验字段",
    },
  ],
  phaseSaturated: true,
  deferRemaining: false,
  questions: [],
});

/** sufficient 输出：可机检的 Task_Frame。 */
const SUFFICIENT_FRAME = JSON.stringify({
  objective: "在 src/config.ts 中补充缺失的配置字段",
  acceptanceTests: [
    {
      description: "项目可成功构建",
      checkMethod: "运行 npm run build 并检查退出码为 0",
    },
  ],
  primaryTargets: ["src/config.ts"],
});

/** begin 输出（别名变体）：顶层用 `stages`、阶段标题用 `name`（真实 GPT-5.4 实测形状）。 */
const BEGIN_ALIAS_STAGES_NAME = JSON.stringify({
  convergenceSuggested: false,
  stages: [
    { order: 1, name: "梳理项目信息与 README 目标", description: "..." },
    { order: 2, name: "设计 README 结构", description: "..." },
  ],
});

// ===========================================================================
// 1) 问题动态生成（R8.1）：问题文本来自 LLM 输出，而非固定模板
// ===========================================================================

describe("LlmClarifier 动态生成澄清问题（R8.1）", () => {
  async function askFirstQuestionText(llmQuestionText: string): Promise<{
    text: string;
    completeCalls: number;
  }> {
    const { provider, complete } = makeMockProvider({
      begin: () => BEGIN_ONE_PHASE,
      next: () => nextWithHighRiskQuestion(llmQuestionText),
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());
    const step = await clarifier.next(state);

    expect(step.kind).toBe("questions");
    if (step.kind !== "questions") throw new Error("unreachable");
    expect(step.questions).toHaveLength(1);
    return { text: step.questions[0]!.text, completeCalls: complete.mock.calls.length };
  }

  it("问题文本直接采用 LLM 给出的动态文本（而非确定性兜底模板）", async () => {
    const llmText = "你打算改动哪个具体文件？请给出相对项目根目录的路径。";
    const { text, completeCalls } = await askFirstQuestionText(llmText);

    // 文本来自 LLM 输出
    expect(text).toBe(llmText);
    // 不是确定性兜底模板（synthesizeQuestionText 形如「关于「…」…，能否进一步明确？」）
    expect(text).not.toContain("能否进一步明确");
    // begin + next 各走一次 LLM（动态推断，而非常量返回）
    expect(completeCalls).toBe(2);
  });

  it("同一前提、不同 LLM 文本 → 不同问题文本（证明非固定模板）", async () => {
    const a = await askFirstQuestionText("方案 A：是否只改动 config.ts 这一个文件？");
    const b = await askFirstQuestionText("方案 B：要不要顺带更新相关的类型声明文件？");

    expect(a.text).toBe("方案 A：是否只改动 config.ts 这一个文件？");
    expect(b.text).toBe("方案 B：要不要顺带更新相关的类型声明文件？");
    expect(a.text).not.toBe(b.text); // 问题随 LLM 输出变化，而非固定模板
  });
});

// ===========================================================================
// 2) 充分性确认问询（R8.10）：声明充分后产出 Task_Frame，并明确确认问询语义
// ===========================================================================

describe("LlmClarifier 声明充分后的确认问询（R8.10）", () => {
  it("UNDERSTANDING_CONFIRMATION_PROMPT 即「基于以上理解，我可以开始执行吗？」", () => {
    expect(UNDERSTANDING_CONFIRMATION_PROMPT).toBe("基于以上理解，我可以开始执行吗？");
  });

  it("声明充分（sufficient step）时产出可支撑执行的 Task_Frame，待用户最终确认", async () => {
    const { provider, complete } = makeMockProvider({
      begin: () => BEGIN_ONE_PHASE,
      next: () => NEXT_ALL_KNOWN,
      sufficient: () => SUFFICIENT_FRAME,
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());
    const step = await clarifier.next(state);

    // 声明信息充分
    expect(step.kind).toBe("sufficient");
    if (step.kind !== "sufficient") throw new Error("unreachable");

    // 产出可支撑执行、附验收测试与置信度说明的 Task_Frame（R8.8/8.9）
    const frame = step.taskFrame;
    expect(frame.objective).toBe("在 src/config.ts 中补充缺失的配置字段");
    expect(frame.acceptanceTests.length).toBeGreaterThan(0);
    expect(frame.acceptanceTests[0]!.checkMethod).toContain("npm run build");
    expect(frame.confidence).toBeDefined();
    expect(frame.primaryTargets).toContain("src/config.ts");

    // 充分时确认问询语义由该常量承载（呈现/确认门由 UI 与状态机负责）
    expect(UNDERSTANDING_CONFIRMATION_PROMPT).toContain("我可以开始执行吗");

    // begin + next(评估) + sufficient(组装) 三次 LLM 调用
    expect(complete.mock.calls.length).toBe(3);
  });
});

// ===========================================================================
// 3) LLM 调用失败 → 抛 ClarifierError（描述性、非致命，服务保持运行）
// ===========================================================================

/** 构造一个 focused 单阶段、无前提的最小澄清状态（用于直接测试 next 失败分支）。 */
function makeMinimalState(): ClarifierState {
  const phaseId = "phase-1";
  return {
    awarenessItemId: "aw-1",
    phases: [{ id: phaseId, title: "实现改动", order: 1, status: "focused" }],
    preconditions: [],
    focusedPhaseId: phaseId,
    round: 0,
    maxRounds: 8,
    perRoundQuestionLimit: 3,
    topPhaseConvergenceThreshold: 6,
  };
}

describe("LlmClarifier LLM 失败分支保持服务运行", () => {
  it("begin 阶段 provider.complete 抛错时，包装为 ClarifierError（不让进程崩溃）", async () => {
    const { provider, complete } = makeMockProvider({
      begin: () => {
        throw new Error("network down: ECONNREFUSED");
      },
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    await expect(clarifier.begin(makeItem(), makeSession())).rejects.toBeInstanceOf(
      ClarifierError,
    );
    await expect(
      clarifier.begin(makeItem(), makeSession()),
    ).rejects.toMatchObject({ name: "ClarifierError" });
    expect(complete.mock.calls.length).toBe(2);
  });

  it("next 阶段 provider.complete 抛错时，包装为 ClarifierError", async () => {
    const { provider } = makeMockProvider({
      next: () => {
        throw new Error("upstream 503");
      },
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    await expect(clarifier.next(makeMinimalState())).rejects.toBeInstanceOf(
      ClarifierError,
    );
  });

  it("LLM 返回不可解析文本时，抛 ClarifierError（解析失败也非致命）", async () => {
    const { provider } = makeMockProvider({
      begin: () => "我无法给出 JSON，这是一段没有大括号的纯文字",
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    await expect(clarifier.begin(makeItem(), makeSession())).rejects.toBeInstanceOf(
      ClarifierError,
    );
  });

  it("一次失败后再次正常调用仍可成功（服务保持可继续运行，非一次失败即崩溃）", async () => {
    let beginCalls = 0;
    const { provider } = makeMockProvider({
      begin: () => {
        beginCalls += 1;
        if (beginCalls === 1) throw new Error("transient failure");
        return BEGIN_ONE_PHASE;
      },
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    await expect(clarifier.begin(makeItem(), makeSession())).rejects.toBeInstanceOf(
      ClarifierError,
    );
    const state = await clarifier.begin(makeItem(), makeSession());
    expect(state.phases).toHaveLength(1);
    expect(state.focusedPhaseId).toBe(state.phases[0]!.id);
  });
});

// ===========================================================================
// 4) 真实模型字段别名兜底（解析健壮性）：不严格遵守 schema 时仍能解析
//
// 背景：真实 GPT-5.4 在 begin 阶段曾用 `stages`+`name`（而非 schema 要求的 `phases`+`title`），
// 导致解析出 0 个阶段并抛 ClarifierError。这些用例锁定解析兜底：接受常见别名、保留原字段优先级、
// 阶段数 = LLM 给出数不截断（R8.5 / Property 8）。schema 常量本身仍按规范声明，仅解析多认别名。
// ===========================================================================

describe("LlmClarifier 解析别名兜底（真实模型健壮性）", () => {
  it("begin：顶层用 stages、阶段用 name 时仍能解析出全部阶段（不抛错、不截断）", async () => {
    const { provider } = makeMockProvider({
      begin: () => BEGIN_ALIAS_STAGES_NAME,
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());

    // 阶段数 = LLM 给出数（2），不因别名而丢失。
    expect(state.phases).toHaveLength(2);
    expect(state.phases.map((p) => p.title)).toEqual([
      "梳理项目信息与 README 目标",
      "设计 README 结构",
    ]);
    // 恰一个被聚焦（order 最小者）。
    expect(state.phases.filter((p) => p.status === "focused")).toHaveLength(1);
    expect(state.focusedPhaseId).toBe(
      state.phases.find((p) => p.title === "梳理项目信息与 README 目标")!.id,
    );
  });

  it("begin：order 缺失时按数组序号兜底排序", async () => {
    const { provider } = makeMockProvider({
      begin: () =>
        JSON.stringify({
          convergenceSuggested: false,
          stages: [{ name: "第一步" }, { name: "第二步" }, { name: "第三步" }],
        }),
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());

    expect(state.phases).toHaveLength(3);
    expect(state.phases.map((p) => p.order)).toEqual([1, 2, 3]);
    // 第一项（兜底 order=1）被聚焦。
    expect(state.focusedPhaseId).toBe(
      state.phases.find((p) => p.title === "第一步")!.id,
    );
  });

  it("begin：原字段 phases/title 优先于别名（同时存在时取规范字段）", async () => {
    const { provider } = makeMockProvider({
      begin: () =>
        JSON.stringify({
          convergenceSuggested: false,
          // 同时给出 phases（规范）与 stages（别名）：应取 phases。
          phases: [{ title: "规范阶段", order: 1 }],
          stages: [{ name: "别名阶段甲", order: 1 }, { name: "别名阶段乙", order: 2 }],
        }),
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());

    expect(state.phases).toHaveLength(1);
    expect(state.phases[0]!.title).toBe("规范阶段");
  });

  it("next：前提用 desc/risk/action、问题用 question 时仍能解析并提问", async () => {
    const { provider } = makeMockProvider({
      begin: () => BEGIN_ONE_PHASE,
      next: () =>
        JSON.stringify({
          preconditions: [
            {
              desc: "操作对象的具体路径",
              status: "ambiguous",
              risk: "high",
              action: "确定本次改动的目标文件",
            },
          ],
          phaseSaturated: false,
          questions: [
            { question: "你要改哪个文件？", targetPreconditionIndexes: [1] },
          ],
        }),
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());
    const step = await clarifier.next(state);

    expect(step.kind).toBe("questions");
    if (step.kind !== "questions") throw new Error("unreachable");
    expect(step.questions).toHaveLength(1);
    // 问题文本来自别名字段 question。
    expect(step.questions[0]!.text).toBe("你要改哪个文件？");
  });

  it("sufficient：Task_Frame 用 goal、验收测试用 check/desc 别名时仍能组装", async () => {
    const { provider } = makeMockProvider({
      begin: () => BEGIN_ONE_PHASE,
      next: () => NEXT_ALL_KNOWN,
      sufficient: () =>
        JSON.stringify({
          goal: "在 src/config.ts 中补充缺失的配置字段",
          acceptanceTests: [
            {
              desc: "项目可成功构建",
              check: "运行 npm run build 并检查退出码为 0",
            },
          ],
          primaryTargets: ["src/config.ts"],
        }),
    });
    const clarifier = new LlmClarifier(provider, { idFactory: seqIdFactory() });

    const state = await clarifier.begin(makeItem(), makeSession());
    const step = await clarifier.next(state);

    expect(step.kind).toBe("sufficient");
    if (step.kind !== "sufficient") throw new Error("unreachable");
    const frame = step.taskFrame;
    expect(frame.objective).toBe("在 src/config.ts 中补充缺失的配置字段");
    expect(frame.acceptanceTests).toHaveLength(1);
    expect(frame.acceptanceTests[0]!.description).toBe("项目可成功构建");
    expect(frame.acceptanceTests[0]!.checkMethod).toContain("npm run build");
  });
});
