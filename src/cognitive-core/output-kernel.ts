/**
 * 认知核三段脊柱 · 输出核（Component 3：output-kernel.ts）
 * ------------------------------------------------------------------
 * 只在**真节点**（done / blocked / needs_user）才对用户开口：先 `shouldEmit`
 * 裁决是否到了该开口的真节点（progress 默认沉默，消灭碎片预告），再 `condense`
 * 把节点事件凝练成结构化 `Output` 对象（带 type / audience / status /
 * directionAlignmentScore），文本受 `outputCharBudget` 约束治理超长。
 *
 * 本模块实现（参见 design.md「Algorithm 3」「Component 3」「Correctness
 * Properties · P3/P8/P9/P10/P11」）：
 *
 *  - `shouldEmit(signal, timing)`：纯函数、确定性。
 *    Postcondition：`signal.kind="progress"` ⟹ `{emit:false, reason:"silent"}`；
 *    `signal.kind ∈ {done,blocked,needs_user}` ⟹ `{emit:true, reason:signal.kind}`。
 *    复用 `PrefrontalReadLike` 时机信号（结构子类型，不反向 import prefrontal）。
 *  - `inferOutputType(intent, signal)`：关键词 + 信号推断，返回 5 种蓝本类型之一
 *    （可被 `cognitive-registry` 的 `OutputTypeRegistry.resolve` 解析）。
 *  - `condense(intent, signal, ctx, llm?)`：推断 type；由 `ctx.northStarGap`
 *    （复用 goalMonitor 差距）换算 `directionAlignmentScore ∈ [0,1]`；`llm` 可用
 *    时 try 调 `llm.condenseOutput` 增强，异常 / 不可用退回 `deterministicCondense`
 *    确定性兜底；`clampToBudget` 裁剪文本至 ≤ `ctx.outputCharBudget`；
 *    `audience="user"`、`status="drafted"`、`nodeKind=signal.kind`。
 *    `ctx.mode="dry-run"` 时终态 `status="suppressed"`（观察模式·零外溢）。
 *    `NodeSignal` 缺 `summary` 时以空摘要兜底。
 *
 * 注意（narrative 串联在接线层做）：
 *  `condense` 只**产出** `Output` 对象（含凝练后 `text`）。该 `text` 后续由
 *  riverMain 接线层（任务 9.3）交既有 `gateNarrative` 做忠实性 / 人格门校验，
 *  通过后再落 `emit`。本模块**不直接 import narrative**，以保持纯函数可测、
 *  不在认知核内二次拦截 narrative 拒绝（narrative 的 fail-open 由其本层处理）。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经最小只读接口解耦）、不 import narrative。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖（仅经 `types.ts` 的 `newOutputId` 间接用 `node:crypto`）。
 */

import {
  newOutputId,
  type EmitDecision,
  type Intent,
  type LlmLike,
  type NodeSignal,
  type Output,
  type OutputContext,
  type PrefrontalReadLike,
  type WenluOutputType,
} from "./types.js";

// ─── shouldEmit：节点裁决（纯函数） ─────────────────────────────

/**
 * 是否到了该对用户开口的真节点（参见 design.md「Algorithm 3 · shouldEmit」）。
 *
 * 纯函数、确定性：
 *  - `signal.kind = "progress"` ⟹ `{ emit: false, reason: "silent" }`（进度不外溢，
 *    消灭碎片预告）。
 *  - `signal.kind ∈ {done, blocked, needs_user}` ⟹ `{ emit: true, reason: signal.kind }`
 *    （真节点必开口）。
 *
 * `timing`（`PrefrontalReadLike`）作为复用既有 prefrontal 时机肌肉的入口保留；
 * 节点种类的真值裁决已足以满足 P8 / P9，故时机信号不改变本裁决结果。
 *
 * @param signal 执行过程中的节点事件信号。
 * @param timing prefrontal 时机判定的最小只读视图（复用时机肌肉）。
 * @returns 裁决结果 `EmitDecision`。
 */
export function shouldEmit(
  signal: NodeSignal,
  timing: PrefrontalReadLike,
): EmitDecision {
  // 进度信号：默认沉默，不外溢（消灭碎片预告）。
  if (signal.kind === "progress") {
    return { emit: false, reason: "silent" };
  }
  // done / blocked / needs_user 都是真节点 → 必开口。
  void timing; // 时机肌肉接入点（复用 prefrontal），不改变 kind 真值裁决。
  return { emit: true, reason: signal.kind };
}

// ─── inferOutputType：输出类型推断（纯函数） ──────────────────

/**
 * 借鉴 design 的关键词分桶（每桶命中即归该类型）。
 * 顺序即优先级：content → product → relationship_action → decision。
 */
const CONTENT_KEYWORDS = ["文章", "内容", "文案", "汇报"] as const;
const PRODUCT_KEYWORDS = ["工具", "网站", "代码", "产品"] as const;
const RELATIONSHIP_KEYWORDS = ["联系", "沟通", "对齐", "确认", "关系"] as const;
const DECISION_KEYWORDS = ["决策", "选择", "拍板"] as const;

/**
 * 推断输出类型（关键词 + 信号；借鉴 3.1 `inferOutputType` 蓝本，可扩展）。
 *
 * 推断口径（参见 design.md「Component 3」与本任务约定）：
 *  - 文本含「文章 / 内容 / 文案 / 汇报」⟹ `content`。
 *  - 文本含「工具 / 网站 / 代码 / 产品」⟹ `product`。
 *  - 文本含「联系 / 沟通 / 对齐 / 确认 / 关系」⟹ `relationship_action`。
 *  - 文本含「决策 / 选择 / 拍板」**或** `signal.kind === "needs_user"` ⟹ `decision`。
 *  - 否则 ⟹ `asset`。
 *
 * 推断语料 = `intent.goal` + `intent.expectedResult` + `signal.summary`（缺省空串）。
 * 返回值必为 5 种蓝本类型之一，可被 `OutputTypeRegistry.resolve` 解析。
 *
 * 纯函数、确定性。
 *
 * @param intent 溯源的 Intent。
 * @param signal 节点事件信号。
 * @returns 推断出的 `WenluOutputType`（5 种之一）。
 */
export function inferOutputType(
  intent: Intent,
  signal: NodeSignal,
): WenluOutputType {
  const summary = typeof signal.summary === "string" ? signal.summary : "";
  const haystack = `${intent.goal} ${intent.expectedResult} ${summary}`;

  const hit = (keywords: ReadonlyArray<string>): boolean =>
    keywords.some((kw) => haystack.includes(kw));

  // 顺序即优先级：content → product → relationship_action → decision。
  if (hit(CONTENT_KEYWORDS)) {
    return "content";
  }
  if (hit(PRODUCT_KEYWORDS)) {
    return "product";
  }
  if (hit(RELATIONSHIP_KEYWORDS)) {
    return "relationship_action";
  }
  if (hit(DECISION_KEYWORDS) || signal.kind === "needs_user") {
    return "decision";
  }
  // 兜底：沉淀资产。
  return "asset";
}

// ─── condense 内部辅助 ────────────────────────────────────────

/** 节点种类（done/blocked/needs_user）的中文人话前缀。 */
const NODE_KIND_PREFIX: Readonly<Record<NodeSignal["kind"], string>> = {
  done: "已完成",
  blocked: "卡住了",
  needs_user: "需要你拍板",
  progress: "进行中",
};

/**
 * 由 `goalMonitor` 北极星差距换算方向对齐分 `directionAlignmentScore ∈ [0,1]`。
 *
 * 口径：`gap`（通常 0–100，越小越对齐）⟹ `1 - clamp(gap/100, 0, 1)`，差距越小分越高。
 * 无 `northStarGap` 时给中性 `0.5`。返回值恒落闭区间 [0,1]（满足 P11）。
 *
 * 纯函数、确定性。
 */
function alignmentFromGoalMonitor(ctx: OutputContext): number {
  if (ctx.northStarGap === undefined) {
    return 0.5; // 中性默认，∈[0,1]。
  }
  const gap = ctx.northStarGap.gap;
  // 非有限数（NaN/Infinity）兜底为中性，避免污染 [0,1] 边界。
  if (!Number.isFinite(gap)) {
    return 0.5;
  }
  const normalized = clamp01(gap / 100);
  return clamp01(1 - normalized);
}

/** 把任意数夹到闭区间 [0,1]（非有限数兜底为 0）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 把文本裁剪至 ≤ `budget` 字符（满足 P10·超长治理）。
 *
 * `budget ≤ 0` 时返回空串；`budget` 非正常数时退回原文（防御性，调用方应保证）。
 * 纯函数、确定性。
 */
function clampToBudget(text: string, budget: number): string {
  if (!Number.isFinite(budget)) {
    return text;
  }
  if (budget <= 0) {
    return "";
  }
  // 以 Array.from 按码点切片，避免截断代理对（emoji 等）破坏字符。
  const chars = Array.from(text);
  if (chars.length <= budget) {
    return text;
  }
  return chars.slice(0, budget).join("");
}

/**
 * 确定性凝练兜底（纯函数）：基于 `intent.goal` + `signal.summary` + nodeKind
 * 生成一段人话。相同输入恒得相同 `text`（不含 id / createdAt 等随机/时变字段）。
 *
 * 形如：「已完成：<goal> —— <summary>」；缺 summary 时省略尾段。
 *
 * @param intent 溯源的 Intent。
 * @param signal 节点事件信号。
 * @returns 确定性凝练文本。
 */
export function deterministicCondense(
  intent: Intent,
  signal: NodeSignal,
): string {
  const prefix = NODE_KIND_PREFIX[signal.kind] ?? "进行中";
  const goal = typeof intent.goal === "string" ? intent.goal.trim() : "";
  const summary =
    typeof signal.summary === "string" ? signal.summary.trim() : "";

  const goalPart = goal.length > 0 ? `：${goal}` : "";
  const summaryPart = summary.length > 0 ? ` —— ${summary}` : "";
  return `${prefix}${goalPart}${summaryPart}`;
}

// ─── condense：节点凝练（产出 Output） ────────────────────────

/**
 * 把节点事件凝练成结构化 `Output`（LLM 增强或确定性兜底）。
 *
 * 流程（参见 design.md「Algorithm 3 · condense」）：
 *  1. `type = inferOutputType(intent, signal)`（可被 registry 解析）。
 *  2. `directionAlignmentScore = alignmentFromGoalMonitor(ctx)` ∈ [0,1]。
 *  3. `llm` 可用 ⟹ try 调 `llm.condenseOutput` 增强；异常 / 不可用 ⟹ 退回
 *     `deterministicCondense`（fail-open，绝不阻断主链）。
 *  4. `clampToBudget` 把文本裁剪至 ≤ `ctx.outputCharBudget`（P10·超长治理）。
 *  5. 组装 `Output{ audience:"user", status:"drafted", nodeKind:signal.kind, ... }`。
 *  6. `ctx.mode === "dry-run"` ⟹ 终态 `status = "suppressed"`（P3·零外溢）。
 *
 * 产出的 `text` 后续由接线层（任务 9.3）交既有 `gateNarrative` 校验再 emit；
 * 本函数不直接接 narrative。
 *
 * 永不 reject（LLM 异常内部 catch 后兜底）。
 *
 * @param intent 溯源的 Intent。
 * @param signal 节点事件信号（`progress` 不应进入此路径，但仍按 done 之外兜底处理）。
 * @param ctx    凝练所需最小只读上下文（差距 / 模式 / 字符预算）。
 * @param llm    可选 LLM 能力（谁强用谁；不可用 / 抛错时确定性兜底）。
 * @returns 凝练后的 `Output`（promise）。
 */
export async function condense(
  intent: Intent,
  signal: NodeSignal,
  ctx: OutputContext,
  llm?: LlmLike,
): Promise<Output> {
  const type = inferOutputType(intent, signal);
  const directionAlignmentScore = alignmentFromGoalMonitor(ctx);

  // LLM 增强（谁强用谁）；不可用 / 抛错 / 非字符串结果 ⟹ 退回确定性兜底。
  let draft: string | null = null;
  if (llm !== undefined) {
    try {
      const enriched = await llm.condenseOutput(intent, signal, ctx);
      if (typeof enriched === "string" && enriched.length > 0) {
        draft = enriched;
      }
    } catch {
      // fail-open：忽略 LLM 异常，走确定性兜底（不外溢、不阻断主链）。
      draft = null;
    }
  }

  const rawText = draft ?? deterministicCondense(intent, signal);
  const text = clampToBudget(rawText, ctx.outputCharBudget);

  // nodeKind 只取真节点三种；progress 不应到此（防御性兜底为 done）。
  const nodeKind: Output["nodeKind"] =
    signal.kind === "progress" ? "done" : signal.kind;

  const status: Output["status"] =
    ctx.mode === "dry-run" ? "suppressed" : "drafted";

  return {
    id: newOutputId(),
    intentId: intent.id,
    type,
    audience: "user",
    status,
    text,
    directionAlignmentScore,
    nodeKind,
    createdAt: new Date().toISOString(),
  };
}

// ─── 可选 OutputKernel 接口对象聚合 ───────────────────────────

/**
 * 可选的 OutputKernel 接口对象聚合（沿用 design.md「Component 3」接口形态）。
 */
export const OutputKernel = {
  shouldEmit,
  condense,
  inferOutputType,
} as const;
