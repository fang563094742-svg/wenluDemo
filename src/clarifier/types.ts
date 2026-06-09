/**
 * Clarifier 充分性判定层的共享类型（R8 核心）。
 *
 * 本文件只定义类型/接口，不含运行时逻辑，供以下任务复用：
 *  - 7.2 riskInjection（风险注入）
 *  - 7.3 readiness（evaluateReadiness 纯函数，返回 Readiness）
 *  - 7.7 confidence（Confidence_Statement 机械生成）
 *  - 7.9 clarifier 编排（begin/next，产出 Task_Frame / ImpasseSummary）
 *  - 11.8 hasMaterializedRelevantActions（消费 Task_Frame.primaryTargets）
 *
 * 设计依据：design.md「Clarifier 算法详解」之「数据类型」与「就绪判定伪代码」。
 *
 * _Requirements: 8.5, 8.8, 8.9, 12.5_
 */

/** 执行前提的已知程度。 */
export type PreconditionStatus = "known" | "ambiguous" | "unknown";

/**
 * 执行前提的风险等级。由其对应执行动作的不可逆性与风险决定，
 * 经「风险注入」(7.2) 判定，规则强制高危优先于 LLM 常识。
 */
export type RiskLevel = "low" | "medium" | "high";

/**
 * 任务被分解出的粗粒度逻辑阶段。
 * 数量不设硬上限（R8.5）——Clarifier 一次只 focused 一个阶段，
 * 消解其高风险模糊点直至「阶段饱和」再过渡到下一阶段。
 */
export interface LogicalPhase {
  id: string;
  /** 如 "分析现状" / "设计方案" / "实现改动" / "验证结果"。 */
  title: string;
  order: number;
  status: "pending" | "focused" | "saturated" | "deferred";
}

/**
 * 执行前提：执行某阶段所需成立的条件（R8 / Glossary）。
 * 例如「操作对象的具体路径」「重构后对外接口是否保持兼容」。
 */
export interface Execution_Precondition {
  id: string;
  /** 归属逻辑阶段。 */
  phaseId: string;
  description: string;
  /** 已知 / 模糊 / 未知。 */
  status: PreconditionStatus;
  /** 由 related_action 的不可逆性与风险决定。 */
  risk_level: RiskLevel;
  /** 该前提对应的执行动作描述。 */
  related_action: string;
  /** 低/中风险模糊项的合理默认值（明确给出）。 */
  proposedDefault?: string;
  /**
   * 不确定性数值化（锦上添花，**非 MVP 阻塞项**）：LLM 对该前提状态判断的
   * 自评置信度（0-1），由 LLM 在评估前提 status/risk_level 时同步生成。用途：
   *  - 提问优先级：同等风险下低 confidenceScore 的前提优先提问（越不确定越先问）；
   *  - 透明披露：可在 Confidence_Statement / 澄清话术中显式披露（如"我只有 60% 的把握"）。
   * LLM 不支持/未给出时该字段缺省，逻辑退化为仅按 risk_level 与 status 判定（用途见 7.9）。
   */
  confidenceScore?: number;
  /** 消解来源，喂给 Confidence_Statement 生成（7.7）。 */
  resolvedBy?: "user_input" | "default_accepted";
  resolvedValue?: string;
}

/** 单个澄清问题。 */
export interface ClarifyQuestion {
  id: string;
  text: string;
  targetPreconditionIds: string[];
  /** 低风险模糊前提提问时附带的"使用默认值并继续"选项（R8.3）。 */
  defaultOption?: { label: string; value: string; appliesTo: string[] };
  /** 范围过大时的收敛聚焦建议（R8.13）。 */
  isConvergenceSuggestion?: boolean;
}

/** 用户对某个澄清问题的答复。 */
export interface UserAnswer {
  questionId: string;
  text?: string;
  /** 用户接受默认值的前提 id 列表。 */
  acceptedDefaultFor?: string[];
}

/** 澄清会话的可变状态。 */
export interface ClarifierState {
  awarenessItemId: string;
  phases: LogicalPhase[];
  preconditions: Execution_Precondition[];
  focusedPhaseId: string;
  /** 已进行轮次。 */
  round: number;
  /** 软上限，默认 8（R8.12）。 */
  maxRounds: number;
  /** 单轮提问上限，默认 3（R8.4）。 */
  perRoundQuestionLimit: number;
  /** 顶层阶段过多阈值，默认 6（R8.13）。 */
  topPhaseConvergenceThreshold: number;
}

/**
 * 置信度说明（R8.8）：随 Task_Frame 一并产出，
 * 区分 Task_Frame 中哪些内容基于用户输入、哪些基于默认假设。
 */
export interface Confidence_Statement {
  basedOnUserInput: { precondition: string; value: string }[];
  basedOnDefaultAssumption: { precondition: string; value: string }[];
}

/**
 * 验收测试（R8.9）：可在任务执行后用于检验任务是否达成预期的、
 * 具体且可检验的成功标准。checkMethod 必须是可由命令/程序自动检验的方式
 * （供 Delivery_Verifier.runAcceptanceTests 逐条执行）。
 */
export interface Acceptance_Test {
  id: string;
  /** 可事后检验的成功标准。 */
  description: string;
  /** 如何检验（命令退出码 / 文件内容断言 / HTTP 响应码 / diff 断言）。 */
  checkMethod: string;
}

/**
 * 经澄清整理出的结构化任务描述（"面"），可支撑执行，
 * 并附带 Confidence_Statement（R8.8）与 Acceptance_Test（R8.9）。
 */
export interface Task_Frame {
  awarenessItemId: string;
  objective: string;
  phases: LogicalPhase[];
  resolvedPreconditions: Execution_Precondition[];
  /** R8.8：区分用户输入 vs 默认假设。 */
  confidence: Confidence_Statement;
  /** R8.9：非空，供事后检验任务是否达成预期。 */
  acceptanceTests: Acceptance_Test[];
  suggestedWorkingDirHint?: string;
  /**
   * 任务主要操作对象（R12.5）：任务真正要改动的文件路径/目录/项目名。
   * 由 Clarifier 在 sufficient 阶段从已消解前提中提取并填充。
   * 供 Executor 的「动作目标相关性校验」hasMaterializedRelevantActions（任务 11.8）使用，
   * 防止 LLM 用大量无关动作伪造"已落地"。
   * 可为空——无明确目标时退化为仅校验"是否有任一落地动作"。
   */
  primaryTargets?: string[];
}

/**
 * 软上限兜底（R8.12）：达到最大澄清轮次后仍存在未消解的高风险前提时，
 * 汇总当前理解、缺失信息与风险，请用户三选一。
 */
export interface ImpasseSummary {
  currentUnderstanding: string;
  unresolvedHighRisk: Execution_Precondition[];
  risksExplained: string;
  /** 三选一：补充信息 / 高风险下强制执行 / 放弃任务。 */
  options: ["supplement", "force_execute", "abandon"];
}

/**
 * evaluateReadiness（7.3 纯函数）的返回类型：当前充分性判定的下一步动作。
 * 不含「用户最终确认」——那是状态机的状态门（R8.11），不在纯函数判定范围内。
 * 依据 design.md「就绪判定伪代码」的返回分支整理为判别联合。
 */
export type Readiness =
  /** 存在需继续提问的模糊前提（高风险一阶门槛，或仅剩中/低风险待消解）。 */
  | {
      kind: "ask";
      focusOn: Execution_Precondition[];
      /** 仅剩低风险模糊前提时附默认值选项（R8.3）。 */
      attachDefaults?: boolean;
      /** 特殊原因，如意图无法构造验收测试（intent_not_testable）。 */
      reason?: string;
    }
  /** 当前阶段饱和，过渡到下一个非 deferred 阶段。 */
  | { kind: "advance_phase"; to: string }
  /** 满足充分性门槛，可产出 Task_Frame 交由用户最终确认。 */
  | { kind: "sufficient"; acceptanceTests: Acceptance_Test[] }
  /** 软上限兜底，仍有未消解的高风险前提（R8.12）。 */
  | { kind: "impasse"; unresolved: Execution_Precondition[] };
