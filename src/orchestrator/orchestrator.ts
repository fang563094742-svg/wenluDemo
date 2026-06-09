/**
 * proactive-awareness-demo —— Orchestrator 闭环编排（任务 14.6）。
 *
 * 设计依据：design.md「Architecture → 闭环主信号流 / Session 状态机」「Error Handling」。
 *
 * 职责（仅限本任务）：
 *  - 把已实现的各管线模块（scanner / analyzer / presenter / clarifier / scope /
 *    backup / executor / delivery）**接线成一个可运行的闭环**，由
 *    `stateMachine.transition` 推进 `Session` 走完整链路：
 *      扫描 → 分析 → 察觉呈现 → 澄清定面 → 定界 → 最终确认 → 备份 → 执行 → 交付验收。
 *  - 各模块**经接口/依赖注入**（`OrchestratorDeps`），编排层不 `new` 任何具体实现，
 *    便于测试与可插拔（R6 / R17.3）。三大注册表/具体实现的装配属 composition root
 *    （任务 17.1），不在此处。
 *  - **非致命错误**统一转入 `session.lastError` 并经 `OrchestratorNotifier`（SSE/回调）
 *    通知 UI，**进程绝不崩溃、服务保持运行**（R1.5/R1.6/R5.5/R5.6）；仅"备份失败"会
 *    中止本次执行（转 `error`，绝不进入 `executing`，R11.2）。
 *  - 执行阶段把 Executor 的 `ExecutionHooks`（`confirmHighRisk` / `askUser` /
 *    `emitProgress`）**桥接到编排层**：高危确认与阻断性提问采用「暂停—恢复」机制
 *    （挂起一个 deferred，转 `blocked_on_user`，待对应 REST 动作恢复并 `→ executing`），
 *    `emitProgress` 转发为 `execution-progress` 通知（R12.5/R13/R14）。
 *
 * 单用户单会话（R18.3）：本编排器持有唯一的 `Session` 实例并以**不可变转移**
 * （`transition` 返回新对象）替换之，是会话状态的单一拥有者。
 *
 * 状态门强制不在本模块重复实现——所有状态门由 `stateMachine.transition` 把守
 * （执行前置门 / 备份体积二次确认门 / verifying 强制验收门 / 验收门）；本模块只负责
 * 「在合适的时机施加合法事件 + 接线真实模块 + 桥接交互」。
 *
 * _Requirements: 1.4, 1.5, 1.6, 5.5, 5.6, 9.4, 10.3, 15.4_
 */

import { homedir } from "node:os";

import { SessionState, createInitialSession } from "./session.js";
import type { Session } from "./session.js";
import { transition } from "./stateMachine.js";
import type { SessionEvent, TransitionResult } from "./stateMachine.js";

import { UNDERSTANDING_CONFIRMATION_PROMPT } from "../clarifier/clarifier.js";

import type { Device_Scanner } from "../scanner/deviceScanner.js";
import type { ScanOptions } from "../scanner/types.js";
import type { Analyzer } from "../analyzer/analyzer.js";
import type { Awareness_Presenter, PresenterView } from "../analyzer/presenter.js";
import type { Clarifier, ClarifierStep } from "../clarifier/clarifier.js";
import type {
  ClarifyQuestion,
  Confidence_Statement,
  ImpasseSummary,
  Task_Frame,
  UserAnswer,
} from "../clarifier/types.js";
import type { Scope_Resolver, WorkingDirectory } from "../scope/scopeResolver.js";
import type {
  Backup_Manager,
  BackupHandle,
  SizeEstimate,
} from "../backup/backupManager.js";
import type {
  ExecutionHooks,
  ExecutionProgressEvent,
  ExecutionResult,
} from "../executor/types.js";
import type {
  Delivery_Report,
  Delivery_Verifier,
} from "../delivery/deliveryVerifier.js";
import type { AcceptanceTestResult } from "../delivery/decideAfterVerify.js";
import type { LLM_Provider } from "../llm/llmProvider.js";

// ===========================================================================
// 对外事件（经 SSE/回调通知 UI）—— OrchestratorEvent / OrchestratorNotifier
// ===========================================================================

/**
 * 编排层向 UI 推送的事件（由 `OrchestratorNotifier` 投递，最终经 SSE 通道，任务 15.1）。
 *
 * 设计上与 design.md「SSE 事件类型一览」呼应：扫描线索流 / 察觉呈现 / 澄清问题 /
 * 高危弹窗 / 备份大小警告 / 执行动作流 / 验收报告等。编排层只产出语义事件，
 * 具体 SSE 序列化与事件名由 Web 层负责（解耦）。
 */
export type OrchestratorEvent =
  /** 会话状态发生变化（携带新状态）。 */
  | { kind: "state-changed"; state: SessionState }
  /** 扫描具身化线索流（阶段1 粗筛分批推送的元信息级线索，可选增强）。 */
  | { kind: "scan-progress"; found: string[] }
  /** 察觉呈现（互斥视图：items / empty）。 */
  | { kind: "awareness"; view: PresenterView }
  /** 本轮澄清问题（≤ 单轮上限）。 */
  | { kind: "clarify-questions"; questions: ClarifyQuestion[] }
  /** 信息充分：明示当前理解（含 Confidence_Statement）并询问"可以开始执行吗？"。 */
  | {
      kind: "awaiting-understanding";
      taskFrame: Task_Frame;
      confidence: Confidence_Statement;
      prompt: string;
    }
  /** 软上限僵局：汇总理解 + 未消解高风险 + 三选一（R8.12）。 */
  | { kind: "impasse"; summary: ImpasseSummary }
  /** 定界：向用户提出建议的 Working_Directory。 */
  | { kind: "scope-suggestion"; suggestedPath: string }
  /** 定界已落定，呈现"开始执行"确认入口（R10.1）。 */
  | { kind: "ready-confirm"; workingDir: WorkingDirectory }
  /** 备份体积超阈值，发出明确的体积警告并等待二次确认（R11）。 */
  | { kind: "backup-size-warning"; estimate: SizeEstimate }
  /** 实时执行动作流（每个工具动作前后各一条，四态 status，R12.5）。 */
  | { kind: "execution-progress"; event: ExecutionProgressEvent }
  /** 高危动作弹窗：暂停等待用户确认（R13.1）。 */
  | { kind: "high-risk"; description: string }
  /** 执行中阻断性问题：暂停向用户提问（R14.2）。 */
  | { kind: "blocking-question"; problem: string }
  /** 交付报告（含逐条验收结果与 hasFailures，失败须标红）+ "确认完成"入口（R15.1）。 */
  | { kind: "delivery-report"; report: Delivery_Report }
  /** 用户已"确认完成"，任务标记为已验收（R15.5）。 */
  | { kind: "accepted" }
  /** 非致命错误：转入 lastError 并通知 UI，服务保持运行（R1.5/R5.5）。 */
  | { kind: "error"; error: { code: string; message: string } };

/**
 * 事件投递接口。Web 层（任务 15.1）注入基于 SSE 的实现；测试可注入收集器。
 * 默认实现为 no-op（编排层在无通知通道时仍可独立运行，便于单测）。
 */
export interface OrchestratorNotifier {
  emit(event: OrchestratorEvent): void;
}

/** 默认空投递器：丢弃所有事件（编排层无 UI 时静默运行）。 */
export const NOOP_NOTIFIER: OrchestratorNotifier = { emit: () => {} };

// ===========================================================================
// 依赖注入契约 —— 各模块均经接口注入（编排层不 new 具体实现）
// ===========================================================================

/**
 * Executor 的最小调用契约（结构与 `executor/executor.ts` 的 `Executor` 类一致）。
 * 经接口注入以便测试替身与可插拔。
 */
export interface ExecutorRunner {
  run(
    taskFrame: Task_Frame,
    workingDir: WorkingDirectory,
    hooks: ExecutionHooks,
  ): Promise<ExecutionResult>;
}

/**
 * 编排器依赖项。各管线模块均经接口注入（R6 / R17.3）：编排层只依赖抽象，
 * 具体实现由 composition root（任务 17.1）装配后注入。
 */
export interface OrchestratorDeps {
  /** 平台扫描器（经 ScannerRegistry 解析后注入，R2）。 */
  scanner: Device_Scanner;
  /** LLM 分析器（R5）。 */
  analyzer: Analyzer;
  /** 察觉呈现器（R7）。 */
  presenter: Awareness_Presenter;
  /** 澄清定面器（R8）。 */
  clarifier: Clarifier;
  /** 定界器（R9）。 */
  scopeResolver: Scope_Resolver;
  /** 备份管理器（R11）。 */
  backupManager: Backup_Manager;
  /** 执行器（R12-R14）。 */
  executor: ExecutorRunner;
  /** 交付验收器（R15）。 */
  deliveryVerifier: Delivery_Verifier;
  /**
   * LLM 供应方（R6）。各子模块已各自注入所需 provider；此处一并持有，
   * 作为 composition root 的可插拔点引用（融合契约），便于诊断与未来扩展。
   */
  llmProvider: LLM_Provider;

  /** 事件投递器，默认 {@link NOOP_NOTIFIER}。 */
  notifier?: OrchestratorNotifier;
  /** 扫描入参，默认 `{ recentDays: 7, topN: 15, homeDir: os.homedir() }`。 */
  scanOptions?: ScanOptions;
  /** 注入时钟（ISO8601），便于测试确定性；默认取当前时刻。 */
  now?: () => string;
  /** 初始会话，默认 `createInitialSession()`（单用户单会话，R18.3）。 */
  session?: Session;
}

/** 用户动作方法的统一返回结果。 */
export interface ActionResult {
  /** 本次动作是否被接受（合法转移 / 成功发起）。 */
  ok: boolean;
  /** 动作后的会话状态。 */
  state: SessionState;
  /** 被拒绝/失败时的描述性原因。 */
  reason?: string;
}

// ===========================================================================
// 内部：deferred（高危确认 / 阻断性提问的暂停-恢复）
// ===========================================================================

/** 可在外部 resolve 的 Promise 句柄。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** 创建一个可在外部 resolve 的 deferred。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ===========================================================================
// 内部：执行/验收期间挂起的用户交互（高危确认 / 阻断性提问）
// ===========================================================================

/** 当前挂起、等待用户 REST 动作恢复的交互（同一时刻至多一个）。 */
type PendingInteraction =
  /** 高危动作弹窗：等待 `/confirm-risk`（confirm 放行 / reject 跳过）。 */
  | { kind: "high-risk"; deferred: Deferred<"confirm" | "reject"> }
  /** 阻断性问题：等待 `/answer`（用户答复文本回灌执行循环）。 */
  | { kind: "blocking"; deferred: Deferred<string> };

// ===========================================================================
// Orchestrator —— 闭环编排器
// ===========================================================================

/**
 * 闭环编排器：持有唯一 `Session`，按各 REST 动作驱动 `transition` 推进状态机，
 * 并在合适时机调用各注入模块完成真实工作。
 *
 * 公共方法与 design.md「server/routes.ts」的 REST 端点一一对应（任务 15.2 接线）：
 * `scan` / `acceptAwareness` / `dismissAwareness` / `answer` / `confirmUnderstanding` /
 * `supplementUnderstanding` / `impasseChoice` / `confirmScope` / `startExecution` /
 * `confirmBackupSize` / `cancelBackupSize` / `confirmRisk` / `replyBlocking` /
 * `acceptDelivery` / `recoverFromError`。
 */
export class Orchestrator {
  private session: Session;
  private readonly deps: OrchestratorDeps;
  private readonly notifier: OrchestratorNotifier;
  private readonly scanOptions: ScanOptions;
  private readonly now: () => string;

  /** 执行阶段挂起的用户交互（高危确认 / 阻断性提问）。 */
  private pending: PendingInteraction | null = null;
  /** 后台执行任务的句柄，供测试 `whenExecutionSettled()` 等待。 */
  private executionTask: Promise<void> = Promise.resolve();

  /** 执行阶段（executing）使用的、可暂停-恢复的执行回调。 */
  private readonly executionHooks: ExecutionHooks;
  /** 验收阶段（verifying）使用的、仅推进度且不阻塞的执行回调。 */
  private readonly verificationHooks: ExecutionHooks;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.notifier = deps.notifier ?? NOOP_NOTIFIER;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.scanOptions =
      deps.scanOptions ?? { recentDays: 7, topN: 15, homeDir: homedir() };
    this.session = deps.session ?? createInitialSession();

    this.executionHooks = {
      confirmHighRisk: (description) => this.onHighRisk(description),
      askUser: (problem) => this.onBlockingQuestion(problem),
      emitProgress: (event) => this.onProgress(event),
    };
    // 验收阶段不进入「暂停问用户」：高危检验命令直接拒绝（→ 该条 failed），
    // 阻断性问题给空答复，仅转发实时进度。避免在 verifying 状态触发非法的 block_on_user。
    this.verificationHooks = {
      confirmHighRisk: async () => "reject",
      askUser: async () => "",
      emitProgress: (event) => this.onProgress(event),
    };
  }

  // -------------------------------------------------------------------------
  // 只读访问
  // -------------------------------------------------------------------------

  /** 当前会话快照（单用户单会话，R18.3）。 */
  getSession(): Session {
    return this.session;
  }

  /** 当前会话状态。 */
  getState(): SessionState {
    return this.session.state;
  }

  /** 等待后台执行/验收阶段结算（供测试串起完整闭环）。 */
  whenExecutionSettled(): Promise<void> {
    return this.executionTask;
  }

  // -------------------------------------------------------------------------
  // 1) 扫描 → 分析 → 察觉呈现
  // -------------------------------------------------------------------------

  /**
   * `POST /scan`：手动触发一次扫描（R1.1/R1.2），成功后链式驱动分析与察觉呈现。
   * 非 macOS 平台返回"暂不支持"提示并停留 idle（R2.5）。
   */
  async scan(): Promise<ActionResult> {
    if (this.session.state !== SessionState.Idle) {
      return this.rejected(`扫描仅能在空闲状态触发（当前 ${this.session.state}）`);
    }
    // 平台支持性前置校验（R2.5）：不支持则不进入 scanning，停留 idle。
    if (!this.deps.scanner.isSupported()) {
      this.notify({
        kind: "error",
        error: {
          code: "PLATFORM_UNSUPPORTED",
          message: `当前平台（${this.deps.scanner.platform}）暂不支持扫描。`,
        },
      });
      return this.rejected("当前平台暂不支持扫描");
    }

    const start = this.applyEvent({ type: "scan" }); // idle → scanning
    if (!start.ok) return this.rejected(start.reason);

    // 真实扫描：onProgress 转发扫描具身化线索流（仅元信息，R3.5/R4.4）。
    let summary;
    try {
      summary = await this.deps.scanner.scan(this.scanOptions, (event) => {
        this.notify({ kind: "scan-progress", found: event.found });
      });
    } catch (err) {
      // 扫描失败：非致命，scanning → error（R1.5），服务保持运行。
      this.applyError("SCAN_ERROR", describeError(err));
      return this.rejected("扫描失败");
    }

    const scanned = this.applyEvent({ type: "scan-succeeded", scanSummary: summary }); // → analyzing
    if (!scanned.ok) return this.rejected(scanned.reason);

    return this.runAnalysis();
  }

  /** analyzing：调用 Analyzer 推断察觉条目并呈现（R5/R7）。 */
  private async runAnalysis(): Promise<ActionResult> {
    const summary = this.session.scanSummary;
    if (!summary) {
      this.applyError("ANALYZE_ERROR", "缺少 Scan_Summary，无法分析。");
      return this.rejected("缺少扫描摘要");
    }

    let items;
    try {
      items = await this.deps.analyzer.analyze(summary);
    } catch (err) {
      // LLM 分析失败：非致命，analyzing → error（R5.5/R5.6），服务保持运行。
      this.applyError("ANALYZE_ERROR", describeError(err));
      return this.rejected("分析失败");
    }

    const done = this.applyEvent({
      type: "analysis-succeeded",
      awarenessItems: items,
    }); // → awareness_presented
    if (!done.ok) return this.rejected(done.reason);

    // 察觉呈现：互斥的 items / empty 视图（R7）。
    const view = this.deps.presenter.present(items);
    this.notify({ kind: "awareness", view });
    return this.accepted();
  }

  // -------------------------------------------------------------------------
  // 2) 察觉接受 / 忽略 → 澄清定面
  // -------------------------------------------------------------------------

  /** `POST /accept`：接受某条 Awareness_Item，进入澄清并产出首轮问题（R8.1）。 */
  async acceptAwareness(itemId: string): Promise<ActionResult> {
    if (this.session.state !== SessionState.AwarenessPresented) {
      return this.rejected(`接受察觉仅在察觉呈现后合法（当前 ${this.session.state}）`);
    }
    const item = (this.session.awarenessItems ?? []).find((i) => i.id === itemId);
    if (!item) {
      return this.rejected(`未找到 id=${itemId} 的察觉条目`);
    }

    const enter = this.applyEvent({ type: "accept-awareness", itemId }); // → clarifying
    if (!enter.ok) return this.rejected(enter.reason);

    // 初始化澄清会话并产出首轮步骤。
    try {
      const clarifierState = await this.deps.clarifier.begin(item, this.session);
      this.session = { ...this.session, clarifierState, updatedAt: this.now() };
      const step = await this.deps.clarifier.next(clarifierState);
      this.bumpClarifierRound();
      this.consumeClarifierStep(step);
    } catch (err) {
      this.applyError("CLARIFY_ERROR", describeError(err));
      return this.rejected("澄清初始化失败");
    }
    return this.accepted();
  }

  /** 用户忽略全部察觉 / 本次无可执行事项 → 回到 idle（R7.3）。 */
  dismissAwareness(): ActionResult {
    const r = this.applyEvent({ type: "dismiss-awareness" });
    return r.ok ? this.accepted() : this.rejected(r.reason);
  }

  /** `POST /answer`（澄清中）：提交一次答复，驱动 Clarifier 下一步（R8.6-8.12）。 */
  async answer(userAnswer: UserAnswer): Promise<ActionResult> {
    if (this.session.state !== SessionState.Clarifying) {
      return this.rejected(`澄清答复仅在 clarifying 状态合法（当前 ${this.session.state}）`);
    }
    const clarifierState = this.session.clarifierState;
    if (!clarifierState) {
      this.applyError("CLARIFY_ERROR", "澄清状态缺失，无法继续澄清。");
      return this.rejected("澄清状态缺失");
    }

    try {
      const step = await this.deps.clarifier.next(clarifierState, userAnswer);
      this.bumpClarifierRound();
      this.consumeClarifierStep(step);
    } catch (err) {
      this.applyError("CLARIFY_ERROR", describeError(err));
      return this.rejected("澄清失败");
    }
    return this.accepted();
  }

  /**
   * 把 Clarifier 一步产出映射到状态机事件与对外通知：
   *  - questions → 仅推送本轮问题（停留 clarifying）。
   *  - sufficient → answer(sufficient) → awaiting_understanding，明示理解并询问可否执行。
   *  - impasse → answer(impasse) → impasse，呈现三选一。
   */
  private consumeClarifierStep(step: ClarifierStep): void {
    switch (step.kind) {
      case "questions":
        this.notify({ kind: "clarify-questions", questions: step.questions });
        return;
      case "sufficient": {
        const r = this.applyEvent({
          type: "answer",
          outcome: { kind: "sufficient", taskFrame: step.taskFrame },
        });
        if (r.ok) {
          this.notify({
            kind: "awaiting-understanding",
            taskFrame: step.taskFrame,
            confidence: step.taskFrame.confidence,
            prompt: UNDERSTANDING_CONFIRMATION_PROMPT,
          });
        }
        return;
      }
      case "impasse": {
        const r = this.applyEvent({ type: "answer", outcome: { kind: "impasse" } });
        if (r.ok) this.notify({ kind: "impasse", summary: step.summary });
        return;
      }
    }
  }

  /** 推进所存澄清状态的轮次计数，使 `next` 逐轮逼近软上限（R8.12）。 */
  private bumpClarifierRound(): void {
    if (this.session.clarifierState) {
      this.session.clarifierState.round += 1;
    }
  }

  // -------------------------------------------------------------------------
  // 3) 最终理解确认 / 补充 / 僵局三选一
  // -------------------------------------------------------------------------

  /** `POST /confirm-understanding`：对"可以开始执行吗"作肯定确认（R8.11）→ 定界。 */
  async confirmUnderstanding(): Promise<ActionResult> {
    const r = this.applyEvent({ type: "confirm-understanding" }); // → scope_confirm
    if (!r.ok) return this.rejected(r.reason);
    await this.emitScopeSuggestion();
    return this.accepted();
  }

  /** 用户对当前理解提出补充/否定 → 退回继续澄清（R8.11 反向）。 */
  supplementUnderstanding(): ActionResult {
    const r = this.applyEvent({ type: "supplement-understanding" });
    return r.ok ? this.accepted() : this.rejected(r.reason);
  }

  /** 僵局三选一（R8.12）：补充信息 / 高风险下强制执行 / 放弃任务。 */
  async impasseChoice(
    choice: "supplement" | "force_execute" | "abandon",
  ): Promise<ActionResult> {
    const r = this.applyEvent({ type: "impasse-choice", choice });
    if (!r.ok) return this.rejected(r.reason);
    if (choice === "force_execute") await this.emitScopeSuggestion(); // → scope_confirm
    return this.accepted();
  }

  /** 计算并推送建议 Working_Directory（R9.1）。失败为非致命，不阻断定界。 */
  private async emitScopeSuggestion(): Promise<void> {
    const taskFrame = this.session.taskFrame;
    const summary = this.session.scanSummary;
    if (!taskFrame || !summary) return;
    try {
      const suggestedPath = await this.deps.scopeResolver.suggest(taskFrame, summary);
      this.notify({ kind: "scope-suggestion", suggestedPath });
    } catch (err) {
      // 建议目录推断失败不阻断：用户仍可手动指定路径（保持服务运行）。
      this.notify({
        kind: "error",
        error: { code: "SCOPE_SUGGEST_ERROR", message: describeError(err) },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4) 定界确认 → 最终执行确认
  // -------------------------------------------------------------------------

  /**
   * `POST /confirm-scope`：落定用户最终指定的 Working_Directory（R9.2/R9.3/R9.4）。
   *
   * 命中关键目录黑名单（ScopeError）属非致命错误：**停留 scope_confirm 并提示重选**，
   * 不中断闭环——这正是"保持服务运行"（用户可立即另选更聚焦的目录重试）。
   */
  confirmScope(userChosenPath: string): ActionResult {
    if (this.session.state !== SessionState.ScopeConfirm) {
      return this.rejected(`确认定界仅在 scope_confirm 状态合法（当前 ${this.session.state}）`);
    }
    let workingDir: WorkingDirectory;
    try {
      workingDir = this.deps.scopeResolver.confirm(userChosenPath);
    } catch (err) {
      // ScopeError 等：非致命，停留 scope_confirm 让用户重选（不转 error、不丢进度）。
      this.annotateError("SCOPE_ERROR", describeError(err));
      return this.rejected("定界被拒绝，请另选更聚焦的目录");
    }

    const r = this.applyEvent({ type: "confirm-scope", workingDir }); // → ready_confirm
    if (!r.ok) return this.rejected(r.reason);
    this.notify({ kind: "ready-confirm", workingDir });
    return this.accepted();
  }

  /**
   * `POST /start-execution`："开始执行"最终确认（R10.2-10.4）→ 进入备份阶段，
   * 随后驱动备份与执行流水线。
   */
  async startExecution(): Promise<ActionResult> {
    const r = this.applyEvent({ type: "start-execution" }); // → backing_up
    if (!r.ok) return this.rejected(r.reason);
    return this.runBackupPhase();
  }

  // -------------------------------------------------------------------------
  // 5) 备份（含体积二次确认门）→ 执行
  // -------------------------------------------------------------------------

  /** backing_up：先估算体积；超阈值转 awaiting_backup_confirm 等待二次确认，否则直接备份+执行。 */
  private async runBackupPhase(): Promise<ActionResult> {
    const workingDir = this.session.workingDir;
    if (!workingDir) {
      this.applyError("BACKUP_ERROR", "缺少 Working_Directory，无法备份。");
      return this.rejected("缺少工作目录");
    }

    let estimate: SizeEstimate;
    try {
      estimate = await this.deps.backupManager.estimateSize(workingDir);
    } catch (err) {
      this.applyError("BACKUP_ERROR", `体积估算失败：${describeError(err)}`);
      return this.rejected("体积估算失败");
    }

    const est = this.applyEvent({ type: "backup-size-estimated", estimate });
    if (!est.ok) return this.rejected(est.reason);

    if (this.session.state === SessionState.AwaitingBackupConfirm) {
      // 超阈值：发出明确体积警告，等待用户 `/confirm-backup-size`（R11，Property 28）。
      this.notify({ kind: "backup-size-warning", estimate });
      return this.accepted();
    }

    // 未超阈值：直接创建备份并进入执行。
    return this.createBackupAndExecute();
  }

  /** `POST /confirm-backup-size`：体积超阈值时的二次确认（R11.2）→ 继续备份+执行。 */
  async confirmBackupSize(): Promise<ActionResult> {
    const r = this.applyEvent({ type: "confirm-backup-size" }); // awaiting_backup_confirm → backing_up
    if (!r.ok) return this.rejected(r.reason);
    return this.createBackupAndExecute();
  }

  /** 用户取消体积二次确认 → 中止执行（R11.2），绝不进入 executing。 */
  cancelBackupSize(): ActionResult {
    const r = this.applyEvent({ type: "cancel-backup-size" }); // → error
    if (!r.ok) return this.rejected(r.reason);
    this.notify({
      kind: "error",
      error: this.session.lastError ?? {
        code: "BACKUP_CANCELLED",
        message: "用户取消了备份体积二次确认，已中止本次执行。",
      },
    });
    return this.accepted();
  }

  /** backing_up：创建可回滚备份；成功 → executing 并后台启动执行循环；失败 → error（R11）。 */
  private async createBackupAndExecute(): Promise<ActionResult> {
    const workingDir = this.session.workingDir!;
    let handle: BackupHandle;
    try {
      handle = await this.deps.backupManager.createBackup(workingDir);
    } catch (err) {
      // 备份失败：中止执行，backing_up → error，绝不进入 executing（R11.2）。
      this.applyError("BACKUP_ERROR", `备份创建失败：${describeError(err)}`);
      return this.rejected("备份失败，已中止执行");
    }

    const r = this.applyEvent({ type: "backup-succeeded", handle }); // → executing
    if (!r.ok) return this.rejected(r.reason);

    // 后台启动执行循环；交互（高危/阻断）经 hooks 暂停-恢复，完成后进入验收。
    this.executionTask = this.runExecutionPhase().catch((err) => {
      this.applyError("EXECUTION_ERROR", describeError(err));
    });
    return this.accepted();
  }

  // -------------------------------------------------------------------------
  // 6) 执行循环（hooks 桥接：高危确认 / 阻断性提问 / 实时动作流）
  // -------------------------------------------------------------------------

  /** executing → verifying → delivered：跑执行循环、强制验收、产出交付报告。 */
  private async runExecutionPhase(): Promise<void> {
    const taskFrame = this.session.taskFrame;
    const workingDir = this.session.workingDir;
    if (!taskFrame || !workingDir) {
      this.applyError("EXECUTION_ERROR", "缺少 Task_Frame 或 Working_Directory。");
      return;
    }

    // 真实执行（受 sandbox / 高危门约束，交互经 executionHooks 暂停-恢复）。
    const result = await this.deps.executor.run(taskFrame, workingDir, this.executionHooks);
    this.session = { ...this.session, executionLog: result.log, updatedAt: this.now() };

    if (result.status !== "completed") {
      // 未真实落地完成（达步数上限 / 中止）：非致命，转 error，绝不伪装已完成（R12.5）。
      this.applyError(
        "EXECUTION_INCOMPLETE",
        `执行未达成完成判据（status=${result.status}）。`,
      );
      return;
    }

    // 声称完成 → 必经 verifying 强制验收（R12.5/R15.1）。
    const toVerify = this.applyEvent({ type: "execution-completed" }); // → verifying
    if (!toVerify.ok) return;

    let results: AcceptanceTestResult[];
    try {
      results = await this.deps.deliveryVerifier.runAcceptanceTests(
        taskFrame,
        workingDir,
        this.verificationHooks,
      );
    } catch (err) {
      this.applyError("VERIFY_ERROR", describeError(err));
      return;
    }
    this.session = { ...this.session, acceptanceTestResults: results, updatedAt: this.now() };

    // 验收门裁决：全部通过 → delivered，否则 → blocked_on_user（R12.5/R15.1）。
    const verdict = this.applyEvent({
      type: "verify-completed",
      results,
      onFailure: "block",
    });
    if (!verdict.ok) return;

    // 无论通过与否都收集证据产出报告（失败时 hasFailures=true，UI 须标红）。
    let report: Delivery_Report;
    try {
      report = await this.deps.deliveryVerifier.buildReport(
        taskFrame,
        workingDir,
        this.session.backup,
        result,
        results,
      );
    } catch (err) {
      this.applyError("VERIFY_ERROR", describeError(err));
      return;
    }
    this.session = { ...this.session, deliveryReport: report, updatedAt: this.now() };
    this.notify({ kind: "delivery-report", report });

    if (this.session.state === SessionState.BlockedOnUser) {
      // 验收存在失败项：呈现失败报告并等待用户决策（重试/强制验收/放弃由后续 UI 接线）。
      this.notify({
        kind: "blocking-question",
        problem: "验收测试存在失败项（报告已标红）。请选择：重试执行 / 强制验收 / 放弃任务。",
      });
    }
  }

  /** 高危确认 hook：暂停（executing → blocked_on_user），等待 `/confirm-risk`（R13.1）。 */
  private onHighRisk(description: string): Promise<"confirm" | "reject"> {
    const blocked = this.applyEvent({ type: "block-on-user", reason: "high-risk" });
    this.notify({ kind: "high-risk", description });
    if (!blocked.ok) {
      // 非 executing 状态收到高危（理论不应发生）：保守跳过该动作。
      return Promise.resolve("reject");
    }
    const deferred = createDeferred<"confirm" | "reject">();
    this.pending = { kind: "high-risk", deferred };
    return deferred.promise;
  }

  /** 阻断性问题 hook：暂停（executing → blocked_on_user），等待 `/answer`（R14.2/14.3）。 */
  private onBlockingQuestion(problem: string): Promise<string> {
    const blocked = this.applyEvent({ type: "block-on-user", reason: "blocking" });
    this.notify({ kind: "blocking-question", problem });
    if (!blocked.ok) {
      return Promise.resolve(""); // 非 executing 收到阻断（理论不应发生）：空答复继续。
    }
    const deferred = createDeferred<string>();
    this.pending = { kind: "blocking", deferred };
    return deferred.promise;
  }

  /** 实时执行动作流 hook：转发 `execution-progress` 事件到 UI（R12.5）。 */
  private onProgress(event: ExecutionProgressEvent): void {
    this.notify({ kind: "execution-progress", event });
  }

  /**
   * `POST /confirm-risk`：用户对高危动作作决定（R13.3/R13.4）。
   * confirm → 放行执行；reject → 跳过该动作。两者均 blocked_on_user → executing 恢复循环。
   */
  confirmRisk(decision: "confirm" | "reject"): ActionResult {
    if (this.session.state !== SessionState.BlockedOnUser) {
      return this.rejected(`确认高危仅在 blocked_on_user 状态合法（当前 ${this.session.state}）`);
    }
    if (!this.pending || this.pending.kind !== "high-risk") {
      return this.rejected("当前没有等待确认的高危动作");
    }
    const r = this.applyEvent({ type: "confirm-risk" }); // → executing
    if (!r.ok) return this.rejected(r.reason);
    const { deferred } = this.pending;
    this.pending = null;
    deferred.resolve(decision); // 恢复执行循环
    return this.accepted();
  }

  /**
   * `POST /answer`（执行中阻断性问题）：用户答复后恢复执行（R14.4）。
   * blocked_on_user → executing，答复文本回灌执行循环。
   */
  replyBlocking(answerText: string): ActionResult {
    if (this.session.state !== SessionState.BlockedOnUser) {
      return this.rejected(`答复阻断性问题仅在 blocked_on_user 状态合法（当前 ${this.session.state}）`);
    }
    if (!this.pending || this.pending.kind !== "blocking") {
      return this.rejected("当前没有等待答复的阻断性问题");
    }
    const r = this.applyEvent({ type: "reply-blocking" }); // → executing
    if (!r.ok) return this.rejected(r.reason);
    const { deferred } = this.pending;
    this.pending = null;
    deferred.resolve(answerText); // 恢复执行循环
    return this.accepted();
  }

  // -------------------------------------------------------------------------
  // 7) 交付验收
  // -------------------------------------------------------------------------

  /**
   * `POST /accept-delivery`：用户"确认完成"验收（R15.4/15.5/15.6）。
   * 仅 delivered 状态合法，由状态机置 `accepted=true` 并转 accepted；无任何自动/超时路径。
   */
  acceptDelivery(): ActionResult {
    const r = this.applyEvent({ type: "accept-delivery" }); // delivered → accepted
    if (!r.ok) return this.rejected(r.reason);
    this.notify({ kind: "accepted" });
    return this.accepted();
  }

  // -------------------------------------------------------------------------
  // 8) 错误恢复
  // -------------------------------------------------------------------------

  /** 从 error 恢复回 idle，服务保持可运行（R1.6/R5.6）。 */
  recoverFromError(): ActionResult {
    const r = this.applyEvent({ type: "error-recovered" }); // error → idle
    return r.ok ? this.accepted() : this.rejected(r.reason);
  }

  // -------------------------------------------------------------------------
  // 内部：事件施加 / 错误处理 / 通知 / 结果构造
  // -------------------------------------------------------------------------

  /** 施加一个状态机事件；合法则替换会话并通知状态变化，非法则原样返回拒绝结果。 */
  private applyEvent(event: SessionEvent): TransitionResult {
    const result = transition(this.session, event, { now: this.now });
    if (result.ok) {
      this.session = result.session;
      this.notify({ kind: "state-changed", state: this.session.state });
    }
    return result;
  }

  /**
   * 记录非致命错误：优先经状态机转 `error`（当前状态可错时）；否则仅在会话上标注
   * `lastError` 而不改变状态。无论哪种，都经通知器告知 UI，进程不崩溃（R1.5/R1.6/R5.6）。
   */
  private applyError(code: string, message: string): void {
    const result = transition(
      this.session,
      { type: "error-occurred", error: { code, message } },
      { now: this.now },
    );
    if (result.ok) {
      this.session = result.session;
    } else {
      this.annotateError(code, message);
    }
    this.notify({ kind: "error", error: { code, message } });
    this.notify({ kind: "state-changed", state: this.session.state });
  }

  /** 仅在会话上标注 lastError（不改变状态）；用于 ScopeError 等"停留原态可重试"的非致命错误。 */
  private annotateError(code: string, message: string): void {
    this.session = {
      ...this.session,
      lastError: { code, message },
      updatedAt: this.now(),
    };
    this.notify({ kind: "error", error: { code, message } });
  }

  /** 投递事件（默认 NOOP_NOTIFIER 时静默）。 */
  private notify(event: OrchestratorEvent): void {
    this.notifier.emit(event);
  }

  /** 构造"动作被接受"的结果。 */
  private accepted(): ActionResult {
    return { ok: true, state: this.session.state };
  }

  /** 构造"动作被拒绝/失败"的结果。 */
  private rejected(reason?: string): ActionResult {
    return { ok: false, state: this.session.state, reason };
  }
}

// ===========================================================================
// 辅助：错误描述
// ===========================================================================

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
