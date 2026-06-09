// Feature: proactive-awareness-demo, Property 11: 软上限兜底进入三选一僵局。*For any* ClarifierState，当 `round ≥ maxRounds` 且仍存在未消解的高风险模糊前提时，`evaluateReadiness` 返回 `impasse`，其 options 恰为 `[supplement, force_execute, abandon]` 三项，且不再生成新的澄清问题。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluateReadiness } from "../../src/clarifier/readiness.js";
import type {
  ClarifierState,
  Execution_Precondition,
  LogicalPhase,
  PreconditionStatus,
  RiskLevel,
} from "../../src/clarifier/types.js";

/**
 * Property 11: 软上限兜底进入三选一僵局（R8.12）
 *
 * Validates: Requirements 8.12
 *
 * 被测：`src/clarifier/readiness.ts` 的 `evaluateReadiness` 纯函数。
 *
 * 命题：对任意 ClarifierState，**当 `round ≥ maxRounds` 且当前聚焦阶段仍存在未消解的
 * 高风险模糊前提（`risk_level === "high"` 且 `status !== "known"`）时**：
 *   1. `evaluateReadiness` 返回 `kind === "impasse"`（软上限兜底）；
 *   2. 其 `unresolved` **恰为**当前聚焦阶段全部未消解高风险前提（不多不少、保持顺序）；
 *   3. **不再生成新的澄清问题** —— 返回值不是 `ask`，不含任何 `focusOn`/问题载荷。
 *
 * 关于「options 恰为 `[supplement, force_execute, abandon]` 三项」：`evaluateReadiness`
 * 作为纯判定函数只返回 `Readiness`（impasse 分支为 `{ kind, unresolved }`）；三选一的
 * `options` 是其下游 `ImpasseSummary` 的**固定类型元组**（由编排层 7.9 据此 impasse 组装），
 * 因此在本层以「返回 impasse 而非 ask（不再提问）」来落实该不变量，options 元组本身由类型保证。
 *
 * 为使「软上限」这一触发条件本身可证伪，本测试同时验证**边界对照**：相同的高风险模糊
 * 前提下，当 `round < maxRounds` 时返回 `ask`（继续提问）而**非** `impasse`——证明正是
 * `round ≥ maxRounds` 这一软上限触发了僵局。
 */

// ── 基础生成器 ───────────────────────────────────────────────────────────────

const FOCUSED_PHASE_ID = "phase-focused";

/** 唯一性足够好的 id（碰撞无害：仅用于深比较的同引用对象）。 */
const idArb = (prefix: string): fc.Arbitrary<string> =>
  fc.hexaString({ minLength: 1, maxLength: 8 }).map((s) => `${prefix}-${s}`);

/** 非 "known" 的状态 —— 即「模糊」（ambiguous / unknown）。 */
const ambiguousStatusArb: fc.Arbitrary<PreconditionStatus> = fc.constantFrom(
  "ambiguous",
  "unknown",
);
const anyStatusArb: fc.Arbitrary<PreconditionStatus> = fc.constantFrom(
  "known",
  "ambiguous",
  "unknown",
);
const anyRiskArb: fc.Arbitrary<RiskLevel> = fc.constantFrom(
  "low",
  "medium",
  "high",
);

/** 可选消解来源 —— 高风险判定与之无关（实现只看 status），用于扩大输入空间。 */
const resolvedByArb = fc.option(
  fc.constantFrom<"user_input" | "default_accepted">(
    "user_input",
    "default_accepted",
  ),
  { nil: undefined },
);

/** 「触发」前提：聚焦阶段 + 高风险 + 模糊（status !== known）。必然计入 unresolved。 */
const triggerPreconditionArb: fc.Arbitrary<Execution_Precondition> = fc
  .record({
    id: idArb("trig"),
    status: ambiguousStatusArb,
    related_action: fc.string(),
    proposedDefault: fc.option(fc.string(), { nil: undefined }),
    resolvedBy: resolvedByArb,
  })
  .map(({ id, status, related_action, proposedDefault, resolvedBy }) => ({
    id,
    phaseId: FOCUSED_PHASE_ID,
    description: "high-risk ambiguous precondition",
    status,
    risk_level: "high" as RiskLevel,
    related_action,
    ...(proposedDefault !== undefined ? { proposedDefault } : {}),
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
  }));

/**
 * 「其他」前提：任意阶段 / 任意风险 / 任意状态。用于证明 unresolved 的精确性
 * （混入的无关项不得污染结果），也覆盖「其他阶段恰好也有高风险模糊前提」的情形。
 */
const otherPreconditionArb = (
  phaseIds: string[],
): fc.Arbitrary<Execution_Precondition> =>
  fc
    .record({
      id: idArb("other"),
      phaseId: fc.constantFrom(...phaseIds),
      status: anyStatusArb,
      risk_level: anyRiskArb,
      related_action: fc.string(),
      proposedDefault: fc.option(fc.string(), { nil: undefined }),
      resolvedBy: resolvedByArb,
    })
    .map(({ id, phaseId, status, risk_level, related_action, proposedDefault, resolvedBy }) => ({
      id,
      phaseId,
      description: "other precondition",
      status,
      risk_level,
      related_action,
      ...(proposedDefault !== undefined ? { proposedDefault } : {}),
      ...(resolvedBy !== undefined ? { resolvedBy } : {}),
    }));

const phaseArb = (id: string, order: number): LogicalPhase => ({
  id,
  title: `phase ${order}`,
  order,
  status: id === FOCUSED_PHASE_ID ? "focused" : "pending",
});

/**
 * 构造一个「必含至少一个聚焦高风险模糊前提」的 ClarifierState，
 * round / maxRounds 由调用方按 roundArb 决定（≥ 或 <）。
 */
const stateArb = (
  roundChoice: (maxRounds: number) => fc.Arbitrary<number>,
  maxRoundsArb: fc.Arbitrary<number>,
): fc.Arbitrary<ClarifierState> =>
  fc
    .record({
      // 额外（非聚焦）阶段 id，用于其他前提的归属
      extraPhaseIds: fc.uniqueArray(idArb("phase"), { maxLength: 3 }),
      triggers: fc.array(triggerPreconditionArb, { minLength: 1, maxLength: 4 }),
      maxRounds: maxRoundsArb,
    })
    .chain(({ extraPhaseIds, triggers, maxRounds }) => {
      const phaseIds = [FOCUSED_PHASE_ID, ...extraPhaseIds];
      return fc
        .record({
          others: fc.array(otherPreconditionArb(phaseIds), { maxLength: 6 }),
          round: roundChoice(maxRounds),
        })
        .chain(({ others, round }) => {
          const combined = [...triggers, ...others];
          // 打散顺序，确保结果与「输入数组顺序」无关、且参考过滤与实现同序计算
          return fc
            .shuffledSubarray(combined, {
              minLength: combined.length,
              maxLength: combined.length,
            })
            .map((preconditions): ClarifierState => ({
              awarenessItemId: "ai-1",
              phases: phaseIds.map((id, i) => phaseArb(id, i)),
              preconditions: preconditions as Execution_Precondition[],
              focusedPhaseId: FOCUSED_PHASE_ID,
              round,
              maxRounds,
              perRoundQuestionLimit: 3,
              topPhaseConvergenceThreshold: 6,
            }));
        });
    });

/** 独立参考：当前聚焦阶段全部未消解高风险前提（金标准，保持 state.preconditions 顺序）。 */
function refUnresolvedHighRisk(
  state: ClarifierState,
): Execution_Precondition[] {
  return state.preconditions.filter(
    (p) =>
      p.phaseId === state.focusedPhaseId &&
      p.risk_level === "high" &&
      p.status !== "known",
  );
}

// ── 属性测试 ─────────────────────────────────────────────────────────────────

describe("Property 11: 软上限兜底进入三选一僵局", () => {
  it("round ≥ maxRounds 且存在未消解高风险模糊前提 → impasse，unresolved 恰为该集合，且不再提问", () => {
    fc.assert(
      fc.property(
        stateArb(
          // round ∈ [maxRounds, maxRounds + 10]，保证 round ≥ maxRounds
          (maxRounds) =>
            fc.integer({ min: maxRounds, max: maxRounds + 10 }),
          fc.integer({ min: 0, max: 8 }),
        ),
        (state) => {
          const result = evaluateReadiness(state);

          // (1) 软上限兜底 → impasse
          expect(result.kind).toBe("impasse");

          // (3) 不再生成新的澄清问题：绝不是 ask（impasse 分支本身不含问题载荷）
          expect(result.kind).not.toBe("ask");

          if (result.kind === "impasse") {
            // (2) unresolved 恰为当前聚焦阶段全部未消解高风险前提（不多不少、同序）
            expect(result.unresolved).toEqual(refUnresolvedHighRisk(state));
            // 非空（命题前提：仍存在未消解高风险）
            expect(result.unresolved.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("边界对照：相同高风险模糊前提下，round < maxRounds → ask（继续提问）而非 impasse", () => {
    fc.assert(
      fc.property(
        stateArb(
          // round ∈ [0, maxRounds - 1]，保证 round < maxRounds（要求 maxRounds ≥ 1）
          (maxRounds) => fc.integer({ min: 0, max: maxRounds - 1 }),
          fc.integer({ min: 1, max: 8 }),
        ),
        (state) => {
          const result = evaluateReadiness(state);

          // 未达软上限：优先就高风险模糊前提继续提问，绝不进入僵局
          expect(result.kind).toBe("ask");
          expect(result.kind).not.toBe("impasse");

          if (result.kind === "ask") {
            // 提问聚焦的正是当前聚焦阶段的未消解高风险前提
            expect(result.focusOn).toEqual(refUnresolvedHighRisk(state));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
