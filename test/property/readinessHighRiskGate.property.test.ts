// Feature: proactive-awareness-demo, Property 6: 高风险模糊前提是充分性的一阶门槛。For any ClarifierState，只要当前聚焦阶段存在未消解（status ≠ known）的高风险 Execution_Precondition，evaluateReadiness 绝不返回 sufficient（只能返回 ask 或在达到最大轮次时返回 impasse），即此时 Clarifier 继续提问且不声明信息充分。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluateReadiness } from "../../src/clarifier/readiness.js";
import { injectRiskAll, isRuleForcedHighRisk } from "../../src/clarifier/riskInjection.js";
import type {
  ClarifierState,
  Execution_Precondition,
  LogicalPhase,
  PreconditionStatus,
  RiskLevel,
} from "../../src/clarifier/types.js";

/**
 * Property 6: 高风险模糊前提是充分性的一阶门槛
 *
 * Validates: Requirements 8.6, 8.2
 *
 * 不变量：当前聚焦阶段只要存在「未消解（status ≠ "known"）的高风险」执行前提，
 * `evaluateReadiness` 绝不返回 `sufficient`：
 *   - `round < maxRounds`  → 必为 `ask`（继续就高风险模糊前提提问，focusOn 恰为这些前提）；
 *   - `round >= maxRounds` → 必为 `impasse`（软上限兜底，unresolved 恰为这些前提）。
 *
 * 同时验证「规则强制高危优先于 LLM」(R8.2)：即便 LLM 把某个删除/权限/sudo/不可逆/
 * force push 动作误判为 low/medium，经 `injectRiskAll` 规则注入升级为 high 后，
 * 一阶门槛照样生效——`evaluateReadiness` 仍绝不 `sufficient`。
 */

const FOCUSED = "phase-focused";

// ── 基础生成器 ──────────────────────────────────────────────────────────────

const idArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 1, maxLength: 6 })
  .map((s) => "pc-" + s);

const phaseIdArb = fc.constantFrom(FOCUSED, "phase-b", "phase-c");
const statusArb = fc.constantFrom<PreconditionStatus>("known", "ambiguous", "unknown");
const unresolvedStatusArb = fc.constantFrom<PreconditionStatus>("ambiguous", "unknown");
const lowMidRiskArb = fc.constantFrom<RiskLevel>("low", "medium");
const anyRiskArb = fc.constantFrom<RiskLevel>("low", "medium", "high");

/** 中性动作描述：保证**绝不**命中风险注入的规则强制高危模式（无删除/权限/sudo 等关键词）。 */
const neutralActionArb = fc.constantFrom(
  "读取配置文件",
  "展示分析结果",
  "整理任务列表",
  "生成报告草稿",
  "list files in folder",
  "summarize the content",
);

/** 规则强制高危动作：每条都必然命中 `isRuleForcedHighRisk`（删除/权限/sudo/不可逆/force push）。 */
const ruleForcedActionArb = fc.constantFrom(
  "rm -rf ./build",
  "删除临时文件目录",
  "sudo apt-get install nginx",
  "chmod +x deploy.sh",
  "chown root:root /etc/app",
  "git push --force origin main",
  "强制推送到远程仓库",
  "执行不可逆的数据库迁移",
  "mkfs.ext4 /dev/sdb",
  "delete the old user records",
);

const optionalDefaultArb = fc.option(fc.string(), { nil: undefined });
const optionalResolvedByArb = fc.option(
  fc.constantFrom("user_input" as const, "default_accepted" as const),
  { nil: undefined },
);

/** 直接 risk_level="high" 且未消解、落在聚焦阶段的执行前提。 */
const highRiskUnresolvedArb: fc.Arbitrary<Execution_Precondition> = fc.record({
  id: idArb,
  phaseId: fc.constant(FOCUSED),
  description: fc.string(),
  status: unresolvedStatusArb,
  risk_level: fc.constant<RiskLevel>("high"),
  related_action: neutralActionArb,
  proposedDefault: optionalDefaultArb,
  resolvedBy: optionalResolvedByArb,
});

/** 任意填充前提（任意阶段/风险/状态，但动作中性，不会被规则注入升级）。 */
const fillerArb: fc.Arbitrary<Execution_Precondition> = fc.record({
  id: idArb,
  phaseId: phaseIdArb,
  description: fc.string(),
  status: statusArb,
  risk_level: anyRiskArb,
  related_action: neutralActionArb,
  proposedDefault: optionalDefaultArb,
  resolvedBy: optionalResolvedByArb,
});

/** LLM 低估：动作命中规则强制高危，但 LLM 仅给 low/medium、且未消解、落在聚焦阶段。 */
const llmUnderRatedHighArb: fc.Arbitrary<Execution_Precondition> = fc.record({
  id: idArb,
  phaseId: fc.constant(FOCUSED),
  description: fc.string(),
  status: unresolvedStatusArb,
  risk_level: lowMidRiskArb,
  related_action: ruleForcedActionArb,
  proposedDefault: optionalDefaultArb,
  resolvedBy: optionalResolvedByArb,
});

/** 安全填充：风险只可能是 low/medium 且动作中性，注入后绝不变 high。 */
const safeFillerArb: fc.Arbitrary<Execution_Precondition> = fc.record({
  id: idArb,
  phaseId: phaseIdArb,
  description: fc.string(),
  status: statusArb,
  risk_level: lowMidRiskArb,
  related_action: neutralActionArb,
  proposedDefault: optionalDefaultArb,
  resolvedBy: optionalResolvedByArb,
});

const PHASES: LogicalPhase[] = [
  { id: FOCUSED, title: "聚焦阶段", order: 0, status: "focused" },
  { id: "phase-b", title: "后续阶段 B", order: 1, status: "pending" },
  { id: "phase-c", title: "后续阶段 C", order: 2, status: "pending" },
];

/** 等长随机打散（保留全部元素，仅交错顺序）。 */
const shuffle = <T>(arr: T[]): fc.Arbitrary<T[]> =>
  arr.length <= 1
    ? fc.constant(arr)
    : (fc.shuffledSubarray(arr, {
        minLength: arr.length,
        maxLength: arr.length,
      }) as fc.Arbitrary<T[]>);

/** 组装一个含至少一个聚焦高风险未消解前提的 ClarifierState。 */
const stateArb: fc.Arbitrary<ClarifierState> = fc
  .record({
    high: fc.array(highRiskUnresolvedArb, { minLength: 1, maxLength: 3 }),
    fillers: fc.array(fillerArb, { maxLength: 8 }),
    round: fc.nat({ max: 15 }),
    maxRounds: fc.integer({ min: 1, max: 15 }),
    perRoundQuestionLimit: fc.integer({ min: 1, max: 5 }),
    topPhaseConvergenceThreshold: fc.integer({ min: 1, max: 10 }),
  })
  .chain(({ high, fillers, round, maxRounds, perRoundQuestionLimit, topPhaseConvergenceThreshold }) =>
    shuffle([...high, ...fillers]).map((preconditions) => ({
      awarenessItemId: "ai-1",
      phases: PHASES,
      preconditions,
      focusedPhaseId: FOCUSED,
      round,
      maxRounds,
      perRoundQuestionLimit,
      topPhaseConvergenceThreshold,
    })),
  );

/** 组装一个「LLM 低估 + 安全填充」的 ClarifierState（注入前聚焦阶段无 high 未消解）。 */
const underRatedStateArb: fc.Arbitrary<ClarifierState> = fc
  .record({
    underRated: fc.array(llmUnderRatedHighArb, { minLength: 1, maxLength: 3 }),
    fillers: fc.array(safeFillerArb, { maxLength: 8 }),
    round: fc.nat({ max: 15 }),
    maxRounds: fc.integer({ min: 1, max: 15 }),
    perRoundQuestionLimit: fc.integer({ min: 1, max: 5 }),
    topPhaseConvergenceThreshold: fc.integer({ min: 1, max: 10 }),
  })
  .chain(({ underRated, fillers, round, maxRounds, perRoundQuestionLimit, topPhaseConvergenceThreshold }) =>
    shuffle([...underRated, ...fillers]).map((preconditions) => ({
      awarenessItemId: "ai-1",
      phases: PHASES,
      preconditions,
      focusedPhaseId: FOCUSED,
      round,
      maxRounds,
      perRoundQuestionLimit,
      topPhaseConvergenceThreshold,
    })),
  );

// ── 独立参考：聚焦阶段中「未消解的高风险」前提集合 ──────────────────────────────
function focusedHighRiskUnresolved(state: ClarifierState): Execution_Precondition[] {
  return state.preconditions.filter(
    (p) =>
      p.phaseId === state.focusedPhaseId &&
      p.risk_level === "high" &&
      p.status !== "known",
  );
}
const sortedIds = (ps: Execution_Precondition[]): string[] => ps.map((p) => p.id).sort();

describe("Property 6: 高风险模糊前提是充分性的一阶门槛", () => {
  it("聚焦阶段存在未消解高风险前提 → 绝不 sufficient，按轮次落在 ask / impasse", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const expected = focusedHighRiskUnresolved(state);
        // 生成器保证：至少存在一个聚焦高风险未消解前提
        expect(expected.length).toBeGreaterThan(0);

        const result = evaluateReadiness(state);

        // 一阶门槛：绝不声明信息充分
        expect(result.kind).not.toBe("sufficient");

        if (state.round >= state.maxRounds) {
          // 软上限兜底 → 三选一僵局，unresolved 恰为这些高风险前提
          expect(result.kind).toBe("impasse");
          if (result.kind === "impasse") {
            expect(sortedIds(result.unresolved)).toEqual(sortedIds(expected));
          }
        } else {
          // 否则继续优先就高风险模糊前提提问，focusOn 恰为这些前提
          expect(result.kind).toBe("ask");
          if (result.kind === "ask") {
            expect(sortedIds(result.focusOn)).toEqual(sortedIds(expected));
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("规则强制高危优先于 LLM：LLM 低估的高危动作经规则注入后照样触发一阶门槛", () => {
    fc.assert(
      fc.property(underRatedStateArb, (state) => {
        // 注入前：聚焦阶段不存在 risk_level==="high" 的未消解前提（LLM 全判 low/medium）
        expect(focusedHighRiskUnresolved(state).length).toBe(0);

        // 规则注入：删除/权限/sudo/不可逆/force push 一律升级为 high（规则优先于 LLM）
        const injected: ClarifierState = {
          ...state,
          preconditions: injectRiskAll(state.preconditions),
        };

        const expected = focusedHighRiskUnresolved(injected);
        // 注入后必然出现聚焦高风险未消解前提（验证 isRuleForcedHighRisk 实际生效）
        expect(expected.length).toBeGreaterThan(0);
        for (const p of expected) {
          expect(isRuleForcedHighRisk(p.related_action)).toBe(true);
        }

        const result = evaluateReadiness(injected);
        expect(result.kind).not.toBe("sufficient");

        if (injected.round >= injected.maxRounds) {
          expect(result.kind).toBe("impasse");
          if (result.kind === "impasse") {
            expect(sortedIds(result.unresolved)).toEqual(sortedIds(expected));
          }
        } else {
          expect(result.kind).toBe("ask");
          if (result.kind === "ask") {
            expect(sortedIds(result.focusOn)).toEqual(sortedIds(expected));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
