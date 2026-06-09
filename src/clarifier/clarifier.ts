/**
 * Clarifier 编排（任务 7.9，R8 核心）——`begin` / `next` 两段式澄清主流程。
 *
 * 设计依据：design.md「Clarifier 算法详解」之「就绪判定伪代码 / 每轮 LLM 调用的输入输出
 * JSON schema / 关键机制说明」。本模块是 R8 的**编排层**：它把三件已实现的纯函数串起来，
 * 并负责与 `LLM_Provider` 的交互、状态推进与 `ClarifierStep` 产出：
 *
 *  - `evaluateReadiness`（readiness.ts，7.3）——充分性判定纯函数（一阶门槛/充要条件）。
 *  - `injectRiskAll`（riskInjection.ts，7.2）——对 LLM 给出的 `risk_level` 做规则强制高危覆盖。
 *  - `generateConfidenceStatement`（confidence.ts，7.7）——从 `resolvedBy` 机械生成置信度说明。
 *
 * 本模块**不重复实现**上述纯函数，只做编排。
 *
 * ## begin（任务分解，schema a）
 * 用户接受某条 `Awareness_Item` 后，让 LLM 把任务分解为**不限数量**的粗粒度逻辑阶段
 * （R8.5：不截断、阶段数 = LLM 给出数）。Clarifier 一次只 `focused` 一个阶段。
 *
 * ## next（前提评估 + 提问 / 充分 / 僵局，schema b/c）
 * 每次调用：
 *  1. 应用上一轮答复（`acceptedDefaultFor` → `default_accepted`；自由文本 → 喂给 LLM 历史）。
 *  2. `round++`（一轮澄清）。
 *  3. 对当前 `focused` 阶段调用 LLM（schema b）评估 `Execution_Precondition[]` 与候选提问，
 *     经 `injectRiskAll` 做规则强制高危覆盖后并入状态。
 *  4. 调 `evaluateReadiness`：
 *     - `ask` → 经 LLM 文本动态生成 `ClarifyQuestion[]`（≤ `perRoundQuestionLimit`，R8.4）；
 *       仅剩低风险模糊前提时附明确默认值选项（R8.3）；顶层阶段数 > 阈值附收敛建议（R8.13）。
 *       **同等风险下低 `confidenceScore` 优先提问**（不确定性越高越先问），并可在话术中披露
 *       （如"我只有 60% 的把握"）。
 *     - `advance_phase` → 切 `focusedPhaseId` 后**重评**（对新阶段再跑一次 LLM）。
 *     - `sufficient` → LLM（schema c）组装 `Task_Frame`（objective/acceptanceTests/primaryTargets），
 *       `confidence` 由 `generateConfidenceStatement` 机械生成，并向用户问
 *       "基于以上理解，我可以开始执行吗？"（R8.10/8.11，确认门由状态机把守）。
 *     - `impasse` → 组装 `ImpasseSummary`（R8.12）。
 *
 * `confidenceScore`（0-1，LLM 自评置信度）为**可选增强项、非 MVP 阻塞项**：LLM 未给出时
 * 主流程不受影响，排序退化为仅按 `risk_level`/`status` 判定（顺序不变）。
 *
 * _Requirements: 8.1, 8.3, 8.4, 8.5, 8.10, 8.11, 8.13_
 */

import { randomUUID } from "node:crypto";

import {
  maxRounds as DEFAULT_MAX_ROUNDS,
  perRoundQuestionLimit as DEFAULT_PER_ROUND_QUESTION_LIMIT,
  topPhaseConvergenceThreshold as DEFAULT_TOP_PHASE_CONVERGENCE_THRESHOLD,
} from "../config/config.js";
import type { Awareness_Item } from "../analyzer/analyzer.js";
import type { Session } from "../orchestrator/session.js";
import type { LLM_Provider, LlmRequest } from "../llm/llmProvider.js";

import { evaluateReadiness } from "./readiness.js";
import { injectRiskAll } from "./riskInjection.js";
import { generateConfidenceStatement } from "./confidence.js";
import type {
  Acceptance_Test,
  ClarifierState,
  ClarifyQuestion,
  Execution_Precondition,
  ImpasseSummary,
  LogicalPhase,
  PreconditionStatus,
  Readiness,
  RiskLevel,
  Task_Frame,
  UserAnswer,
} from "./types.js";

// ===========================================================================
// 接口契约（design.md「Clarifier（R8）」）
// ===========================================================================

/**
 * `next()` 一步的产出：本轮提问 / 信息充分（待用户最终确认）/ 软上限僵局。
 *
 * 与 design.md 的 `ClarifierStep` 形状一致。R8.10「基于以上理解，我可以开始执行吗？」
 * 的确认问询文案由 `UNDERSTANDING_CONFIRMATION_PROMPT` 提供，呈现/确认门由 UI 与状态机负责。
 */
export type ClarifierStep =
  | { kind: "questions"; questions: ClarifyQuestion[] } // 本轮提问（R8.1-5）
  | { kind: "sufficient"; taskFrame: Task_Frame } // 信息充分（R8.7-9），待用户最终确认
  | { kind: "impasse"; summary: ImpasseSummary }; // 软上限兜底（R8.12）

/**
 * Clarifier 编排接口（R8）。
 */
export interface Clarifier {
  /** 用户接受某条 Awareness_Item 后初始化澄清会话：任务分解为粗粒度逻辑阶段。 */
  begin(item: Awareness_Item, session: Session): Promise<ClarifierState>;

  /** 生成下一轮澄清问题（≤ 上限），或声明信息充分并产出 Task_Frame，或进入 impasse。 */
  next(state: ClarifierState, lastAnswer?: UserAnswer): Promise<ClarifierStep>;
}

/** Clarifier 编排阶段的描述性错误（非致命，由编排层捕获后保持服务运行）。 */
export class ClarifierError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClarifierError";
  }
}

// ===========================================================================
// 常量
// ===========================================================================

/** R8.10：声明信息充分后向用户明示理解并询问的确认问询文案。 */
export const UNDERSTANDING_CONFIRMATION_PROMPT =
  "基于以上理解，我可以开始执行吗？";

/**
 * `confidenceScore` 低于此阈值时，在澄清话术中显式披露不确定性（如"我只有 60% 的把握"）。
 * 仅当 LLM 给出 `confidenceScore` 时生效；缺省则不披露（行为不变）。
 */
export const CONFIDENCE_DISCLOSURE_THRESHOLD = 0.7;

// ===========================================================================
// 输出约束：每轮 LLM 调用的 JSON schema（design.md「输入/输出 JSON schema」）
// ===========================================================================

/** (a) begin —— 任务分解 + 收敛信号（输出 schema）。 */
export const BEGIN_OUTPUT_SCHEMA: object = {
  type: "object",
  properties: {
    phases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          order: { type: "integer" },
        },
        required: ["title", "order"],
      },
    },
    convergenceSuggested: { type: "boolean" },
  },
  required: ["phases", "convergenceSuggested"],
};

/**
 * (b) next —— focused 阶段前提评估 + 风险 + 提问（输出 schema）。
 *
 * 与 design.md schema (b) 对齐，并约定 `questions[].targetPreconditionIndexes` 用前提在
 * `preconditions` 数组中的**序号（从 1 开始）**指向其目标前提——避免依赖编排层内部 id，
 * 由本模块负责把序号翻译为内部稳定 id。
 */
export const NEXT_OUTPUT_SCHEMA: object = {
  type: "object",
  properties: {
    preconditions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          status: { enum: ["known", "ambiguous", "unknown"] },
          risk_level: { enum: ["low", "medium", "high"] },
          related_action: { type: "string" },
          proposedDefault: { type: "string" },
          // 不确定性数值化（锦上添花，非 MVP 阻塞项）：LLM 对该前提判断的自评置信度。
          confidenceScore: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["description", "status", "risk_level", "related_action"],
      },
    },
    phaseSaturated: { type: "boolean" },
    deferRemaining: { type: "boolean" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          targetPreconditionIndexes: {
            type: "array",
            items: { type: "integer" },
          },
          defaultOption: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
          },
          isConvergenceSuggestion: { type: "boolean" },
        },
        required: ["text", "targetPreconditionIndexes"],
      },
    },
  },
  required: ["preconditions", "phaseSaturated", "questions"],
};

/** (c) sufficient —— Task_Frame 组装（输出 schema）。 */
export const SUFFICIENT_OUTPUT_SCHEMA: object = {
  type: "object",
  properties: {
    objective: { type: "string" },
    acceptanceTests: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          checkMethod: { type: "string" },
        },
        required: ["description", "checkMethod"],
      },
    },
    primaryTargets: {
      type: "array",
      items: { type: "string" },
    },
    suggestedWorkingDirHint: { type: "string" },
  },
  required: ["objective", "acceptanceTests", "primaryTargets"],
};

// ===========================================================================
// Prompt 构造
// ===========================================================================

/** begin 阶段 system 段：把任务分解为不限数量的粗粒度逻辑阶段（R8.5）。 */
export function buildBeginSystemPrompt(): string {
  return [
    "你是问路（Wenlu）的「澄清定面器（Clarifier）」的任务分解模块。",
    "用户已接受一条主动察觉条目（Awareness_Item），现在请把它分解为若干**粗粒度逻辑阶段**。",
    "",
    "原则：",
    "1. 阶段是粗粒度的逻辑步骤（如：分析现状 → 设计方案 → 实现改动 → 验证结果），不是细碎的操作清单。",
    "2. **不要限制阶段数量**：任务需要几个阶段就给几个；既不要硬凑，也不要为了精简而合并掉本应独立的阶段。",
    "3. 按执行先后用 order（从 1 开始的整数）排序。",
    "4. 若任务范围明显过大（顶层阶段过多、目标发散），把 convergenceSuggested 置为 true，提示应先收敛聚焦。",
    "",
    "字段名要求（务必严格遵守，不要改用近义词）：顶层阶段数组字段名必须是 phases（不是 stages），",
    "每个阶段的标题字段名必须是 title（不是 name），序号字段名必须是 order。",
    "",
    "输出：严格遵守给定 JSON schema，只返回 JSON，不要输出任何额外解释或 markdown 代码块标记。",
  ].join("\n");
}

/** begin 阶段 user 段：注入察觉条目，并在可得时附扫描摘要作为分解上下文。 */
export function buildBeginUserPrompt(
  item: Awareness_Item,
  session: Session,
): string {
  const lines: string[] = [
    "待分解的察觉条目（Awareness_Item）：",
    "",
    "```json",
    JSON.stringify(
      { title: item.title, rationale: item.rationale, evidence: item.evidence },
      null,
      2,
    ),
    "```",
  ];

  // 利用会话中的扫描摘要作为分解上下文（仅元信息，帮助 LLM 更贴合现状地划分阶段）。
  if (session.scanSummary) {
    lines.push(
      "",
      "可参考的设备扫描摘要（Scan_Summary，仅元信息，用于让阶段划分更贴合现状）：",
      "",
      "```json",
      JSON.stringify(session.scanSummary, null, 2),
      "```",
    );
  }

  lines.push("", "请把该任务分解为粗粒度逻辑阶段，按上述原则输出。");
  return lines.join("\n");
}

/** next 阶段 system 段：评估 focused 阶段的执行前提、风险与动态提问（R8.1/8.2/8.4）。 */
export function buildNextSystemPrompt(): string {
  return [
    "你是问路（Wenlu）的「澄清定面器（Clarifier）」。你的目标不是把表单槽位填满，",
    "而是与用户就「即将发生的行为、边界、成功标准、失败处理方式」建立共同操作性理解。",
    "",
    "针对**当前聚焦阶段**，请列出执行该阶段所需成立的执行前提（Execution_Precondition），并逐项评估：",
    "1. status：known（已明确）/ ambiguous（模糊）/ unknown（未知）。",
    "2. risk_level：由其对应执行动作的不可逆性与风险给出 low/medium/high（删除/权限/sudo/不可逆/force push 等高危动作请如实标 high；最终高危判定会由规则层再覆盖一次）。",
    "3. related_action：该前提对应的具体执行动作描述。",
    "4. proposedDefault：**仅低/中风险**模糊前提给出一个明确、具体、合理的默认值（用于「采用默认值并继续」）。",
    "5. confidenceScore（可选，0-1）：你对该前提 status/risk 判断的自评置信度——越不确定给越低的分。无法评估可省略。",
    "",
    "再给出本轮的候选澄清问题（questions）：",
    "- **优先针对高风险且模糊的前提**提问；问题要针对本任务动态生成，**不要使用固定模板**。",
    "- targetPreconditionIndexes 用所指向前提在 preconditions 数组中的序号（从 1 开始）。",
    "- 若某前提仅剩低风险且模糊，请在该问题上给出 defaultOption（label + 明确的具体 value）。",
    "- phaseSaturated：当前阶段是否已无高风险且模糊的前提（可执行）。",
    "- deferRemaining：是否「当前阶段理解已足够，建议先执行、执行中再澄清后续阶段」。",
    "",
    "字段名要求（务必严格遵守，不要改用近义词）：前提描述用 description、风险等级用 risk_level、",
    "对应动作用 related_action；问题文本用 text。",
    "",
    "输出：严格遵守给定 JSON schema，只返回 JSON，不要输出任何额外解释或 markdown 代码块标记。",
  ].join("\n");
}

/** next 阶段 user 段：注入 focused 阶段、已知前提与答复历史。 */
export function buildNextUserPrompt(
  state: ClarifierState,
  focusedPhase: LogicalPhase | undefined,
  lastAnswer?: UserAnswer,
): string {
  const knownPreconditions = state.preconditions
    .filter((p) => p.phaseId === state.focusedPhaseId)
    .map((p) => ({
      description: p.description,
      status: p.status,
      risk_level: p.risk_level,
      resolvedBy: p.resolvedBy,
      resolvedValue: p.resolvedValue,
    }));

  const lines: string[] = [
    `任务被分解为 ${state.phases.length} 个逻辑阶段。当前聚焦阶段：`,
    "",
    "```json",
    JSON.stringify(
      focusedPhase
        ? { title: focusedPhase.title, order: focusedPhase.order }
        : { title: "（未知阶段）", order: 0 },
      null,
      2,
    ),
    "```",
  ];

  if (knownPreconditions.length > 0) {
    lines.push(
      "",
      "该阶段已记录的执行前提（请在此基础上更新/补充，不要丢失已消解的信息）：",
      "",
      "```json",
      JSON.stringify(knownPreconditions, null, 2),
      "```",
    );
  }

  if (lastAnswer && (lastAnswer.text ?? "").trim().length > 0) {
    lines.push(
      "",
      "用户对上一轮澄清问题的最新答复（请据此把相应前提从 ambiguous/unknown 更新为 known）：",
      "",
      `「${lastAnswer.text!.trim()}」`,
    );
  }

  lines.push(
    "",
    `请评估该阶段的执行前提，并最多给出 ${state.perRoundQuestionLimit} 个候选澄清问题。`,
  );
  return lines.join("\n");
}

/** sufficient 阶段 system 段：组装可执行的 Task_Frame（强调验收测试可机检，R8.9/R12.5）。 */
export function buildSufficientSystemPrompt(): string {
  return [
    "你是问路（Wenlu）的「澄清定面器（Clarifier）」。澄清已充分，请把当前理解整理为一个可支撑执行的结构化任务描述（Task_Frame）。",
    "",
    "请输出：",
    "1. objective：一句话清晰陈述任务目标。",
    "2. acceptanceTests：**至少一条**可在任务执行后用于检验是否达成预期的验收测试。",
    "   每条的 checkMethod **必须是可由命令/程序自动检验的方式**，例如：",
    "   - 运行 `npm run build` 并检查退出码为 0；",
    "   - 运行 `diff old.txt new.txt` 并断言差异符合预期；",
    "   - 向 `localhost:3000/api` 发 GET 请求并检查响应码为 200；",
    "   - 读取 `src/config.ts` 并断言包含某字段。",
    "3. primaryTargets：任务真正要改动的主要操作对象（文件路径/目录/项目名），供后续做动作相关性校验。",
    "4. suggestedWorkingDirHint（可选）：建议的工作目录线索。",
    "",
    "字段名要求（务必严格遵守，不要改用近义词）：目标用 objective；每条验收测试的描述用 description、",
    "检验方式用 checkMethod。",
    "",
    "输出：严格遵守给定 JSON schema，只返回 JSON，不要输出任何额外解释或 markdown 代码块标记。",
  ].join("\n");
}

/** sufficient 阶段 user 段：注入目标 + 已消解前提，供 LLM 组装 Task_Frame。 */
export function buildSufficientUserPrompt(state: ClarifierState): string {
  const resolved = state.preconditions
    .filter((p) => p.status === "known" || p.resolvedBy !== undefined)
    .map((p) => ({
      description: p.description,
      related_action: p.related_action,
      resolvedBy: p.resolvedBy,
      resolvedValue: p.resolvedValue ?? p.proposedDefault,
    }));

  return [
    "已澄清充分的执行前提如下：",
    "",
    "```json",
    JSON.stringify(resolved, null, 2),
    "```",
    "",
    "请据此组装 Task_Frame（objective / acceptanceTests / primaryTargets / suggestedWorkingDirHint）。",
  ].join("\n");
}

// ===========================================================================
// LLM 原始输出的中间形状（解析后再做防御性校验）
// ===========================================================================

interface RawBeginOutput {
  phases?: unknown;
  /** 真实模型常用别名：部分 LLM 用 `stages` 而非 schema 要求的 `phases`（解析兜底）。 */
  stages?: unknown;
  convergenceSuggested?: unknown;
}

interface RawNextPrecondition {
  description?: unknown;
  /** 别名兜底：部分模型用 `desc`/`text` 表达前提描述。 */
  desc?: unknown;
  text?: unknown;
  status?: unknown;
  risk_level?: unknown;
  /** 别名兜底：部分模型用 `risk` 表达风险等级。 */
  risk?: unknown;
  related_action?: unknown;
  /** 别名兜底：部分模型用 `action` 表达对应执行动作。 */
  action?: unknown;
  proposedDefault?: unknown;
  confidenceScore?: unknown;
}

interface RawNextQuestion {
  text?: unknown;
  /** 别名兜底：部分模型用 `question` 表达问题文本。 */
  question?: unknown;
  targetPreconditionIndexes?: unknown;
  defaultOption?: unknown;
  isConvergenceSuggestion?: unknown;
}

interface RawNextOutput {
  preconditions?: unknown;
  phaseSaturated?: unknown;
  deferRemaining?: unknown;
  questions?: unknown;
}

interface RawSufficientOutput {
  objective?: unknown;
  /** 别名兜底：部分模型用 `goal` 表达任务目标。 */
  goal?: unknown;
  acceptanceTests?: unknown;
  primaryTargets?: unknown;
  suggestedWorkingDirHint?: unknown;
}

// ===========================================================================
// LlmClarifier —— 基于 LLM_Provider 的编排实现
// ===========================================================================

/** `LlmClarifier` 构造选项（均可注入，便于测试得到确定性行为）。 */
export interface ClarifierOptions {
  /** 澄清轮次软上限（R8.12），默认取 config 的 `maxRounds`。 */
  maxRounds?: number;
  /** 单轮提问数量上限（R8.4），默认取 config 的 `perRoundQuestionLimit`。 */
  perRoundQuestionLimit?: number;
  /** 顶层阶段过多阈值（R8.13），默认取 config 的 `topPhaseConvergenceThreshold`。 */
  topPhaseConvergenceThreshold?: number;
  /** id 生成器，默认 `randomUUID`（注入便于测试得到确定性 id）。 */
  idFactory?: () => string;
}

/**
 * `Clarifier` 的 LLM 实现：把 readiness / riskInjection / confidence 三纯函数串成
 * `begin` / `next` 主流程，并负责与 `LLM_Provider` 的交互。
 */
export class LlmClarifier implements Clarifier {
  private readonly provider: LLM_Provider;
  private readonly maxRounds: number;
  private readonly perRoundQuestionLimit: number;
  private readonly topPhaseConvergenceThreshold: number;
  private readonly idFactory: () => string;

  constructor(provider: LLM_Provider, options?: ClarifierOptions) {
    this.provider = provider;
    this.maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.perRoundQuestionLimit =
      options?.perRoundQuestionLimit ?? DEFAULT_PER_ROUND_QUESTION_LIMIT;
    this.topPhaseConvergenceThreshold =
      options?.topPhaseConvergenceThreshold ??
      DEFAULT_TOP_PHASE_CONVERGENCE_THRESHOLD;
    this.idFactory = options?.idFactory ?? randomUUID;
  }

  // -------------------------------------------------------------------------
  // begin：任务分解为不限数量的粗粒度逻辑阶段（R8.5）
  // -------------------------------------------------------------------------

  async begin(item: Awareness_Item, session: Session): Promise<ClarifierState> {
    const req: LlmRequest = {
      system: buildBeginSystemPrompt(),
      messages: [{ role: "user", content: buildBeginUserPrompt(item, session) }],
      jsonSchema: BEGIN_OUTPUT_SCHEMA,
      temperature: 0.3,
    };

    const text = await this.callLlm(req, "begin（任务分解）");
    const raw = parseClarifierJson(text, "begin（任务分解）") as RawBeginOutput;

    // 阶段数 = LLM 给出数，**绝不截断**（R8.5 / Property 8）。
    // 解析兜底：真实模型不严格遵守 schema 时，顶层阶段数组字段可能用 `stages` 而非 `phases`。
    const rawPhases = Array.isArray(raw.phases) ? raw.phases : raw.stages;
    const phases = this.normalizePhases(rawPhases);
    if (phases.length === 0) {
      throw new ClarifierError(
        "begin（任务分解）阶段：LLM 未产出任何有效逻辑阶段，无法初始化澄清会话。服务保持可继续运行。",
      );
    }

    // 一次只聚焦一个阶段：把 order 最小者设为 focused，其余维持 pending。
    const focused = [...phases].sort((a, b) => a.order - b.order)[0];
    focused.status = "focused";

    return {
      awarenessItemId: item.id,
      phases,
      preconditions: [],
      focusedPhaseId: focused.id,
      round: 0,
      maxRounds: this.maxRounds,
      perRoundQuestionLimit: this.perRoundQuestionLimit,
      topPhaseConvergenceThreshold: this.topPhaseConvergenceThreshold,
    };
  }

  // -------------------------------------------------------------------------
  // next：前提评估 → evaluateReadiness → 提问 / 推进阶段 / 充分 / 僵局
  // -------------------------------------------------------------------------

  async next(
    state: ClarifierState,
    lastAnswer?: UserAnswer,
  ): Promise<ClarifierStep> {
    // 不修改入参：在本地工作副本上推进（编排层/状态机负责持久化新状态）。
    const working: ClarifierState = {
      ...state,
      phases: state.phases.map((p) => ({ ...p })),
      preconditions: state.preconditions.map((p) => ({ ...p })),
    };

    // 1) 应用上一轮答复（接受默认值 → default_accepted；自由文本将喂给 LLM 历史）。
    if (lastAnswer) {
      this.applyAnswer(working, lastAnswer);
    }

    // 2) 一轮澄清。
    working.round += 1;

    // 3) 对当前 focused 阶段调 LLM 评估前提 + 候选提问，并做风险注入。
    const focusedPhase = working.phases.find(
      (p) => p.id === working.focusedPhaseId,
    );
    const llmNext = await this.evaluateFocusedPhase(working, lastAnswer);
    this.mergePreconditions(working, llmNext.preconditions);
    if (focusedPhase && llmNext.phaseSaturated) {
      // LLM 认为后续阶段可延后执行：标记其余 pending 阶段为 deferred（R8.6）。
      if (llmNext.deferRemaining) {
        for (const ph of working.phases) {
          if (ph.status === "pending") ph.status = "deferred";
        }
      }
    }

    // 4) 充分性判定（纯函数）。可能需要在「推进阶段」后重评，故用循环。
    return this.resolveStep(working, llmNext);
  }

  /**
   * 依据 `evaluateReadiness` 的判定推进：`advance_phase` 时切阶段并**重评**当前阶段
   * （对新阶段再跑一次 LLM），其余分支分别产出 questions / sufficient / impasse。
   */
  private async resolveStep(
    state: ClarifierState,
    llmNext: NextEvaluation,
  ): Promise<ClarifierStep> {
    let currentEval = llmNext;
    // 防止异常的无限循环：阶段数有限，最多推进阶段数次即收敛。
    const maxAdvances = state.phases.length + 1;

    for (let i = 0; i < maxAdvances; i++) {
      // 充分性判定用确定性默认验收测试合成器（readiness.ts 内置）；
      // 真正交付用的验收测试在 sufficient 分支由 LLM（schema c）产出，无效时回退到此处的合成结果。
      const readiness: Readiness = evaluateReadiness(state);

      switch (readiness.kind) {
        case "ask":
          return {
            kind: "questions",
            questions: this.buildQuestions(state, readiness, currentEval),
          };

        case "advance_phase": {
          // 切换聚焦阶段：旧阶段标 saturated，新阶段标 focused，再对新阶段重评。
          for (const ph of state.phases) {
            if (ph.id === state.focusedPhaseId) ph.status = "saturated";
            if (ph.id === readiness.to) ph.status = "focused";
          }
          state.focusedPhaseId = readiness.to;
          currentEval = await this.evaluateFocusedPhase(state, undefined);
          this.mergePreconditions(state, currentEval.preconditions);
          if (currentEval.phaseSaturated && currentEval.deferRemaining) {
            for (const ph of state.phases) {
              if (ph.status === "pending") ph.status = "deferred";
            }
          }
          continue;
        }

        case "sufficient":
          return {
            kind: "sufficient",
            taskFrame: await this.assembleTaskFrame(
              state,
              readiness.acceptanceTests,
            ),
          };

        case "impasse":
          return {
            kind: "impasse",
            summary: this.buildImpasse(state, readiness.unresolved),
          };
      }
    }

    // 理论上不可达：阶段有限。兜底为「全部饱和后无法构造验收测试」式的 ask。
    return { kind: "questions", questions: [] };
  }

  // -------------------------------------------------------------------------
  // 上一轮答复的应用（接受默认值 → default_accepted；自由文本交给 LLM 历史）
  // -------------------------------------------------------------------------

  /**
   * 把用户答复落到对应前提上（就地修改工作副本）：
   *  - `acceptedDefaultFor` 列出的前提 → `resolvedBy = "default_accepted"`，
   *    取其 `proposedDefault` 作为 `resolvedValue`，status 置 `known`（R8.3）。
   *  - 自由文本答复不在此处消解具体前提，而是经 `buildNextUserPrompt` 喂给 LLM，
   *    由下一次评估把相应前提更新为 `known`，再在 `evaluateFocusedPhase` 中归因为 `user_input`。
   */
  private applyAnswer(state: ClarifierState, answer: UserAnswer): void {
    for (const id of answer.acceptedDefaultFor ?? []) {
      const pc = state.preconditions.find((p) => p.id === id);
      if (!pc) continue;
      pc.resolvedBy = "default_accepted";
      pc.resolvedValue = pc.proposedDefault ?? pc.resolvedValue;
      pc.status = "known";
    }
  }

  // -------------------------------------------------------------------------
  // focused 阶段评估：调 LLM（schema b）→ 前提 + 风险注入 + 候选提问
  // -------------------------------------------------------------------------

  /**
   * 对当前聚焦阶段调用 LLM 评估执行前提与候选提问，并：
   *  - 为每个前提赋 `phaseId = focusedPhaseId`，按描述匹配既有前提以**保留稳定 id 与已消解信息**；
   *  - 经 `injectRiskAll`（7.2）做规则强制高危覆盖（规则优先于 LLM）；
   *  - 把候选问题的 1-based 序号翻译为前提内部 id；
   *  - 在用户本轮有自由文本答复、且某前提由非 known 转为 known 时，归因为 `user_input`。
   */
  private async evaluateFocusedPhase(
    state: ClarifierState,
    lastAnswer: UserAnswer | undefined,
  ): Promise<NextEvaluation> {
    const focusedPhase = state.phases.find(
      (p) => p.id === state.focusedPhaseId,
    );

    const req: LlmRequest = {
      system: buildNextSystemPrompt(),
      messages: [
        {
          role: "user",
          content: buildNextUserPrompt(state, focusedPhase, lastAnswer),
        },
      ],
      jsonSchema: NEXT_OUTPUT_SCHEMA,
      temperature: 0.3,
    };

    const text = await this.callLlm(req, "next（前提评估）");
    const raw = parseClarifierJson(text, "next（前提评估）") as RawNextOutput;

    const hadUserText = (lastAnswer?.text ?? "").trim().length > 0;
    const userText = (lastAnswer?.text ?? "").trim();

    // 既有焦点阶段前提：用于按描述匹配以保留 id 与已消解信息。
    const existingFocused = state.preconditions.filter(
      (p) => p.phaseId === state.focusedPhaseId,
    );

    const rawPreconditions = Array.isArray(raw.preconditions)
      ? raw.preconditions
      : [];

    // 序号（1-based）→ 前提 id 的映射，供候选问题翻译。
    const indexToId = new Map<number, string>();
    const preconditions: Execution_Precondition[] = [];

    rawPreconditions.forEach((candidate, idx) => {
      const built = this.toPrecondition(
        candidate,
        state.focusedPhaseId,
        existingFocused,
        hadUserText,
        userText,
      );
      if (built === null) return;
      preconditions.push(built);
      indexToId.set(idx + 1, built.id); // schema 约定序号从 1 开始
    });

    // 规则强制高危覆盖（规则优先于 LLM 常识，7.2）。
    const injected = injectRiskAll(preconditions);
    // injectRiskAll 仅改 risk_level，id 不变，indexToId 仍然有效。

    const candidateQuestions = this.toCandidateQuestions(
      raw.questions,
      indexToId,
    );

    return {
      preconditions: injected,
      phaseSaturated: raw.phaseSaturated === true,
      deferRemaining: raw.deferRemaining === true,
      candidateQuestions,
    };
  }

  /**
   * 把单个 LLM 原始前提转为 `Execution_Precondition`（缺关键字段则丢弃返回 null）。
   * 按描述匹配既有前提以保留 id / 已消解信息，并在合适时把消解归因为 user_input。
   */
  private toPrecondition(
    candidate: unknown,
    phaseId: string,
    existingFocused: Execution_Precondition[],
    hadUserText: boolean,
    userText: string,
  ): Execution_Precondition | null {
    if (typeof candidate !== "object" || candidate === null) return null;
    const obj = candidate as RawNextPrecondition;

    // 解析兜底（保持原字段优先）：description←description/desc/text；related_action←related_action/action。
    const description = pickFirstString(obj.description, obj.desc, obj.text);
    const relatedAction = pickFirstString(obj.related_action, obj.action);
    if (description.length === 0) return null;

    const status = normalizeStatus(obj.status);
    // risk_level←risk_level/risk（原字段优先）。
    const riskLevel = normalizeRisk(obj.risk_level ?? obj.risk);
    const proposedDefault =
      typeof obj.proposedDefault === "string" && obj.proposedDefault.trim().length > 0
        ? obj.proposedDefault.trim()
        : undefined;
    const confidenceScore = normalizeConfidenceScore(obj.confidenceScore);

    const prior = existingFocused.find((p) => p.description === description);
    const id = prior?.id ?? this.idFactory();

    const built: Execution_Precondition = {
      id,
      phaseId,
      description,
      status,
      risk_level: riskLevel,
      related_action: relatedAction,
    };
    if (proposedDefault !== undefined) built.proposedDefault = proposedDefault;
    if (confidenceScore !== undefined) built.confidenceScore = confidenceScore;

    // 保留既有消解信息（用户接受默认值 / 先前用户输入）。
    if (prior?.resolvedBy !== undefined) {
      built.resolvedBy = prior.resolvedBy;
      built.resolvedValue = prior.resolvedValue ?? built.proposedDefault;
      built.status = "known";
      return built;
    }

    // 本轮用户自由文本答复，使某前提由非 known 转为 known → 归因为 user_input。
    if (
      hadUserText &&
      status === "known" &&
      prior !== undefined &&
      prior.status !== "known"
    ) {
      built.resolvedBy = "user_input";
      built.resolvedValue = userText;
    }

    return built;
  }

  /** 把 LLM 候选问题（按 1-based 序号引用前提）翻译为内部候选问题（按前提 id 引用）。 */
  private toCandidateQuestions(
    rawQuestions: unknown,
    indexToId: Map<number, string>,
  ): CandidateQuestion[] {
    const arr = Array.isArray(rawQuestions) ? rawQuestions : [];
    const result: CandidateQuestion[] = [];

    for (const candidate of arr) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const obj = candidate as RawNextQuestion;
      // 解析兜底（原字段优先）：text←text/question。
      const text = pickFirstString(obj.text, obj.question);
      if (text.length === 0) continue;

      const indexes = Array.isArray(obj.targetPreconditionIndexes)
        ? obj.targetPreconditionIndexes
        : [];
      const targetPreconditionIds = indexes
        .filter((n): n is number => typeof n === "number")
        .map((n) => indexToId.get(n))
        .filter((id): id is string => typeof id === "string");

      const q: CandidateQuestion = { text, targetPreconditionIds };

      if (
        typeof obj.defaultOption === "object" &&
        obj.defaultOption !== null
      ) {
        const d = obj.defaultOption as { label?: unknown; value?: unknown };
        const value = typeof d.value === "string" ? d.value.trim() : "";
        if (value.length > 0) {
          q.defaultOption = {
            label: typeof d.label === "string" && d.label.trim().length > 0
              ? d.label.trim()
              : "使用默认值并继续",
            value,
          };
        }
      }
      if (obj.isConvergenceSuggestion === true) q.isConvergenceSuggestion = true;

      result.push(q);
    }
    return result;
  }

  /** 用焦点阶段的新前提替换 state.preconditions 中该阶段的旧前提（就地修改）。 */
  private mergePreconditions(
    state: ClarifierState,
    newOnes: Execution_Precondition[],
  ): void {
    const others = state.preconditions.filter(
      (p) => p.phaseId !== state.focusedPhaseId,
    );
    state.preconditions = [...others, ...newOnes];
  }

  // -------------------------------------------------------------------------
  // 提问生成（≤ 上限、低风险附默认值、范围过大附收敛建议、confidenceScore 排序）
  // -------------------------------------------------------------------------

  /**
   * 据 `evaluateReadiness` 的 `ask` 判定生成本轮澄清问题：
   *  - 为每个待消解前提生成一个问题（优先复用 LLM 文本，否则确定性合成）；
   *  - **同等风险下低 `confidenceScore` 优先**（不确定性越高越先问），低 confidence 时披露把握；
   *  - 仅剩低风险模糊前提时附明确默认值选项（R8.3 / Property 9）；
   *  - 顶层阶段数 > 阈值时前置恰好一个收敛建议问题（R8.13 / Property 12）；
   *  - 截断到 `perRoundQuestionLimit`（R8.4 / Property 8）。
   */
  private buildQuestions(
    state: ClarifierState,
    readiness: Extract<Readiness, { kind: "ask" }>,
    currentEval: NextEvaluation,
  ): ClarifyQuestion[] {
    const limit = state.perRoundQuestionLimit;
    const attachDefaults = readiness.attachDefaults === true;

    // 每个待消解前提一个问题（保证覆盖与默认值附带）。
    const perPc = readiness.focusOn.map((pc) => {
      const llmQ = currentEval.candidateQuestions.find(
        (q) =>
          q.isConvergenceSuggestion !== true &&
          q.targetPreconditionIds.includes(pc.id),
      );
      let text = (llmQ?.text ?? "").trim() || synthesizeQuestionText(pc);

      // confidenceScore 偏低时，在话术中显式披露不确定性（仅当 LLM 给出时）。
      if (
        typeof pc.confidenceScore === "number" &&
        pc.confidenceScore < CONFIDENCE_DISCLOSURE_THRESHOLD
      ) {
        const pct = Math.round(pc.confidenceScore * 100);
        text = `（说明：我对这一点只有约 ${pct}% 的把握）${text}`;
      }

      const question: ClarifyQuestion = {
        id: this.idFactory(),
        text,
        targetPreconditionIds: [pc.id],
      };

      // 仅剩低风险模糊前提时，附「使用明确默认值并继续」选项（R8.3 / Property 9）。
      if (attachDefaults && pc.risk_level === "low") {
        const value =
          (llmQ?.defaultOption?.value ?? "").trim() ||
          (pc.proposedDefault ?? "").trim() ||
          synthesizeDefaultValue(pc);
        question.defaultOption = {
          label: (llmQ?.defaultOption?.label ?? "").trim() || "使用默认值并继续",
          value,
          appliesTo: [pc.id],
        };
      }

      return { pc, question };
    });

    // 同等风险下低 confidenceScore 优先（高风险整体优先）。稳定排序，缺省 confidence 不改变顺序。
    perPc.sort((a, b) => {
      const rk = riskRank(b.pc.risk_level) - riskRank(a.pc.risk_level);
      if (rk !== 0) return rk;
      const ca = a.pc.confidenceScore;
      const cb = b.pc.confidenceScore;
      if (typeof ca === "number" && typeof cb === "number") return ca - cb;
      return 0; // 任一缺省 → 保持原有相对顺序（行为不变）
    });

    let questions: ClarifyQuestion[] = perPc.map((x) => x.question);

    // 意图不可测试（无具体前提可问）：补一个针对成功标准的澄清问题。
    if (questions.length === 0 && readiness.reason === "intent_not_testable") {
      questions = [
        {
          id: this.idFactory(),
          text: "我还无法据当前理解构造出可检验的成功标准。这个任务做到什么程度算成功？请给出一个可事后检验的判断方式。",
          targetPreconditionIds: [],
        },
      ];
    }

    // 范围过大主动收敛（R8.13 / Property 12）：顶层阶段数 > 阈值 → 前置恰好一个收敛建议。
    if (state.phases.length > state.topPhaseConvergenceThreshold) {
      questions = [this.buildConvergenceQuestion(state), ...questions];
    }

    // 单轮提问上限（R8.4 / Property 8）。阶段数不在此截断（在 begin 中保全）。
    return questions.slice(0, limit);
  }

  /** 构造一个收敛聚焦建议问题（isConvergenceSuggestion=true，R8.13）。 */
  private buildConvergenceQuestion(state: ClarifierState): ClarifyQuestion {
    return {
      id: this.idFactory(),
      text:
        `这个任务被分解出 ${state.phases.length} 个逻辑阶段，范围可能偏大。` +
        "建议先收敛聚焦到其中最关键、最紧迫的部分，把范围缩小后再继续——可以吗？",
      targetPreconditionIds: [],
      isConvergenceSuggestion: true,
    };
  }

  // -------------------------------------------------------------------------
  // sufficient：组装 Task_Frame（objective / acceptanceTests / primaryTargets / confidence）
  // -------------------------------------------------------------------------

  /**
   * 信息充分时组装 `Task_Frame`：
   *  - 经 LLM（schema c）产出 objective / acceptanceTests（checkMethod 须可机检）/ primaryTargets；
   *  - LLM 验收测试无效时，回退到 `evaluateReadiness` 给出的确定性验收测试，保证非空（R8.9）；
   *  - `confidence` 由 `generateConfidenceStatement`（7.7）从 `resolvedBy` 机械生成，不依赖 LLM。
   */
  private async assembleTaskFrame(
    state: ClarifierState,
    fallbackTests: Acceptance_Test[],
  ): Promise<Task_Frame> {
    const req: LlmRequest = {
      system: buildSufficientSystemPrompt(),
      messages: [
        { role: "user", content: buildSufficientUserPrompt(state) },
      ],
      jsonSchema: SUFFICIENT_OUTPUT_SCHEMA,
      temperature: 0.3,
    };

    const text = await this.callLlm(req, "sufficient（Task_Frame 组装）");
    const raw = parseClarifierJson(
      text,
      "sufficient（Task_Frame 组装）",
    ) as RawSufficientOutput;

    const objective =
      pickFirstString(raw.objective, raw.goal).length > 0
        ? pickFirstString(raw.objective, raw.goal)
        : "（未明确陈述目标）";

    const llmTests = this.normalizeAcceptanceTests(raw.acceptanceTests);
    // R8.9：Acceptance_Test 必须非空——LLM 未给出有效项则回退到确定性合成结果。
    const acceptanceTests = llmTests.length > 0 ? llmTests : fallbackTests;

    const primaryTargets = Array.isArray(raw.primaryTargets)
      ? raw.primaryTargets
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];

    const suggestedWorkingDirHint =
      typeof raw.suggestedWorkingDirHint === "string" &&
      raw.suggestedWorkingDirHint.trim().length > 0
        ? raw.suggestedWorkingDirHint.trim()
        : undefined;

    // 已消解前提：known 或带 resolvedBy。
    const resolvedPreconditions = state.preconditions.filter(
      (p) => p.status === "known" || p.resolvedBy !== undefined,
    );

    const frame: Task_Frame = {
      awarenessItemId: state.awarenessItemId,
      objective,
      phases: state.phases.map((p) => ({ ...p })),
      resolvedPreconditions,
      // R8.8：Confidence_Statement 由 resolvedBy 机械生成（7.7），不依赖 LLM。
      confidence: generateConfidenceStatement(resolvedPreconditions),
      acceptanceTests,
    };
    if (primaryTargets.length > 0) frame.primaryTargets = primaryTargets;
    if (suggestedWorkingDirHint !== undefined) {
      frame.suggestedWorkingDirHint = suggestedWorkingDirHint;
    }
    return frame;
  }

  /** 规整 LLM 验收测试：丢弃缺 description/checkMethod 的项，赋稳定 id。 */
  private normalizeAcceptanceTests(rawTests: unknown): Acceptance_Test[] {
    const arr = Array.isArray(rawTests) ? rawTests : [];
    const result: Acceptance_Test[] = [];
    for (const candidate of arr) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const obj = candidate as {
        description?: unknown;
        desc?: unknown;
        checkMethod?: unknown;
        check?: unknown;
        method?: unknown;
      };
      // 解析兜底（原字段优先）：description←description/desc；checkMethod←checkMethod/check/method。
      const description = pickFirstString(obj.description, obj.desc);
      const checkMethod = pickFirstString(obj.checkMethod, obj.check, obj.method);
      if (description.length === 0 || checkMethod.length === 0) continue;
      result.push({ id: this.idFactory(), description, checkMethod });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // impasse：软上限兜底（R8.12）
  // -------------------------------------------------------------------------

  /** 组装 `ImpasseSummary`：当前理解 + 未消解高风险 + 风险说明 + 固定三选一。 */
  private buildImpasse(
    state: ClarifierState,
    unresolved: Execution_Precondition[],
  ): ImpasseSummary {
    const focusedPhase = state.phases.find(
      (p) => p.id === state.focusedPhaseId,
    );
    const resolvedCount = state.preconditions.filter(
      (p) => p.status === "known" || p.resolvedBy !== undefined,
    ).length;

    const currentUnderstanding =
      `已澄清 ${state.round} 轮，当前聚焦阶段「${focusedPhase?.title ?? "未知"}」，` +
      `已消解 ${resolvedCount} 项执行前提，但仍有 ${unresolved.length} 项高风险前提未能消解。`;

    const risksExplained = unresolved
      .map(
        (p) =>
          `- 「${p.description}」对应高风险动作「${p.related_action}」，` +
          "在未消解前贸然执行可能造成不可逆后果。",
      )
      .join("\n");

    return {
      currentUnderstanding,
      unresolvedHighRisk: unresolved,
      risksExplained,
      options: ["supplement", "force_execute", "abandon"],
    };
  }

  // -------------------------------------------------------------------------
  // 通用：阶段规整 + LLM 调用
  // -------------------------------------------------------------------------

  /** 把 LLM 原始 phases 规整为 `LogicalPhase[]`（**不截断**，R8.5 / Property 8）。 */
  private normalizePhases(rawPhases: unknown): LogicalPhase[] {
    const arr = Array.isArray(rawPhases) ? rawPhases : [];
    const phases: LogicalPhase[] = [];
    arr.forEach((candidate, idx) => {
      if (typeof candidate !== "object" || candidate === null) return;
      const obj = candidate as { title?: unknown; name?: unknown; order?: unknown };
      // 解析兜底：标题字段接受 `title`（schema 规范）或别名 `name`（部分真实模型使用）。
      const title = pickFirstString(obj.title, obj.name);
      if (title.length === 0) return;
      const order =
        typeof obj.order === "number" && Number.isFinite(obj.order)
          ? obj.order
          : idx + 1;
      phases.push({
        id: this.idFactory(),
        title,
        order,
        status: "pending",
      });
    });
    return phases;
  }

  /** 调用 `LLM_Provider.complete`，失败时包装为描述性 `ClarifierError`（服务保持运行）。 */
  private async callLlm(req: LlmRequest, stage: string): Promise<string> {
    try {
      const res = await this.provider.complete(req);
      return res.text;
    } catch (cause) {
      throw new ClarifierError(
        `澄清 ${stage} 阶段调用 LLM 失败：${describeError(cause)}。服务保持可继续运行。`,
        { cause },
      );
    }
  }
}

// ===========================================================================
// 内部编排类型
// ===========================================================================

/** focused 阶段一次 LLM 评估的规整结果（前提已注入风险、问题已映射到前提 id）。 */
interface NextEvaluation {
  preconditions: Execution_Precondition[];
  phaseSaturated: boolean;
  deferRemaining: boolean;
  candidateQuestions: CandidateQuestion[];
}

/** 编排内部的候选问题（目标以前提 id 表达）。 */
interface CandidateQuestion {
  text: string;
  targetPreconditionIds: string[];
  defaultOption?: { label: string; value: string };
  isConvergenceSuggestion?: boolean;
}

// ===========================================================================
// 纯辅助函数
// ===========================================================================

/** 风险等级排序权重（high 最大，用于"高风险优先提问"）。 */
function riskRank(level: RiskLevel): number {
  switch (level) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

/** 从一组候选值中取第一个非空字符串（trim 后），用于解析别名兜底（按传入顺序优先）。 */
function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "";
}

/** 规整 LLM 给出的 status，非法值退化为 `ambiguous`（宁可多问也不漏问）。 */
function normalizeStatus(value: unknown): PreconditionStatus {
  if (value === "known" || value === "ambiguous" || value === "unknown") {
    return value;
  }
  return "ambiguous";
}

/** 规整 LLM 给出的 risk_level，非法值退化为 `medium`（保守，最终仍经规则层注入）。 */
function normalizeRisk(value: unknown): RiskLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

/** 规整 confidenceScore：仅接受 [0,1] 内的有限数，否则视为未给出（可选增强项）。 */
function normalizeConfidenceScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/** 为某前提确定性合成一个澄清问题文本（LLM 未给出针对性问题时的兜底）。 */
function synthesizeQuestionText(pc: Execution_Precondition): string {
  return `关于「${pc.description}」（涉及动作：${pc.related_action || "未明确"}），能否进一步明确？`;
}

/** 为低风险前提确定性合成一个默认值（LLM/前提均未给出 proposedDefault 时的兜底）。 */
function synthesizeDefaultValue(pc: Execution_Precondition): string {
  return `按常规默认处理「${pc.description}」`;
}

/** 把未知错误对象转为可读字符串（用于描述性错误信息）。 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// ===========================================================================
// JSON 解析（容错：直接解析 / 剥离 ``` 围栏 / 截取首尾大括号）
// ===========================================================================

/**
 * 解析 LLM 文本为对象。容错：原文直接 `JSON.parse`；失败则尝试剥离 ```json 围栏 /
 * 截取首个 `{...}` 块再解析；仍失败抛描述性 `ClarifierError`（服务保持运行）。
 */
export function parseClarifierJson(text: string, stage: string): object {
  for (const candidate of collectJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as object;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new ClarifierError(
    `澄清 ${stage} 阶段无法解析 LLM 返回的 JSON 输出（不符合预期结构）。服务保持可继续运行。`,
  );
}

/** 从文本收集可能的 JSON 串候选：原文、去 markdown 围栏、首尾大括号截取。 */
function collectJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && typeof fenceMatch[1] === "string") {
    candidates.push(fenceMatch[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  return candidates;
}
