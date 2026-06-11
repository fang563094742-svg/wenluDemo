/**
 * 持续执行内核 · Component 1：PerceptionLoop 感知闭环
 * ------------------------------------------------------------------
 * 核心原则：执行与验证是两个独立步骤。任何动作执行后，用独立于"执行"的手段
 * 回读真实世界状态，对比前后态，给出客观差异 + ActionOutcome 四态。
 * 消灭"退出码 0 = 成功"的自欺。
 *
 * 库内只定义 StateProbe 接口，具体读取器（CLI 解析 / 文件 re-read / GUI 可访问性 /
 * API 响应）由接线点注入 —— 保持领域无关与独立性。
 *
 * fail-open：probe 缺失或抛异常 ⟹ outcome="unknown"，promise 永不 reject。
 * _Requirements: 1.1-1.8, 8.1, 8.2_
 */

import {
  type ActionOutcome,
  type WorldState,
  type StateProbe,
  type ExecutionStep,
  type OutcomeJudgeLike,
  newStepId,
} from "./types.js";

/** 稳定序列化用于状态比对（键排序，避免字段顺序造成假差异）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 简短差异摘要：状态变了没、变了哪些顶层键。 */
function summarizeDiff(before: WorldState | undefined, after: WorldState | undefined): { changed: boolean; diff: string } {
  if (!before && !after) return { changed: false, diff: "no-state(before/after both absent)" };
  if (!before) return { changed: true, diff: "before-absent → after-present" };
  if (!after) return { changed: true, diff: "before-present → after-absent" };
  const b = before.snapshot ?? {};
  const a = after.snapshot ?? {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  const changedKeys: string[] = [];
  for (const k of keys) {
    if (stableStringify(b[k]) !== stableStringify(a[k])) changedKeys.push(k);
  }
  if (changedKeys.length === 0) return { changed: false, diff: "state unchanged" };
  return { changed: true, diff: `changed keys: ${changedKeys.join(", ")}` };
}

/**
 * 判定四态：
 * - before/after 任一缺失且无法比对 → unknown
 * - 状态未变 → no_effect
 * - 状态变了：尝试用 intendedEffect 关键词在 after 快照里寻证；命中 → achieved，否则 wrong_effect
 *
 * 只输出客观 diff + 四态；"这算不算达成"的最终解释权部分留给上层（上层可据 diff 复核）。
 */
export function judgeOutcome(
  before: WorldState | undefined,
  after: WorldState | undefined,
  intendedEffect: string,
): { outcome: ActionOutcome; diff: string } {
  try {
    const { changed, diff } = summarizeDiff(before, after);
    if (!after) return { outcome: "unknown", diff };
    if (!changed) return { outcome: "no_effect", diff };

    const intent = (intendedEffect ?? "").trim().toLowerCase();
    if (!intent) {
      // 没有可比对的预期 → 只能确认"变了"，但无法确认是否如预期。
      return { outcome: "unknown", diff: `${diff}; no intendedEffect to verify against` };
    }
    const haystack = stableStringify(after.snapshot).toLowerCase();
    // 预期效果里的非平凡 token 至少有一个出现在后态 → 视作达成的客观佐证。
    const tokens = intent.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((t) => t.length >= 2);
    const matched = tokens.some((t) => haystack.includes(t));
    if (matched) return { outcome: "achieved", diff: `${diff}; intendedEffect evidence found` };
    return { outcome: "wrong_effect", diff: `${diff}; changed but intendedEffect evidence NOT found` };
  } catch (e) {
    return { outcome: "unknown", diff: `judge error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 包裹一次动作的"前态→(调用方已执行)→后态→判定"。
 *
 * 约定：调用方在 read 后态之前，已经执行了实际动作。本函数负责读前态、读后态、判定。
 * 若需要"前态在动作前读"，调用方应先持有 before（通过两次调用或预读）。这里采用
 * 最简形态：传入可选 before；probe.read() 读后态。
 *
 * 判定优先级：注入了语义裁判 judge 且不抛 → 用其语义判定；否则 / 抛异常 → 回退确定性
 * token 兜底 judgeOutcome（fail-safe）。整体永不 reject。
 */
export async function observeAction(params: {
  intent: string;
  action: string;
  intendedEffect: string;
  before?: WorldState;
  probe?: StateProbe;
  judge?: OutcomeJudgeLike;
}): Promise<ExecutionStep> {
  const { intent, action, intendedEffect, before } = params;
  let after: WorldState | undefined;
  try {
    if (params.probe) after = await params.probe.read();
  } catch {
    after = undefined; // fail-open：读不到后态当作 unknown
  }
  // 先算确定性兜底（永远可用的 fail-safe）。
  const fallback = judgeOutcome(before, after, intendedEffect);
  let outcome = fallback.outcome;
  let diff = fallback.diff;
  // 语义增强：注入了 judge 且能产出，则用语义判定覆盖（仍保留 diff 作客观佐证）。
  if (params.judge && after) {
    try {
      const sem = await params.judge.judge({
        intendedEffect,
        beforeSummary: before ? JSON.stringify(before.snapshot).slice(0, 800) : "(无前态)",
        afterSummary: JSON.stringify(after.snapshot).slice(0, 800),
        tokenOutcome: fallback.outcome,
      });
      if (sem && (sem.outcome === "achieved" || sem.outcome === "no_effect" || sem.outcome === "wrong_effect" || sem.outcome === "unknown")) {
        outcome = sem.outcome;
        diff = `${diff}; 语义判定:${sem.reason?.slice(0, 120) ?? ""}`;
      }
    } catch {
      // fail-open：语义裁判异常 → 沿用 token 兜底结果。
    }
  }
  return {
    intent,
    action,
    before,
    after,
    diff,
    outcome,
    createdAt: new Date().toISOString(),
  } satisfies ExecutionStep;
}

/** 读一次当前态（用于在动作前取 before）。fail-open 返回 undefined。 */
export async function probeState(probe?: StateProbe): Promise<WorldState | undefined> {
  try {
    return probe ? await probe.read() : undefined;
  } catch {
    return undefined;
  }
}

/** 类封装（与 cognitive-core 的 Kernel 风格一致）。 */
export class PerceptionLoop {
  async observe(params: {
    intent: string;
    action: string;
    intendedEffect: string;
    before?: WorldState;
    probe?: StateProbe;
    judge?: OutcomeJudgeLike;
  }): Promise<ExecutionStep> {
    return observeAction(params);
  }

  async probeBefore(probe?: StateProbe): Promise<WorldState | undefined> {
    return probeState(probe);
  }
}

// 保留 newStepId 以便调用方需要唯一 id 时使用（避免 unused 警告由调用点决定）。
export { newStepId };
