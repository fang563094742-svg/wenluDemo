/**
 * 认知核三段脊柱 · 规划核（Component 1：plan-kernel.ts）
 * ------------------------------------------------------------------
 * 在 LLM 真正动手前，把当前上下文凝成结构化 `Intent`（目标 → 分解 →
 * 预期结果 → 验收线），消灭"边想边说"的碎片预告。本模块实现：
 *
 *  - `planDeterministic(ctx)`：不依赖 LLM 的确定性兜底主路径。对相同 `ctx`
 *    恒产出**业务字段结构相同**的 `Intent`（goal / subgoals / expectedResult /
 *    acceptanceLine / status / mode 完全确定），仅 `id` / `createdAt` 这类
 *    本身含时间 / 随机的字段允许不同。`subgoals` 必定构成 DAG（isValidDag===true）
 *    且至少含 1 个 subgoal，依赖只引用更早加入的 subgoal（保证无环）。
 *  - `planFromContext(ctx, llm?)`：先算 `base = planDeterministic(ctx)`；`llm`
 *    为空直接返回 base；否则 try 调 `llm.refinePlan(base, ctx)` 增强分解质量，
 *    增强结果非 DAG 退回 base，任意异常 catch 退回 base。**确定性兜底成功时
 *    永不 reject**（fail-open，绝不阻断弟弟主链）。兜底分支直接返回 base 实例
 *    本身，使"llm 抛错 ⟹ planFromContext === planDeterministic"天然成立。
 *
 * 设计要点（参见 design.md「Algorithm 1」「Component 1」「Correctness
 * Properties · P1/P2」）：
 *  - Postcondition：返回 `Intent.status==="planned"` 且 `subgoals` 构成 DAG；
 *    LLM 不可用 / 抛错 ⟹ 结果等于 `planDeterministic(ctx)`；
 *    `ctx.mode==="dry-run"` ⟹ `Intent.mode==="dry-run"`（下游不得落地执行）。
 *  - 只读消费 `ctx.riverbedReasons` / `ctx.chronoSummaries` / `ctx.northStarGap`，
 *    不反向耦合源模块。
 *  - `dry-run` 下本函数只产 Intent，不外溢、不改变既有提示组织。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经最小只读接口 `PlanContext` / `LlmLike` 解耦）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖。
 */

import {
  isValidDag,
  newIntentId,
  type Intent,
  type LlmLike,
  type PlanContext,
  type Subgoal,
} from "./types.js";

// ─── 目标抽取（确定性纯函数） ─────────────────────────────────

/**
 * 目标摘要的最大字符数（用于派生 subgoal 文本，保持可读且确定）。
 */
const GOAL_SNIPPET_MAX = 48;

/**
 * 从上下文确定性抽取整件事的目标（一句话）。
 *
 * 优先级（确定性）：
 *  1. `ctx.userUtterance` 非空 → 用它。
 *  2. 否则取 `recentConversation` 中最后一条 user / human 角色的非空文本。
 *  3. 否则取 `recentConversation` 中最后一条任意非空文本。
 *  4. 否则若有 `northStarGap` → 由差距推断目标。
 *  5. 否则用通用兜底目标。
 *
 * 纯函数：不修改入参、无副作用、无随机性。
 */
function extractGoal(ctx: PlanContext): string {
  const utter = ctx.userUtterance?.trim();
  if (utter) {
    return utter;
  }

  const convo = ctx.recentConversation ?? [];
  for (let i = convo.length - 1; i >= 0; i -= 1) {
    const turn = convo[i];
    const role = (turn.role ?? "").toLowerCase();
    const text = (turn.text ?? "").trim();
    if (text && (role === "user" || role === "human")) {
      return text;
    }
  }
  for (let i = convo.length - 1; i >= 0; i -= 1) {
    const text = (convo[i].text ?? "").trim();
    if (text) {
      return text;
    }
  }

  if (ctx.northStarGap !== undefined) {
    return `收敛北极星差距（当前差距 ${ctx.northStarGap.gap}）`;
  }

  return "推进当前对话目标";
}

/**
 * 把目标压成短摘要，供 subgoal / 验收线文本派生（确定性截断）。
 */
function snippet(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length <= GOAL_SNIPPET_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, GOAL_SNIPPET_MAX)}…`;
}

/**
 * 把只读上下文线索（riverbed / chrono）确定性拼成一句锚定提示。
 *
 * 只读消费、不反向耦合源模块；无线索时返回空串。
 */
function contextHint(ctx: PlanContext): string {
  const reasons = ctx.riverbedReasons ?? [];
  const chrono = ctx.chronoSummaries ?? [];
  const parts: string[] = [];
  if (reasons.length > 0) {
    parts.push(`河床线索：${reasons[0]}`);
  }
  if (chrono.length > 0) {
    parts.push(`时空线索：${chrono[0]}`);
  }
  return parts.join("；");
}

// ─── 确定性兜底分解 ───────────────────────────────────────────

/**
 * 确定性拆分 subgoals：标准三段分解（理解 → 推进 → 验证收尾）。
 *
 * 保证：
 *  - 至少含 1 个 subgoal（恒为 3 个）。
 *  - id 确定（`sg_1` / `sg_2` / `sg_3`），不含随机 / 时间。
 *  - 依赖只引用更早加入的 subgoal（sg_2→sg_1，sg_3→sg_2），构成 DAG。
 *  - 每个 subgoal 声明 `expectedResult`。
 *
 * 纯函数：相同 ctx → 相同 subgoals。
 */
function buildSubgoals(ctx: PlanContext, goal: string): Subgoal[] {
  const head = snippet(goal);
  const hint = contextHint(ctx);
  const hintSuffix = hint ? `（${hint}）` : "";

  return [
    {
      id: "sg_1",
      goal: `明确并锚定目标：${head}${hintSuffix}`,
      dependsOn: [],
      expectedResult: `已澄清「${head}」的真实意图与边界`,
    },
    {
      id: "sg_2",
      goal: `推进执行：达成「${head}」`,
      dependsOn: ["sg_1"],
      expectedResult: `「${head}」的核心交付物已产出`,
    },
    {
      id: "sg_3",
      goal: `验证并凝练交付：「${head}」`,
      dependsOn: ["sg_2"],
      expectedResult: `交付物通过验收线并凝练为可外溢的人话`,
    },
  ];
}

/**
 * 确定性兜底：不依赖 LLM，从 `ctx` 抽取目标与分解产出 `Intent`。
 *
 * fail-open 主路径。对相同 `ctx`，本函数的业务字段（goal / subgoals /
 * expectedResult / acceptanceLine / status / mode）恒确定相同；仅 `id` /
 * `createdAt` 含时间 / 随机的字段允许不同。
 *
 * Postcondition：`status==="planned"`、`mode===ctx.mode`、
 * `isValidDag(subgoals)===true` 且 `subgoals.length >= 1`。
 *
 * @param ctx 规划核最小只读上下文。
 * @returns 确定性产出的 {@link Intent}。
 */
export function planDeterministic(ctx: PlanContext): Intent {
  const goal = extractGoal(ctx);
  const subgoals = buildSubgoals(ctx, goal);
  const head = snippet(goal);

  return {
    id: newIntentId(),
    sourceUtterance: ctx.userUtterance,
    goal,
    subgoals,
    expectedResult: `围绕「${head}」完成理解、推进与验证收尾的完整闭环`,
    acceptanceLine: `当「${head}」的交付物达成预期结果且通过凝练，即视为完成`,
    status: "planned",
    createdAt: new Date().toISOString(),
    mode: ctx.mode,
  };
}

// ─── LLM 增强 + 确定性兜底 ────────────────────────────────────

/**
 * 返回把 `status` 重置为 `"planned"` 的 Intent 副本（不修改入参）。
 */
function withPlannedStatus(intent: Intent): Intent {
  if (intent.status === "planned") {
    return intent;
  }
  return { ...intent, status: "planned" };
}

/**
 * 从上下文规划出 `Intent`。LLM 可用时增强分解质量，不可用 / 抛错时走确定性兜底。
 *
 * 算法（参见 design.md Algorithm 1）：
 *  1. `base = planDeterministic(ctx)`。
 *  2. `llm` 为 `undefined` → 直接返回 base（fail-open：无 LLM 直接兜底）。
 *  3. 否则 try 调 `llm.refinePlan(base, ctx)`：
 *     - 增强结果 `isValidDag(subgoals)===false` → 退回 base。
 *     - 否则返回 status 重置为 `"planned"` 的增强结果。
 *  4. catch 任意异常 → 退回 base。
 *
 * **确定性兜底成功时永不 reject**：除走 LLM 增强成功分支外，返回的恒是 base
 * 实例本身，故"llm 抛错 ⟹ planFromContext === planDeterministic"天然成立。
 *
 * @param ctx 规划核最小只读上下文。
 * @param llm 可选 LLM 能力；不可用 / 抛错时确定性兜底。
 * @returns 规划出的 {@link Intent}（promise）。
 */
export async function planFromContext(
  ctx: PlanContext,
  llm?: LlmLike,
): Promise<Intent> {
  const base = planDeterministic(ctx);

  if (llm === undefined) {
    return base;
  }

  try {
    const enriched = await llm.refinePlan(base, ctx);
    if (!isValidDag(enriched.subgoals)) {
      return base;
    }
    return withPlannedStatus(enriched);
  } catch {
    return base;
  }
}

// ─── PlanKernel 接口对象（契合 design Component 1） ──────────────

/**
 * 规划核接口（参见 design.md Component 1）。
 */
export interface PlanKernelLike {
  /** 从上下文规划出 Intent（LLM 增强或确定性兜底）。 */
  planFromContext(ctx: PlanContext, llm?: LlmLike): Promise<Intent>;
  /** 确定性兜底：不依赖 LLM，从 ctx 抽取目标与分解（fail-open 主路径）。 */
  planDeterministic(ctx: PlanContext): Intent;
}

/**
 * 默认 PlanKernel 实现对象，聚合 `planFromContext` 与 `planDeterministic`。
 */
export const PlanKernel: PlanKernelLike = {
  planFromContext,
  planDeterministic,
};
