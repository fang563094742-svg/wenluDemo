/**
 * proactive-awareness-demo —— Orchestrator / Session 数据结构与单例（任务 14.1）。
 *
 * 职责（仅限本任务）：
 *  - 定义 `SessionState` 状态枚举（与 design.md「Session 状态机」一致）。
 *  - 定义贯穿闭环的 `Session` 聚合根，以及 `ToolInvocation` / `ExecutionResult`。
 *  - 提供 `Session` 单例（R18.3 单用户）：`createInitialSession` 工厂 + `getSession`/`resetSession` 访问器。
 *
 * 不变量（本任务保证的部分）：
 *  - 所有布尔门 —— `understandingConfirmed` / `scopeConfirmed` / `executionConfirmed`
 *    / `backupSizeConfirmed` / `accepted` —— 初始一律为 `false`，
 *    只能由对应的用户 REST 动作置 `true`，构成不可绕过的状态门。
 *  - 新建会话初始状态为 `SessionState.Idle`。
 *
 * 范围说明：本文件只定义 Session 数据结构与单例。**状态转移逻辑（状态机、状态门强制）
 * 属任务 14.2（`stateMachine.ts`）**，此处不实现。
 *
 * 自洽类型说明：本任务位于依赖图 wave 1，与 scanner/llm/clarifier/scope/backup/executor/
 * delivery 各模块的类型定义任务（4.1/5.1/7.1/9.1/10.x/11.1/13.1）平行，尚无法跨模块导入。
 * 因此 `Session` 引用到的跨模块类型在本文件内**自洽定义**（faithful 占位，忠实于 design.md），
 * 与 executor 等模块未来可能出现的同名类型（如 `ExecutionResult` / `ToolResult`）的重叠，
 * 由编排层任务 **14.6** 负责对齐统一。
 *
 * _Requirements: 18.3_
 */

import { randomUUID } from "node:crypto";

// ===========================================================================
// SessionState —— 会话状态枚举（与 design.md「Session 状态机」逐项一致）
// ===========================================================================

/**
 * 闭环会话状态。整条链路顺序：
 * 扫描 → 分析 → 察觉呈现 → 澄清定面 → 定界 → 最终确认 → 备份 → 执行 → 交付验收。
 */
export enum SessionState {
  Idle = "idle",
  Scanning = "scanning",
  Analyzing = "analyzing",
  AwarenessPresented = "awareness_presented",
  Clarifying = "clarifying",
  /** 已产出 Task_Frame，等待"基于以上理解，我可以开始执行吗"的肯定确认（R8.11）。 */
  AwaitingUnderstanding = "awaiting_understanding",
  /** R8.12 软上限兜底，等待用户三选一（补充/强制执行/放弃）。 */
  Impasse = "impasse",
  ScopeConfirm = "scope_confirm",
  ReadyConfirm = "ready_confirm",
  BackingUp = "backing_up",
  /** R11 备份体积超阈值，等待用户二次确认。 */
  AwaitingBackupConfirm = "awaiting_backup_confirm",
  Executing = "executing",
  /** 高危确认或阻断性提问期间暂停。 */
  BlockedOnUser = "blocked_on_user",
  /** R12.5/R15.1 执行完成后强制运行验收测试。 */
  Verifying = "verifying",
  Delivered = "delivered",
  Accepted = "accepted",
  Error = "error",
}

// ===========================================================================
// 跨模块占位类型（faithful 占位，忠实于 design.md；最终对齐见任务 14.6）
//
// 下列类型在各自的「类型定义任务」中是权威来源（scanner/llm/clarifier/scope/
// backup/executor/delivery）。本任务与它们平行，无法跨模块导入，故在此自洽定义，
// 以便 `Session` 聚合根字段类型完整、可独立通过类型检查。
// ===========================================================================

// --- 扫描层（权威：scanner/types.ts，任务 4.1） -----------------------------

/** 文件元信息（仅元信息，绝不含正文）。 */
export interface FileMeta {
  name: string;
  path: string;
  mtime: string; // ISO8601
  sizeBytes: number;
  ext: string;
}

/** 近期 git 只读活动。 */
export interface GitActivity {
  repoPath: string;
  recentCommits: { hash: string; message: string; date: string }[];
  changedFiles: string[];
  currentBranch: string;
}

/** 当前在用 App。 */
export interface AppActivity {
  appName: string;
  bundleId?: string;
}

/** 精选后的单条扫描摘要项。 */
export interface ScanSummaryItem {
  kind: "file" | "git" | "app" | "calendar" | "clipboard" | "window";
  score: number;
  file?: FileMeta;
  git?: GitActivity;
  app?: AppActivity;
  calendar?: { title: string; startDate: string; endDate: string; calendarName?: string };
  clipboard?: { preview: string; fullLength: number; capturedAt: string };
  window?: { appName: string; windowTitle: string; capturedAt: string };
}

/** 扫描摘要（已是 Top N、已应用排除红线；仅 Summary 外传）。 */
export interface Scan_Summary {
  scannedAt: string; // ISO8601
  platform: string;
  recentDays: number;
  items: ScanSummaryItem[];
}

// --- 分析层（权威：analyzer/analyzer.ts，任务 6.1） -------------------------

/** 主动察觉条目（推断出的任务/问题 + 证据）。 */
export interface Awareness_Item {
  id: string;
  title: string;
  rationale: string;
  evidence: string[];
}

// --- Clarifier（权威：clarifier/types.ts，任务 7.1） ------------------------

/** 任务被分解出的粗粒度逻辑阶段（数量不设硬上限）。 */
export interface LogicalPhase {
  id: string;
  title: string;
  order: number;
  status: "pending" | "focused" | "saturated" | "deferred";
}

export type PreconditionStatus = "known" | "ambiguous" | "unknown";
export type RiskLevel = "low" | "medium" | "high";

/** 执行前提：执行某阶段所需成立的条件。 */
export interface Execution_Precondition {
  id: string;
  phaseId: string;
  description: string;
  status: PreconditionStatus;
  risk_level: RiskLevel;
  related_action: string;
  proposedDefault?: string;
  /** 0-1，LLM 自评置信度（可选，非 MVP 阻塞项）。 */
  confidenceScore?: number;
  resolvedBy?: "user_input" | "default_accepted";
  resolvedValue?: string;
}

/** 单条澄清问题。 */
export interface ClarifyQuestion {
  id: string;
  text: string;
  targetPreconditionIds: string[];
  defaultOption?: { label: string; value: string; appliesTo: string[] };
  isConvergenceSuggestion?: boolean;
}

/** 用户对某条澄清问题的答复。 */
export interface UserAnswer {
  questionId: string;
  text?: string;
  acceptedDefaultFor?: string[];
}

/** 澄清会话状态。 */
export interface ClarifierState {
  awarenessItemId: string;
  phases: LogicalPhase[];
  preconditions: Execution_Precondition[];
  focusedPhaseId: string;
  round: number;
  maxRounds: number;
  perRoundQuestionLimit: number;
  topPhaseConvergenceThreshold: number;
}

/** 透明置信度声明（R8.8）。 */
export interface Confidence_Statement {
  basedOnUserInput: { precondition: string; value: string }[];
  basedOnDefaultAssumption: { precondition: string; value: string }[];
}

/** 可事后检验的成功标准（R8.9）。 */
export interface Acceptance_Test {
  id: string;
  description: string;
  checkMethod: string;
}

/** 澄清充分后产出的任务面（Task_Frame）。 */
export interface Task_Frame {
  awarenessItemId: string;
  objective: string;
  phases: LogicalPhase[];
  resolvedPreconditions: Execution_Precondition[];
  confidence: Confidence_Statement;
  acceptanceTests: Acceptance_Test[];
  suggestedWorkingDirHint?: string;
  /** 任务主要操作对象（R12.5），供 Executor 动作目标相关性校验使用。 */
  primaryTargets?: string[];
}

// --- 定界（权威：scope/scopeResolver.ts，任务 9.1） -------------------------

/** 落定后的工作目录（Executor sandbox 根）。 */
export interface WorkingDirectory {
  rootAbsPath: string;
}

// --- 备份（权威：backup/backupManager.ts，任务 10.x） -----------------------

/** 备份前体积估算（R11）。 */
export interface SizeEstimate {
  totalBytes: number;
  fileCount: number;
  exceededThreshold: boolean;
  thresholdBytes: number;
}

/** 备份句柄（含可恢复信息，R11.3）。 */
export interface BackupHandle {
  strategy: "git-commit" | "git-stash" | "file-snapshot";
  workingDirRoot: string;
  createdAt: string;
  gitRef?: string;
  snapshotPath?: string;
  rollbackInstruction: string;
}

// --- 执行 / 交付（权威：executor/types.ts、delivery/*，任务 11.1/13.x） -----

/** 单个工具调用结果（占位；executor 模块为权威，14.6 对齐）。 */
export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** 验收测试结果（R12.5/R15）。 */
export interface AcceptanceTestResult {
  testId: string;
  description: string;
  checkMethod: string;
  passed: boolean;
  detail: string;
}

/** 交付报告（含证据与失败标记）。 */
export interface Delivery_Report {
  summary: string;
  fileDiffs: { path: string; diff: string }[];
  commandOutputs: { command: string; output: string }[];
  acceptanceTestResults: AcceptanceTestResult[];
  /** = acceptanceTestResults.some(r => !r.passed)。 */
  hasFailures: boolean;
}

// ===========================================================================
// ToolInvocation / ExecutionResult —— 执行循环产物（本文件自洽定义）
// ===========================================================================

/**
 * 一次工具调用的完整记录（执行循环逐步追加到 `Session.executionLog`）。
 *
 * 注：与 executor 模块（任务 11.1 `executor/types.ts`）未来可能出现的同名结构存在
 * 重叠，本任务内自洽定义即可，最终对齐由编排层任务 14.6 负责。
 */
export interface ToolInvocation {
  /** 本次工具调用（工具名 + 参数）。 */
  tc: { name: string; arguments: Record<string, unknown> };
  /** 工具执行结果。 */
  result: ToolResult;
  /** 越界被拦截 / 符号链接逃逸被阻止。 */
  blocked?: boolean;
  /** 高危动作经用户确认放行。 */
  riskConfirmed?: boolean;
}

/**
 * Executor 一次 `runLoop` 的整体结果。
 *
 * 注：与 executor 模块（任务 11.1）未来的同名结构存在重叠，本任务内自洽定义即可，
 * 最终对齐由编排层任务 14.6 负责。
 */
export interface ExecutionResult {
  status: "completed" | "max_steps_reached" | "aborted";
  log: ToolInvocation[];
  finalText?: string;
}

// ===========================================================================
// Session —— 贯穿闭环的聚合根（R18.3 单例）
// ===========================================================================

/**
 * 单 `Session` 聚合根，由 Orchestrator 持有并驱动状态转移（状态转移逻辑见任务 14.2）。
 *
 * 布尔门不变量：`understandingConfirmed` / `scopeConfirmed` / `executionConfirmed`
 * / `backupSizeConfirmed` / `accepted` 初始一律 `false`，只能由对应用户 REST 动作置 `true`。
 */
export interface Session {
  id: string;
  state: SessionState;

  // 扫描 / 分析产物
  scanSummary?: Scan_Summary;
  awarenessItems?: Awareness_Item[];
  acceptedItemId?: string;

  // 澄清产物
  clarifierState?: ClarifierState;
  taskFrame?: Task_Frame;
  /** R8.11 用户最终确认门（"我可以开始执行吗"）。默认 false。 */
  understandingConfirmed: boolean;

  // 定界 / 确认 / 备份
  workingDir?: WorkingDirectory;
  /** R9.4 Working_Directory 经用户确认门。默认 false。 */
  scopeConfirmed: boolean;
  /** R10.2 用户"开始执行"确认门。默认 false。 */
  executionConfirmed: boolean;
  /** R11 备份前体积估算（超阈值触发二次确认）。 */
  backupSizeEstimate?: SizeEstimate;
  /** R11 体积超阈值时用户二次确认门。默认 false。 */
  backupSizeConfirmed: boolean;
  backup?: BackupHandle;

  // 执行 / 交付
  executionLog?: ToolInvocation[];
  /** R12.5/R15 verifying 阶段产物。 */
  acceptanceTestResults?: AcceptanceTestResult[];
  deliveryReport?: Delivery_Report;
  /** R15.4 仅用户点击"确认完成"置 true。默认 false。 */
  accepted: boolean;

  // 错误（非致命，服务保持运行）
  lastError?: { code: string; message: string };

  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
}

// ===========================================================================
// 单例工厂与访问器（R18.3 单用户，全局一个会话状态机）
// ===========================================================================

/**
 * 构造一个处于初始状态的新会话：
 *  - 状态为 `SessionState.Idle`；
 *  - 所有布尔门一律 `false`（不可绕过的状态门起点）。
 *
 * @param id 可选会话 id；默认随机 UUID。
 */
export function createInitialSession(id: string = randomUUID()): Session {
  const now = new Date().toISOString();
  return {
    id,
    state: SessionState.Idle,
    understandingConfirmed: false,
    scopeConfirmed: false,
    executionConfirmed: false,
    backupSizeConfirmed: false,
    accepted: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 进程级单例会话（R18.3 单用户，全局唯一）。 */
let singletonSession: Session = createInitialSession();

/** 获取全局单例会话。 */
export function getSession(): Session {
  return singletonSession;
}

/**
 * 重置全局单例会话为初始状态（用于"新一轮闭环"或测试隔离）。
 * @returns 重置后的新会话实例。
 */
export function resetSession(): Session {
  singletonSession = createInitialSession();
  return singletonSession;
}
