// Feature: proactive-awareness-demo, Property 7: 充分性判定的充要条件 —— *For any* ClarifierState，`evaluateReadiness` 返回 `sufficient` 当且仅当：(a) 不存在未消解的高风险模糊前提，(b) 所有中/低风险的模糊前提均已被用户接受（resolvedBy 非空）或具有明确默认值（proposedDefault 非空），(c) 所有逻辑阶段均已饱和或被延后，且 (d) 能构造出非空的 Acceptance_Test 集合。
//
// **Validates: Requirements 8.7, 8.9**
//
// 被测纯判定单元：`evaluateReadiness`（任务 7.3，R8 核心）。本测试用"按构造已知答案"策略：
// 每个 case 由其构造语义直接给出期望值（expected），不复用被测逻辑做 oracle，避免同义反复。
// 通过五类场景覆盖充要条件的两个方向：
//   - SUFFICIENT：四条件 (a)(b)(c)(d) 同时成立 → 必返回 sufficient（验证"四条件合取 ⟹ sufficient"）。
//   - N1：违反 (a) —— 焦点阶段存在未消解高风险模糊前提 → ask/impasse（高风险是一阶门槛）。
//   - N2：违反 (b) —— 焦点阶段存在既未被接受、也无默认值的中/低风险模糊前提 → ask。
//   - N3：违反 (c) —— 仍存在 pending 阶段 → advance_phase。
//   - N4：违反 (d) —— 无任何可派生验收测试的前提 → ask(intent_not_testable)。
// N1–N4 各自仅破坏一个条件（其余三条件保持成立），从而验证"sufficient ⟹ 每个条件均必要"。

import { describe, it } from "vitest";
import fc from "fast-check";

import { evaluateReadiness } from "../../src/clarifier/readiness.js";
import type {
  ClarifierState,
  Execution_Precondition,
  PreconditionStatus,
  RiskLevel,
} from "../../src/clarifier/types.js";

// ---- 字段级生成器 -----------------------------------------------------------

/** 非空、trim 后非空的执行动作描述（保证可派生验收测试时 related_action 有效）。 */
const actionArb = fc.constantFrom(
  "修改 src/app.ts",
  "创建 config.json",
  "运行 npm test",
  "重命名导出符号",
  "新增一个工具实现",
);

const descArb = fc.constantFrom(
  "操作对象的具体路径",
  "重构后对外接口是否兼容",
  "成功标准",
  "失败处理方式",
);

/** 模糊状态：ambiguous / unknown（即 status !== "known"）。 */
const ambiguousStatus: fc.Arbitrary<PreconditionStatus> = fc.constantFrom(
  "ambiguous",
  "unknown",
);

/** 任意风险等级（用于"已知"前提，已知则不论风险都不阻塞）。 */
const anyRisk: fc.Arbitrary<RiskLevel> = fc.constantFrom("low", "medium", "high");

/** 中/低风险（非 high）。 */
const lowMidRisk: fc.Arbitrary<RiskLevel> = fc.constantFrom("low", "medium");

const valArb = fc.constantFrom("默认值-A", "/tmp/target", "保持兼容", "yes");

// ---- 前提（precondition）基底生成器（不含 id / phaseId，由 buildState 注入）----

type PCBase = Omit<Execution_Precondition, "id" | "phaseId">;

/**
 * 「已知 + 有动作」前提：status="known"（任意风险），related_action 非空。
 * 既不阻塞 (a)/(b)，又满足验收测试派生条件（status==="known" 且 related_action 非空）。
 */
const knownActionBase: fc.Arbitrary<PCBase> = fc.record({
  description: descArb,
  status: fc.constant<PreconditionStatus>("known"),
  risk_level: anyRisk,
  related_action: actionArb,
});

/**
 * 「中/低风险经用户输入消解」前提：status 模糊但 resolvedBy="user_input"。
 * 满足 (b)（resolvedBy 非空），且满足验收测试派生条件（resolvedBy 非空 + related_action 非空）。
 */
const midLowResolvedInputBase: fc.Arbitrary<PCBase> = fc.record({
  description: descArb,
  status: ambiguousStatus,
  risk_level: lowMidRisk,
  related_action: actionArb,
  resolvedBy: fc.constant<"user_input">("user_input"),
  resolvedValue: valArb,
});

/**
 * 「中/低风险有明确默认值」前提：status 模糊、proposedDefault 非空、resolvedBy 缺省。
 * 满足 (b)（proposedDefault 非空），但**不**满足验收测试派生条件（status 非 known 且 resolvedBy 缺省）。
 */
const midLowDefaultBase: fc.Arbitrary<PCBase> = fc.record({
  description: descArb,
  status: ambiguousStatus,
  risk_level: lowMidRisk,
  related_action: actionArb,
  proposedDefault: valArb,
});

/** 「未消解高风险模糊」前提：违反 (a)。 */
const highAmbiguousBase: fc.Arbitrary<PCBase> = fc.record({
  description: descArb,
  status: ambiguousStatus,
  risk_level: fc.constant<RiskLevel>("high"),
  related_action: actionArb,
});

/** 「未消解中/低风险模糊」前提（无接受、无默认值）：违反 (b)。 */
const midLowUnresolvedBase: fc.Arbitrary<PCBase> = fc.record({
  description: descArb,
  status: ambiguousStatus,
  risk_level: lowMidRisk,
  related_action: actionArb,
});

/** 非阻塞前提池（满足 (a)+(b)）：已知有动作 / 用户消解 / 有默认值。 */
const nonBlockingBase = fc.oneof(
  knownActionBase,
  midLowResolvedInputBase,
  midLowDefaultBase,
);

// ---- 状态组装 ---------------------------------------------------------------

const FOCUSED_ID = "P0";
const roundArb = fc.nat({ max: 20 });
const maxRoundsArb = fc.integer({ min: 1, max: 10 });

/** 额外（非焦点）阶段的状态：非 pending（已饱和 / 被延后），满足 (c)。 */
const nonPendingStatus: fc.Arbitrary<"saturated" | "deferred"> = fc.constantFrom(
  "saturated",
  "deferred",
);

/**
 * 把前提基底与额外阶段状态组装成一个合法 ClarifierState。
 * - 所有前提归属焦点阶段 P0（使全局判定与实现的"焦点阶段判定"一致）。
 * - 焦点阶段 P0 状态固定为 "saturated"（非 pending），满足 (c)。
 * - extraStatuses 给出额外阶段状态（控制是否存在 pending 阶段）。
 */
function buildState(
  pcBases: PCBase[],
  extraStatuses: ("pending" | "saturated" | "deferred")[],
  round: number,
  maxRounds: number,
): ClarifierState {
  const preconditions: Execution_Precondition[] = pcBases.map((b, i) => ({
    id: `pc-${i}`,
    phaseId: FOCUSED_ID,
    ...b,
  }));
  return {
    awarenessItemId: "aw-1",
    phases: [
      { id: FOCUSED_ID, title: "焦点阶段", order: 0, status: "saturated" },
      ...extraStatuses.map((s, i) => ({
        id: `P${i + 1}`,
        title: `阶段${i + 1}`,
        order: i + 1,
        status: s,
      })),
    ],
    preconditions,
    focusedPhaseId: FOCUSED_ID,
    round,
    maxRounds,
    perRoundQuestionLimit: 3,
    topPhaseConvergenceThreshold: 6,
  };
}

type Scenario = { state: ClarifierState; expected: boolean };

/** SUFFICIENT：(a)(b)(c)(d) 全成立 —— 至少 1 个可派生验收测试的"已知有动作"前提，无阻塞、无 pending。 */
const sufficientScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    knownActionBase, // 保证 (d)：至少一条可派生验收测试
    fc.array(nonBlockingBase, { maxLength: 3 }),
    fc.array(nonPendingStatus, { maxLength: 2 }),
    roundArb,
    maxRoundsArb,
  )
  .map(([anchor, rest, extras, round, maxRounds]) => ({
    state: buildState([anchor, ...rest], extras, round, maxRounds),
    expected: true,
  }));

/** N1：违反 (a) —— 焦点阶段含未消解高风险模糊前提（其余三条件仍成立）。 */
const violateAScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    knownActionBase, // (d) 仍可满足
    fc.array(nonBlockingBase, { maxLength: 2 }),
    fc.array(highAmbiguousBase, { minLength: 1, maxLength: 2 }),
    fc.array(nonPendingStatus, { maxLength: 2 }),
    roundArb,
    maxRoundsArb,
  )
  .map(([anchor, nonBlocking, highs, extras, round, maxRounds]) => ({
    state: buildState([anchor, ...nonBlocking, ...highs], extras, round, maxRounds),
    expected: false,
  }));

/** N2：违反 (b) —— 焦点阶段含未消解中/低风险模糊前提，且无高风险模糊（其余条件成立）。 */
const violateBScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    knownActionBase, // (d) 仍可满足
    fc.array(nonBlockingBase, { maxLength: 2 }),
    fc.array(midLowUnresolvedBase, { minLength: 1, maxLength: 2 }),
    fc.array(nonPendingStatus, { maxLength: 2 }),
    roundArb,
    maxRoundsArb,
  )
  .map(([anchor, nonBlocking, unresolved, extras, round, maxRounds]) => ({
    state: buildState(
      [anchor, ...nonBlocking, ...unresolved],
      extras,
      round,
      maxRounds,
    ),
    expected: false,
  }));

/** N3：违反 (c) —— 存在至少一个 pending 阶段（其余条件成立、无阻塞前提）。 */
const violateCScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    knownActionBase, // (a)(b)(d) 成立
    fc.array(nonBlockingBase, { maxLength: 3 }),
    fc.array(nonPendingStatus, { maxLength: 2 }),
    roundArb,
    maxRoundsArb,
  )
  .map(([anchor, rest, extras, round, maxRounds]) => ({
    // 在额外阶段中强制插入一个 pending 阶段
    state: buildState([anchor, ...rest], ["pending", ...extras], round, maxRounds),
    expected: false,
  }));

/** N4：违反 (d) —— 仅含"有默认值"前提（满足 (a)(b)(c)），但无任何可派生验收测试的前提。 */
const violateDScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.array(midLowDefaultBase, { minLength: 1, maxLength: 4 }),
    fc.array(nonPendingStatus, { maxLength: 2 }),
    roundArb,
    maxRoundsArb,
  )
  .map(([defaults, extras, round, maxRounds]) => ({
    state: buildState(defaults, extras, round, maxRounds),
    expected: false,
  }));

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  sufficientScenario,
  violateAScenario,
  violateBScenario,
  violateCScenario,
  violateDScenario,
);

describe("Property 7: 充分性判定的充要条件", () => {
  it("evaluateReadiness 返回 sufficient 当且仅当 (a)(b)(c)(d) 同时成立", () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, expected }) => {
        const isSufficient = evaluateReadiness(state).kind === "sufficient";
        return isSufficient === expected;
      }),
      { numRuns: 100 },
    );
  });
});
