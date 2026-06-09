/**
 * Clarifier 充分性判定核心纯函数 `evaluateReadiness`（任务 7.3，R8 核心）。
 *
 * 严格按 design.md「Clarifier 算法详解 → 就绪判定伪代码」的分支实现：
 *  1. 高风险模糊前提是一阶门槛：当前聚焦阶段存在未消解（status ≠ known）的高风险前提时，
 *     绝不 `sufficient`——未达软上限 → `ask`；`round ≥ maxRounds` → `impasse`（R8.6/8.2/8.12）。
 *  2. 中/低风险模糊项必须被用户接受（resolvedBy 非空）或具备明确默认值（proposedDefault 非空），
 *     否则继续 `ask`（仅剩低风险时附默认值选项 attachDefaults）（R8.7/8.3）。
 *  3. 当前阶段饱和（无模糊前提）→ 过渡到下一个仍 `pending` 的阶段（`advance_phase`）；
 *     `deferred` 阶段天然不在 `pending` 之列，被自然排除。
 *  4. 所有阶段不再有 `pending`（即均饱和或被延后）后，必须能构造出非空 Acceptance_Test，
 *     否则视为意图未澄清（`ask` + reason="intent_not_testable"）（R8.9）。
 *  5. 满足全部门槛 → `sufficient`，产出 Acceptance_Test 交由状态机让用户最终确认（R8.7/8.11）。
 *
 * 本函数为**纯函数**，不读取外部状态、不调用 LLM、不修改入参，便于 property-based testing
 * （对应 Property 6 / 7 / 11，任务 7.4 / 7.5 / 7.6）。
 *
 * design 伪代码引用了 `synthesizeAcceptanceTests(state)` 但未给出实现；此处提供一个
 * 确定性的默认合成器 `defaultSynthesizeAcceptanceTests`，并允许调用方（编排层 7.9，
 * 可注入 LLM 生成的验收测试）以第二参数覆盖，从而保持 `evaluateReadiness(state)` 的
 * 单参调用签名与伪代码一致。
 *
 * _Requirements: 8.6, 8.7, 8.9, 8.12_
 */

import type {
  Acceptance_Test,
  ClarifierState,
  Execution_Precondition,
  Readiness,
} from "./types.js";

/**
 * 确定性的默认验收测试合成器（纯函数）。
 *
 * 从已消解 / 已知且带有具体执行动作（related_action 非空）的执行前提机械地派生出
 * 可事后检验的成功标准，不依赖 LLM。若不存在任何此类前提，则返回空数组，
 * 由 `evaluateReadiness` 据此判定「意图未澄清」（intent_not_testable）。
 *
 * 设计意图：充分性的第二门槛是「能构造出非空 Acceptance_Test」——若整套已澄清的信息中
 * 找不到任何可检验的落地动作，说明任务意图仍不可执行/不可验证，应继续提问。
 */
export function defaultSynthesizeAcceptanceTests(
  state: ClarifierState,
): Acceptance_Test[] {
  return state.preconditions
    .filter(
      (p) =>
        // 已知，或已被用户接受 / 采纳默认值消解
        (p.status === "known" || p.resolvedBy !== undefined) &&
        // 必须有具体的执行动作才能据此派生可检验的成功标准
        typeof p.related_action === "string" &&
        p.related_action.trim().length > 0,
    )
    .map<Acceptance_Test>((p) => ({
      id: `at-${p.id}`,
      description: `验证「${p.related_action}」已按预期完成`,
      checkMethod: `verify:${p.id}`,
    }));
}

/**
 * 充分性判定纯函数：返回当前澄清会话的下一步动作（Readiness）。
 *
 * 不包含「用户最终确认」——那是状态机的状态门（R8.11），不在本纯函数判定范围内。
 *
 * @param state 当前澄清会话状态（不会被修改）。
 * @param synthesizeAcceptanceTests 验收测试合成器；默认确定性合成，编排层可注入
 *   LLM 生成的验收测试以覆盖默认行为。
 */
export function evaluateReadiness(
  state: ClarifierState,
  synthesizeAcceptanceTests: (
    state: ClarifierState,
  ) => Acceptance_Test[] = defaultSynthesizeAcceptanceTests,
): Readiness {
  const focused = state.preconditions.filter(
    (p) => p.phaseId === state.focusedPhaseId,
  );

  // 原则一：高风险模糊前提是一阶门槛（R8.6/8.2）。
  const highRiskAmbiguous: Execution_Precondition[] = focused.filter(
    (p) => p.risk_level === "high" && p.status !== "known",
  );
  if (highRiskAmbiguous.length > 0) {
    // 软上限兜底：达到最大轮次仍有未消解高风险 → 三选一僵局（R8.12）。
    if (state.round >= state.maxRounds) {
      return { kind: "impasse", unresolved: highRiskAmbiguous };
    }
    // 否则继续优先就高风险模糊前提提问。
    return { kind: "ask", focusOn: highRiskAmbiguous };
  }

  // 中/低风险模糊项：必须被用户接受或具备明确默认值（R8.7）。
  const midLowUnresolved: Execution_Precondition[] = focused.filter(
    (p) =>
      p.risk_level !== "high" &&
      p.status !== "known" &&
      p.resolvedBy === undefined &&
      p.proposedDefault === undefined,
  );
  if (midLowUnresolved.length > 0) {
    // 仅剩低/中风险待消解时，提问附「使用默认值并继续」选项（R8.3）。
    return { kind: "ask", focusOn: midLowUnresolved, attachDefaults: true };
  }

  // 当前阶段饱和 → 过渡到下一个仍 pending 的阶段（deferred 阶段天然被排除）。
  const nextPhase = state.phases
    .filter((ph) => ph.status === "pending")
    .sort((a, b) => a.order - b.order)[0];
  if (nextPhase) {
    return { kind: "advance_phase", to: nextPhase.id };
  }

  // 原则二：必须能构造出非空 Acceptance_Test，否则意图未澄清（R8.9）。
  const tests = synthesizeAcceptanceTests(state);
  if (tests.length === 0) {
    return { kind: "ask", focusOn: [], reason: "intent_not_testable" };
  }

  // 满足充分性门槛 → 产出 Task_Frame 的验收测试，交由用户最终确认（原则三，R8.11）。
  return { kind: "sufficient", acceptanceTests: tests };
}
