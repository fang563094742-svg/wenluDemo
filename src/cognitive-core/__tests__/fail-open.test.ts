/**
 * 认知核三段脊柱 · fail-open 硬覆盖断言（任务 7.3 · 最高约束·不带 *·不可跳过）
 * ------------------------------------------------------------------
 * 验证「降级安全 fail-open」铁律（design.md「最高约束章·约束 4」「Error Handling」
 * 末行核心原则、Correctness Property 1）：**三段脊柱任一段注入异常，认知核公共 API
 * 都吞掉异常并退回安全兜底行为——promise 永不 reject、异常绝不冒泡到调用方主循环。**
 *
 * 覆盖三段注入：
 *  1. PlanKernel：`planFromContext(ctx, throwingLlm)` —— `llm.refinePlan` 抛错时
 *     返回业务字段 === `planDeterministic(ctx)` 的兜底 Intent，promise 不 reject。
 *  2. OutputKernel：`condense(intent, signal, ctx, throwingLlm)` —— `llm.condenseOutput`
 *     抛错时退回 `deterministicCondense` 文本兜底，promise 不 reject。
 *  3. DispatchKernel：`dispatchSafe(cyclicIntent)` —— 含环 intent 不抛，降级为
 *     "全部 subgoal 串行单波"（每波 1 条 line）。
 *
 * 并以 fast-check 生成随机 ctx / signal / intent，统一断言：
 *     「任一段注入异常 ⟹ 不冒泡、退回兜底」。
 *
 * 绝对边界（参见 design.md「最高约束章·约束 4」）：
 *  - 测试只从 barrel `../index.js` 导入认知核公共 API（不触碰内部模块相对路径）。
 *  - 仅 import vitest / fast-check 与 barrel；不 import 任何 3.1/3.2 路径、
 *    不 node:sqlite、不 import riverMain.ts。不改实现。
 *
 * **Validates: Requirements 4.5, 12.1, 12.4**
 * _Requirements: 4.5, 12.1, 12.4_
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  planFromContext,
  planDeterministic,
  condense,
  deterministicCondense,
  dispatchSafe,
  isValidDag,
  type Intent,
  type LlmLike,
  type NodeSignal,
  type OutputContext,
  type PlanContext,
  type Subgoal,
} from "../index.js";

// ─── 注入异常的 llm（三段焊接点的"故障注入"） ─────────────────

/** refinePlan 与 condenseOutput 都必抛错的 llm（同时注入 plan/output 两段异常）。 */
const throwingLlm: LlmLike = {
  refinePlan(): Promise<Intent> {
    throw new Error("inject: refinePlan boom (plan 段异常)");
  },
  condenseOutput(): Promise<string> {
    throw new Error("inject: condenseOutput boom (output 段异常)");
  },
};

/** refinePlan / condenseOutput 都返回 rejected promise（异步异常注入，覆盖 await 抛错路径）。 */
const rejectingLlm: LlmLike = {
  refinePlan(): Promise<Intent> {
    return Promise.reject(new Error("inject: refinePlan async reject"));
  },
  condenseOutput(): Promise<string> {
    return Promise.reject(new Error("inject: condenseOutput async reject"));
  },
};

// ─── 生成器 ──────────────────────────────────────────────────

/** 任意单条对话 turn。 */
function arbTurn(): fc.Arbitrary<{ role: string; text: string }> {
  return fc.record({
    role: fc.oneof(
      fc.constantFrom("user", "human", "assistant", "system", "ai"),
      fc.string(),
    ),
    text: fc.string(),
  });
}

/** 任意 PlanContext（含 dry-run/enforce、userUtterance null/非空、可选只读线索）。 */
function arbPlanContext(): fc.Arbitrary<PlanContext> {
  return fc.record({
    userUtterance: fc.oneof(fc.constant(null), fc.string()),
    recentConversation: fc.array(arbTurn(), { maxLength: 6 }),
    northStarGap: fc.option(
      fc.record({ gap: fc.integer({ min: 0, max: 100 }) }),
      { nil: undefined },
    ),
    riverbedReasons: fc.option(fc.array(fc.string(), { maxLength: 4 }), {
      nil: undefined,
    }),
    chronoSummaries: fc.option(fc.array(fc.string(), { maxLength: 4 }), {
      nil: undefined,
    }),
    mode: fc.constantFrom("dry-run", "enforce") as fc.Arbitrary<
      PlanContext["mode"]
    >,
  });
}

/** 任意 NodeSignal（含 progress 与三种真节点；summary 可空）。 */
function arbNodeSignal(): fc.Arbitrary<NodeSignal> {
  return fc.record({
    kind: fc.constantFrom(
      "done",
      "blocked",
      "needs_user",
      "progress",
    ) as fc.Arbitrary<NodeSignal["kind"]>,
    taskId: fc.option(fc.string(), { nil: undefined }),
    summary: fc.string(),
  });
}

/** 任意 OutputContext（含 dry-run/enforce、可选差距、随机预算）。 */
function arbOutputContext(): fc.Arbitrary<OutputContext> {
  return fc.record({
    northStarGap: fc.option(
      fc.record({ gap: fc.integer({ min: 0, max: 100 }) }),
      { nil: undefined },
    ),
    mode: fc.constantFrom("dry-run", "enforce") as fc.Arbitrary<
      OutputContext["mode"]
    >,
    outputCharBudget: fc.integer({ min: 1, max: 500 }),
  });
}

/** 经 planDeterministic 产出的任意合法 Intent（供 condense 注入测试用）。 */
function arbIntent(): fc.Arbitrary<Intent> {
  return arbPlanContext().map((ctx) => planDeterministic(ctx));
}

/** 提取 Intent 业务字段（忽略 id / createdAt）用于深等断言。 */
function businessFields(intent: Intent): Omit<Intent, "id" | "createdAt"> {
  const { id: _id, createdAt: _createdAt, ...rest } = intent;
  return rest;
}

/** 构造一个含环（2 节点互相依赖）的 Intent。 */
function makeCyclicIntent(): Intent {
  const cyclicSubgoals: Subgoal[] = [
    { id: "x", goal: "gx", dependsOn: ["y"], expectedResult: "rx" },
    { id: "y", goal: "gy", dependsOn: ["x"], expectedResult: "ry" },
  ];
  return {
    id: "intent_cyclic_fixed",
    sourceUtterance: null,
    goal: "含环意图（用于 dispatch 降级测试）",
    subgoals: cyclicSubgoals,
    expectedResult: "expected",
    acceptanceLine: "acceptance",
    status: "planned",
    createdAt: new Date(0).toISOString(),
    mode: "enforce",
  };
}

// ─── 1. PlanKernel 段注入异常：planFromContext fail-open ──────

describe("fail-open · PlanKernel 段注入异常 (Req 4.5, 12.1, 12.4)", () => {
  it("∀ ctx，refinePlan 抛错时 planFromContext 退回 planDeterministic 且 promise 不 reject", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlanContext(), async (ctx) => {
        // 同步 throw 注入：不应冒泡，应退回兜底。
        const result = await planFromContext(ctx, throwingLlm);
        expect(businessFields(result)).toEqual(
          businessFields(planDeterministic(ctx)),
        );
        expect(result.status).toBe("planned");
        expect(isValidDag(result.subgoals)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("∀ ctx，refinePlan 异步 reject 时 planFromContext 仍退回兜底且不 reject", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlanContext(), async (ctx) => {
        const result = await planFromContext(ctx, rejectingLlm);
        expect(businessFields(result)).toEqual(
          businessFields(planDeterministic(ctx)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("具体用例：plan 段抛异常不冒泡（resolves，不 rejects）", async () => {
    const ctx: PlanContext = {
      userUtterance: "帮我把整件事规划好",
      recentConversation: [],
      mode: "enforce",
    };
    await expect(planFromContext(ctx, throwingLlm)).resolves.toBeDefined();
    await expect(planFromContext(ctx, rejectingLlm)).resolves.toBeDefined();
  });
});

// ─── 2. OutputKernel 段注入异常：condense fail-open ───────────

describe("fail-open · OutputKernel 段注入异常 (Req 4.5, 12.1, 12.4)", () => {
  it("∀ intent/signal/ctx，condenseOutput 抛错时退回 deterministicCondense 且不 reject", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIntent(),
        arbNodeSignal(),
        arbOutputContext(),
        async (intent, signal, ctx) => {
          const out = await condense(intent, signal, ctx, throwingLlm);
          // 退回确定性兜底：text 应等于 deterministicCondense 经预算裁剪后的结果。
          const fallback = deterministicCondense(intent, signal);
          const expectedText = Array.from(fallback)
            .slice(0, ctx.outputCharBudget)
            .join("");
          expect(out.text).toBe(expectedText);
          // 方向分恒有界、溯源正确。
          expect(out.directionAlignmentScore).toBeGreaterThanOrEqual(0);
          expect(out.directionAlignmentScore).toBeLessThanOrEqual(1);
          expect(out.intentId).toBe(intent.id);
          // dry-run 终态恒 suppressed（零外溢）。
          if (ctx.mode === "dry-run") {
            expect(out.status).toBe("suppressed");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("∀ intent/signal/ctx，condenseOutput 异步 reject 时仍退回兜底且不 reject", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIntent(),
        arbNodeSignal(),
        arbOutputContext(),
        async (intent, signal, ctx) => {
          const out = await condense(intent, signal, ctx, rejectingLlm);
          const fallback = deterministicCondense(intent, signal);
          const expectedText = Array.from(fallback)
            .slice(0, ctx.outputCharBudget)
            .join("");
          expect(out.text).toBe(expectedText);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("具体用例：output 段抛异常不冒泡（resolves，不 rejects）", async () => {
    const intent = planDeterministic({
      userUtterance: "做个工具",
      recentConversation: [],
      mode: "enforce",
    });
    const signal: NodeSignal = { kind: "done", summary: "搞定了" };
    const ctx: OutputContext = { mode: "enforce", outputCharBudget: 200 };
    await expect(
      condense(intent, signal, ctx, throwingLlm),
    ).resolves.toBeDefined();
    await expect(
      condense(intent, signal, ctx, rejectingLlm),
    ).resolves.toBeDefined();
  });
});

// ─── 3. DispatchKernel 段：含环 intent dispatchSafe 降级不抛 ───

describe("fail-open · DispatchKernel 含环降级 (Req 4.5, 12.1, 12.4)", () => {
  it("含环 intent：dispatchSafe 不抛，降级为全部串行单波（每波 1 条 line）", () => {
    const cyclic = makeCyclicIntent();
    expect(() => dispatchSafe(cyclic)).not.toThrow();

    const plan = dispatchSafe(cyclic);
    // 降级：每个 subgoal 自成一波（串行），每波恰 1 条 line。
    expect(plan.waves.length).toBe(cyclic.subgoals.length);
    for (const wave of plan.waves) {
      expect(wave.lines.length).toBe(1);
    }
    // 覆盖且不重复：flatten 后 subgoalId 与入参 subgoals 双射。
    const flatIds = plan.waves.flatMap((w) => w.lines.map((l) => l.subgoalId));
    expect(flatIds.sort()).toEqual(cyclic.subgoals.map((s) => s.id).sort());
  });

  it("∀ 随机含环 intent（N 节点环），dispatchSafe 不抛且降级为串行单波", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        // 构造 N 节点环：sg_i 依赖 sg_{(i+1)%n}，必含环。
        const subgoals: Subgoal[] = Array.from({ length: n }, (_, i) => ({
          id: `c_${i}`,
          goal: `goal_${i}`,
          dependsOn: [`c_${(i + 1) % n}`],
          expectedResult: `r_${i}`,
        }));
        const cyclic: Intent = {
          ...makeCyclicIntent(),
          subgoals,
        };
        // 前置确认确实含环（否则该用例无意义）。
        expect(isValidDag(subgoals)).toBe(false);

        let plan;
        expect(() => {
          plan = dispatchSafe(cyclic);
        }).not.toThrow();
        expect(plan!.waves.length).toBe(n);
        for (const wave of plan!.waves) {
          expect(wave.lines.length).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── 4. 三段联合：任一段注入异常 ⟹ 不冒泡、退回兜底 ──────────

describe("fail-open · 三段联合硬覆盖：任一段注入异常都不冒泡 (Req 4.5, 12.4)", () => {
  it("∀ ctx/signal，plan 段与 output 段同时注入异常都退回兜底且无 reject", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPlanContext(),
        arbNodeSignal(),
        arbOutputContext(),
        async (ctx, signal, outCtx) => {
          // plan 段注入异常 → 退回确定性 Intent（不冒泡）。
          const intent = await planFromContext(ctx, throwingLlm);
          expect(businessFields(intent)).toEqual(
            businessFields(planDeterministic(ctx)),
          );

          // 用该兜底 Intent 喂 output 段，再注入异常 → 退回确定性凝练（不冒泡）。
          const out = await condense(intent, signal, outCtx, throwingLlm);
          const fallback = deterministicCondense(intent, signal);
          const expectedText = Array.from(fallback)
            .slice(0, outCtx.outputCharBudget)
            .join("");
          expect(out.text).toBe(expectedText);
          expect(out.intentId).toBe(intent.id);
        },
      ),
      { numRuns: 150 },
    );
  });
});
