/**
 * 持续执行内核 · Component 4：StrategyKernel 策略层
 * ------------------------------------------------------------------
 * 维护一个比"下一步"更高层、可被自己改写的中期计划；在现实背离计划时只发一个信号
 * （不替决策者强制规定怎么改）。
 *
 * 联动（不做孤岛）：
 *  - 中期计划承载于认知核（cognitive-core）的 Intent，改计划 = 改 Intent.subgoals（复用，不重造）。
 *  - 局势判断只读引用河床（riverbed）域态势（经 barrel 注入），遵守 no-engine-trigger-guard：
 *    河床只给判断，执行由本内核发起。
 *  - 领域合法性校验支持注入既有校验器（如 chess.js），不重造领域规则。
 *
 * fail-open：异常退回"无中期计划、按既有单步决策"的原行为。
 * _Requirements: 4.1-4.8, 6.2, 6.3_
 */

import { newIntentId, type Intent, type Subgoal } from "../cognitive-core/index.js";
import {
  type ActionOutcome,
  type RiverbedJudgmentReadLike,
  type LegalityValidator,
} from "./types.js";

/** 中期计划 = 认知核 Intent 承载 + 一句理由。复用 cognitive-core，不重造规划引擎。 */
export interface MovePlan {
  intent: Intent;
  rationale: string;
}

/**
 * 构建中期计划：把目标拆成有序子目标，承载于 Intent。
 * 若提供河床判断，则把"最显著域"作为优先子目标的依据（只读引用，不改河床）。
 * 任何异常 → 返回一个最小可用的单子目标计划（fail-open，不抛）。
 */
export function buildMidPlan(params: { goal: string; judgment?: RiverbedJudgmentReadLike }): MovePlan {
  const goal = (params.goal ?? "").trim() || "(未命名目标)";
  try {
    const subgoals: Subgoal[] = [];
    const top = params.judgment?.topDomains ?? [];
    if (top.length > 0) {
      const ranked = [...top].sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0)).slice(0, 3);
      ranked.forEach((d, i) => {
        subgoals.push({
          id: `sg_${i}`,
          goal: `针对「${d.domain}」域推进：${goal}`,
          dependsOn: i === 0 ? [] : [`sg_${i - 1}`],
          expectedResult: `「${d.domain}」域取得可验证推进`,
        });
      });
    }
    if (subgoals.length === 0) {
      subgoals.push({ id: "sg_0", goal, dependsOn: [], expectedResult: `「${goal}」取得可验证推进` });
    }
    const intent: Intent = {
      id: newIntentId(),
      sourceUtterance: null,
      goal,
      subgoals,
      expectedResult: `「${goal}」整体达成`,
      acceptanceLine: "整件事客观完成、可独立验证",
      status: "planned",
      createdAt: new Date().toISOString(),
      mode: "enforce",
    };
    const rationale = params.judgment?.summary
      ? `据河床判断「${params.judgment.summary.slice(0, 80)}」分解中期计划`
      : "无外部判断，按目标线性分解";
    return { intent, rationale };
  } catch {
    // fail-open：最小单子目标计划。
    const intent: Intent = {
      id: newIntentId(),
      sourceUtterance: null,
      goal,
      subgoals: [{ id: "sg_0", goal, dependsOn: [], expectedResult: `「${goal}」推进` }],
      expectedResult: `「${goal}」达成`,
      acceptanceLine: "客观完成",
      status: "planned",
      createdAt: new Date().toISOString(),
      mode: "enforce",
    };
    return { intent, rationale: "fail-open: 退回最小计划" };
  }
}

/**
 * 计划背离检测：连续 driftWindow 步的 outcome 都不是预期（expected，通常 "achieved"）
 * 则判定背离。只返回信号，无副作用、不修改计划。
 */
export function detectPlanDrift(
  recentOutcomes: ReadonlyArray<ActionOutcome>,
  expected: ActionOutcome,
  driftWindow: number,
): { drift: boolean; reason: string } {
  const w = Math.max(1, Math.floor(driftWindow));
  if (recentOutcomes.length < w) {
    return { drift: false, reason: `not enough steps (${recentOutcomes.length}/${w})` };
  }
  const tail = recentOutcomes.slice(-w);
  const allDeviate = tail.every((o) => o !== expected);
  if (allDeviate) {
    return { drift: true, reason: `last ${w} steps all deviated from expected "${expected}": [${tail.join(", ")}]` };
  }
  return { drift: false, reason: "within plan" };
}

/**
 * 领域合法性校验钩子：存在校验器则用（如 chess.js），不重造规则。
 * 无校验器 → 默认放行（legal=true），并标注未校验（fail-open，不阻断）。
 */
export function validateCandidate(
  candidate: string,
  context: unknown,
  validator?: LegalityValidator,
): { legal: boolean; reason: string } {
  if (!validator) return { legal: true, reason: "no validator injected; not checked" };
  try {
    const ok = validator.isLegal(candidate, context);
    return { legal: ok, reason: ok ? "validated legal" : "validator rejected" };
  } catch (e) {
    return { legal: true, reason: `validator error, fail-open allow: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 类封装。 */
export class StrategyKernel {
  buildMidPlan(params: { goal: string; judgment?: RiverbedJudgmentReadLike }): MovePlan {
    return buildMidPlan(params);
  }
  detectPlanDrift(recentOutcomes: ReadonlyArray<ActionOutcome>, expected: ActionOutcome, driftWindow: number) {
    return detectPlanDrift(recentOutcomes, expected, driftWindow);
  }
  validateCandidate(candidate: string, context: unknown, validator?: LegalityValidator) {
    return validateCandidate(candidate, context, validator);
  }
}
