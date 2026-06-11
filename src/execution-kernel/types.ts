/**
 * 持续执行内核 · 一等公民类型 + ReadLike 解耦接口（types.ts）
 * ------------------------------------------------------------------
 * 全部为领域无关的通用执行类型。跨模块只读引用一律用 *ReadLike 结构子类型，
 * 不反向 import riverMain.ts / 不 import 3.1·3.2。
 * _Requirements: 1.5, 2.1, 3.1, 4.1, 5.1, 8.1, 8.2_
 */

import { randomUUID } from "node:crypto";

// ─── 感知闭环 ────────────────────────────────────────────────────

/** 动作结果四态：达成 / 执行了但世界没变 / 变了但非预期 / 无法判定。 */
export type ActionOutcome = "achieved" | "no_effect" | "wrong_effect" | "unknown";

export type ActionKind = "cli" | "file" | "gui" | "api" | "generic";

/** 对一次任务相关外部真实状态的结构化快照。 */
export interface WorldState {
  kind: ActionKind;
  /** 结构化状态：按钮树 / 文件哈希 / 响应体 / 状态字段等。 */
  snapshot: Record<string, unknown>;
  capturedAt: string;
}

/** 回读探针：纯接口，由接线点注入具体读取器（库内不绑定任何领域实现）。 */
export interface StateProbe {
  read(): Promise<WorldState>;
}

/** 一步的可回放记录。 */
export interface ExecutionStep {
  intent: string;
  action: string;
  before?: WorldState;
  after?: WorldState;
  /** 客观状态差异（人可读摘要）。 */
  diff: string;
  outcome: ActionOutcome;
  /** 与中期计划的关系（可选）。 */
  planRelation?: string;
  createdAt: string;
}

// ─── 持续脊柱 ────────────────────────────────────────────────────

export type TaskExecStatus = "running" | "waiting" | "done" | "failed" | "blocked" | "aborted";

/** 唤醒条件：只描述外部世界事件；满足判定由接线点用真实探针做（库不自起 timer）。 */
export interface WakeCondition {
  kind: "file_appears" | "window_state" | "http_callback" | "external_signal" | "opponent_moved";
  spec: Record<string, unknown>;
  /** 人可读描述：在等什么具体外部事件。 */
  describe: string;
}

/** 跨步活状态：步间传递的"做到哪 / 下步做什么 / 为什么 / 当前计划"。 */
export interface WorkingState {
  doneSoFar: string[];
  nextStep: string;
  rationale: string;
  /** 关联的中期计划标识（可选）。 */
  planRef?: string;
  updatedAt: string;
}

export interface ContinuationDecision {
  next: "continue" | "wait" | "stop_loss" | "complete" | "abort";
  /** next==="wait" 时必带：等待的外部事件。 */
  wake?: WakeCondition;
  reason: string;
}

// ─── 终态镜子 ────────────────────────────────────────────────────

/** 只读用户画像投影（结构子类型，不反向 import 宿主 UserInsight）。 */
export interface UserModelReadLike {
  insights: ReadonlyArray<{ aspect: string; content: string; confidence: number }>;
}

/** 只读北极星差距（复用 goalMonitor 产物的最小形态）。 */
export interface GoalGapReadLike {
  gap: number;
  topDimension?: string;
}

export interface DefinitionOfDone {
  goal: string;
  /** 可客观验证的完成条件。 */
  doneConditions: string[];
  /** 建议的客观验证方式（喂给既有 verify_task）。 */
  verifyHint?: string;
  /** 是否成功对齐了 userModel。 */
  userAligned: boolean;
  createdAt: string;
}

// ─── 策略层 ──────────────────────────────────────────────────────

/** 只读河床域态势（经 riverbed barrel 注入；不自造判断引擎）。 */
export interface RiverbedJudgmentReadLike {
  summary: string;
  topDomains: ReadonlyArray<{ domain: string; salience: number }>;
}

/** 领域合法性校验器（如 chess.js 适配）。 */
export interface LegalityValidator {
  isLegal(candidate: string, context: unknown): boolean;
}

// ─── 注意力对齐 ──────────────────────────────────────────────────

/** 只读反思层元判断（结构子类型）。 */
export interface ReflectionReadLike {
  verdict: string;
  shrinkSignal: boolean;
  goalFocus: string;
}

/**
 * 可选语义裁判（LLM 增强注入点）。给定前后态与预期，返回四态判定 + 简述。
 * 不注入时判定层走确定性 token 兜底；注入且不抛时用其语义判定；抛异常则 fail-open 回退 token。
 * 这让"是否达成/是否相关"从正则升级为语义，同时保留确定性 fail-safe（与全内核哲学一致）。
 */
export interface OutcomeJudgeLike {
  judge(input: {
    intendedEffect: string;
    beforeSummary: string;
    afterSummary: string;
    tokenOutcome: ActionOutcome;
  }): Promise<{ outcome: ActionOutcome; reason: string } | null>;
}

// ─── id 生成器 ───────────────────────────────────────────────────

export function newStepId(): string {
  return `step_${randomUUID()}`;
}

export function newPlanId(): string {
  return `plan_${randomUUID()}`;
}
