/**
 * 认知核三段脊柱 · 规划核测试（plan-kernel.ts · planFromContext / planDeterministic）
 * ------------------------------------------------------------------
 * 任务 3.2（属性测试）：
 *  - Property 1: 规划核 fail-open — ∀ ctx，refinePlan 必抛错的 llm 下，
 *    planFromContext(ctx, throwingLlm) 解析出的业务字段（goal/subgoals/
 *    status/mode/expectedResult/acceptanceLine）与 planDeterministic(ctx)
 *    深度相等（忽略 id/createdAt），且 promise 永不 reject。
 *  - Property 2: Intent DAG 不变量 — ∀ ctx，isValidDag(planDeterministic(ctx).subgoals)===true。
 *  **Validates: Requirements 4.1, 1.1**
 *
 * 任务 3.3（单元测试）：
 *  - planFromContext 在 LLM 增强结果含环时退回兜底（确定性骨架）。
 *  - dry-run 下 Intent.status 不越过 "planned"、Intent.mode === "dry-run"。
 *  - 每个 subgoal 含非空 expectedResult、整体含非空 acceptanceLine。
 *  - llm 增强成功（返回合法 DAG）时采用增强结果且 status 被重置为 "planned"。
 *  _Requirements: 1.2, 1.4, 1.5, 12.2, 10.3_
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ../plan-kernel.js、../types.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { planFromContext, planDeterministic } from "../plan-kernel.js";
import {
  isValidDag,
  type Intent,
  type LlmLike,
  type NodeSignal,
  type OutputContext,
  type PlanContext,
  type Subgoal,
} from "../types.js";

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

/** refinePlan 必抛错的 llm（condenseOutput 不参与本测试，给安全兜底实现）。 */
const throwingLlm: LlmLike = {
  refinePlan(): Promise<Intent> {
    throw new Error("refinePlan boom");
  },
  condenseOutput(
    _intent: Intent,
    _signal: NodeSignal,
    _ctx: OutputContext,
  ): Promise<string> {
    return Promise.resolve("");
  },
};

/** 提取 Intent 的业务字段（忽略 id / createdAt）用于深等断言。 */
function businessFields(intent: Intent): Omit<Intent, "id" | "createdAt"> {
  const { id: _id, createdAt: _createdAt, ...rest } = intent;
  return rest;
}

// ─── 任务 3.2 · Property 1 规划核 fail-open ───────────────────

describe("planFromContext · Property 1 规划核 fail-open (Req 4.1)", () => {
  it("∀ ctx，refinePlan 抛错时结果业务字段 === planDeterministic 且 promise 不 reject", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlanContext(), async (ctx) => {
        const result = await planFromContext(ctx, throwingLlm);
        const base = planDeterministic(ctx);
        expect(businessFields(result)).toEqual(businessFields(base));
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 3.2 · Property 2 Intent DAG 不变量 ──────────────────

describe("planDeterministic · Property 2 Intent DAG 不变量 (Req 1.1)", () => {
  it("∀ ctx，isValidDag(planDeterministic(ctx).subgoals) === true", () => {
    fc.assert(
      fc.property(arbPlanContext(), (ctx) => {
        expect(isValidDag(planDeterministic(ctx).subgoals)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("∀ ctx，subgoals 至少含 1 个", () => {
    fc.assert(
      fc.property(arbPlanContext(), (ctx) => {
        expect(planDeterministic(ctx).subgoals.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── 任务 3.3 · 单元测试 ──────────────────────────────────────

/** 基础 ctx 工具。 */
function baseCtx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    userUtterance: "帮我把周报整理好",
    recentConversation: [],
    mode: "enforce",
    ...overrides,
  };
}

/** 构造一个返回带环 subgoals 的 llm。 */
function cyclicLlm(): LlmLike {
  const cyclicSubgoals: Subgoal[] = [
    { id: "x", goal: "gx", dependsOn: ["y"], expectedResult: "rx" },
    { id: "y", goal: "gy", dependsOn: ["x"], expectedResult: "ry" },
  ];
  return {
    refinePlan(base: Intent): Promise<Intent> {
      return Promise.resolve({ ...base, subgoals: cyclicSubgoals });
    },
    condenseOutput(): Promise<string> {
      return Promise.resolve("");
    },
  };
}

/** 构造一个返回合法 DAG 且 status 已被推进的 llm。 */
function enrichingLlm(): LlmLike {
  const goodSubgoals: Subgoal[] = [
    { id: "a", goal: "增强目标 A", dependsOn: [], expectedResult: "结果 A" },
    { id: "b", goal: "增强目标 B", dependsOn: ["a"], expectedResult: "结果 B" },
  ];
  return {
    refinePlan(base: Intent): Promise<Intent> {
      return Promise.resolve({
        ...base,
        goal: "增强后的目标",
        subgoals: goodSubgoals,
        status: "executing",
      });
    },
    condenseOutput(): Promise<string> {
      return Promise.resolve("");
    },
  };
}

describe("planFromContext · 单元测试 (Req 1.2, 1.4, 1.5, 12.2, 10.3)", () => {
  it("LLM 增强结果含环时退回确定性兜底骨架", async () => {
    const ctx = baseCtx();
    const result = await planFromContext(ctx, cyclicLlm());
    const base = planDeterministic(ctx);

    // 退回兜底：业务字段与确定性骨架一致，subgoals 仍是合法 DAG。
    expect(businessFields(result)).toEqual(businessFields(base));
    expect(isValidDag(result.subgoals)).toBe(true);
  });

  it("dry-run 下 Intent.status 停在 planned、mode === dry-run", async () => {
    const ctx = baseCtx({ mode: "dry-run" });

    const det = planDeterministic(ctx);
    expect(det.status).toBe("planned");
    expect(det.mode).toBe("dry-run");

    const result = await planFromContext(ctx, throwingLlm);
    expect(result.status).toBe("planned");
    expect(result.mode).toBe("dry-run");
  });

  it("每个 subgoal 含非空 expectedResult、整体含非空 acceptanceLine", () => {
    const intent = planDeterministic(baseCtx());

    expect(intent.acceptanceLine.trim().length).toBeGreaterThan(0);
    expect(intent.expectedResult.trim().length).toBeGreaterThan(0);
    for (const sg of intent.subgoals) {
      expect(sg.expectedResult.trim().length).toBeGreaterThan(0);
    }
  });

  it("LLM 增强成功（合法 DAG）时采用增强结果且 status 重置为 planned", async () => {
    const ctx = baseCtx();
    const result = await planFromContext(ctx, enrichingLlm());

    // 采用增强结果：goal/subgoals 来自 llm，而非确定性骨架。
    expect(result.goal).toBe("增强后的目标");
    expect(result.subgoals.map((sg) => sg.id)).toEqual(["a", "b"]);
    // status 被重置为 planned（即便 llm 返回了 executing）。
    expect(result.status).toBe("planned");
    expect(isValidDag(result.subgoals)).toBe(true);
  });

  it("无 llm 时直接返回确定性兜底（业务字段一致）", async () => {
    const ctx = baseCtx();
    const result = await planFromContext(ctx);
    const base = planDeterministic(ctx);
    expect(businessFields(result)).toEqual(businessFields(base));
  });
});
