/**
 * proactive-awareness-demo —— Session 状态机的 fast-check 模型测试框架（任务 14.3 奠基）。
 *
 * 这是一个**最小可行、可复用**的 `fc.commands` / `fc.modelRun` 状态机模型框架，被
 * 任务 14.3（Property 13 执行前置门）首次落地，并设计为可被 **14.4（Property 28 备份体积
 * 二次确认门）** 与 **14.5（Property 21 验收门）** 直接 import / 扩展。
 *
 * 框架三件套：
 *  1. {@link SessionModel} —— 抽象模型：当前状态 + 五个布尔门 + 备份是否已创建 +
 *     备份体积估算是否超阈值。它是一个**独立于被测实现**的状态预测器，与
 *     `stateMachine.ts` 的 `transition` 互为对照。
 *  2. {@link predict} —— 纯函数模型转移预测器：给定模型与事件，预测该事件在当前状态下
 *     是否为**合法转移**，以及合法时的下一模型。它逐项镜像 `transition` 的状态门与转移
 *     规则，但只跟踪安全关键字段，从而能独立地校验「非法状态转移被 `transition` 拒绝」。
 *  3. {@link SessionCommand} —— 实现 `fc.Command<SessionModel, RealSystem>` 的通用命令：
 *     每个命令承载一个 {@link SessionEvent}，`run` 时对真实 `Session` 施加 `transition`，
 *     并断言其结果（合法/拒绝、转移后的状态与五个布尔门）与模型预测完全一致；命令还可
 *     携带一组**安全不变量**（{@link SessionInvariant}），在每步之后校验（如 Property 13
 *     的「executing ⇒ 四前置全满足」）。
 *
 * 复用 / 扩展方式（供 14.4 / 14.5）：
 *  - 直接复用：`import { buildCommandArbs, makeSetup, runCommandSequence } from "./sessionModel.js"`，
 *    把各自的安全不变量数组传给 `buildCommandArbs(invariants)`，再 `fc.assert` +
 *    `fc.property(sessionCommandsArb(...), ...)` + `runCommandSequence`。
 *  - 扩展命令：若需要新的端点 Command，构造 `new SessionCommand(event, invariants)` 即可；
 *    `predict` 已覆盖全部 `SessionEvent`，无需改动。
 *  - 扩展模型字段：在 {@link SessionModel} 增字段并在 {@link predict} / {@link initialModel}
 *    同步维护即可（如 14.5 若需跟踪 acceptanceTestResults 是否存在）。
 *
 * 设计原则：本框架**不依赖测试运行器**做断言（使用内置 {@link must} 抛错），fast-check 会
 * 捕获抛出的错误并最小化反例，因此框架可在任意 runner 下复用。
 */

import fc from "fast-check";
import {
  SessionState,
  createInitialSession,
} from "../../src/orchestrator/session.js";
import type {
  Session,
  Scan_Summary,
  Awareness_Item,
  Task_Frame,
  WorkingDirectory,
  BackupHandle,
  SizeEstimate,
  AcceptanceTestResult,
} from "../../src/orchestrator/session.js";
import {
  transition,
  decideAfterVerify,
} from "../../src/orchestrator/stateMachine.js";
import type { SessionEvent, ClarifyOutcome } from "../../src/orchestrator/stateMachine.js";

// ===========================================================================
// 0. 内置断言（runner 无关）
// ===========================================================================

/** 轻量不变量断言：失败即抛错，由 fast-check 捕获并最小化反例。 */
export function must(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** 注入到 transition 的确定性时钟，保证模型测试可复现（不引入挂钟噪声）。 */
export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

// ===========================================================================
// 1. SessionModel —— 抽象模型（独立状态预测器）
// ===========================================================================

/**
 * 模型只跟踪安全关键字段：状态、五个布尔门、备份是否已创建、备份体积估算是否超阈值。
 * 这些足以独立预测每个事件是合法转移还是被拒，以及合法时的目标状态/门。
 */
export interface SessionModel {
  state: SessionState;
  understandingConfirmed: boolean;
  scopeConfirmed: boolean;
  executionConfirmed: boolean;
  backupSizeConfirmed: boolean;
  accepted: boolean;
  /** 备份是否已成功创建（对应 `Session.backup != null`）。 */
  hasBackup: boolean;
  /**
   * 备份体积估算状态：`undefined` 表示尚无估算；`true/false` 表示是否超阈值。
   * 与 `backupSizeGateSatisfied` 的语义对齐。
   */
  backupEstimateExceeded?: boolean;
}

/** 初始模型：与 `createInitialSession()` 完全对齐（idle + 所有门 false + 无备份）。 */
export function initialModel(): SessionModel {
  return {
    state: SessionState.Idle,
    understandingConfirmed: false,
    scopeConfirmed: false,
    executionConfirmed: false,
    backupSizeConfirmed: false,
    accepted: false,
    hasBackup: false,
    backupEstimateExceeded: undefined,
  };
}

function cloneModel(m: SessionModel): SessionModel {
  return { ...m };
}

/** 模型侧的执行前置门（三个用户确认门是否全满足），镜像 `executionPreconditionsMet`。 */
function modelExecutionPreconditionsMet(m: SessionModel): boolean {
  return m.understandingConfirmed && m.scopeConfirmed && m.executionConfirmed;
}

/** 模型侧的备份体积二次确认门，镜像 `backupSizeGateSatisfied`。 */
function modelBackupSizeGateSatisfied(m: SessionModel): boolean {
  if (m.backupEstimateExceeded === true) {
    return m.backupSizeConfirmed === true;
  }
  return true;
}

/** 可发生非致命错误（→ error）的「处理中」状态集合，镜像 stateMachine 的 ERRORABLE_STATES。 */
const MODEL_ERRORABLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  SessionState.Scanning,
  SessionState.Analyzing,
  SessionState.AwarenessPresented,
  SessionState.Clarifying,
  SessionState.AwaitingUnderstanding,
  SessionState.Impasse,
  SessionState.ScopeConfirm,
  SessionState.ReadyConfirm,
  SessionState.BackingUp,
  SessionState.AwaitingBackupConfirm,
  SessionState.Executing,
  SessionState.BlockedOnUser,
  SessionState.Verifying,
]);

// ===========================================================================
// 2. predict —— 纯函数模型转移预测器（独立于被测实现）
// ===========================================================================

/** 模型转移预测结果。`legal=false` 时 `next` 与输入模型等价（转移被拒，状态不变）。 */
export interface Prediction {
  legal: boolean;
  next: SessionModel;
}

function illegal(m: SessionModel): Prediction {
  return { legal: false, next: cloneModel(m) };
}

function legal(next: SessionModel): Prediction {
  return { legal: true, next };
}

/**
 * 给定模型与事件，预测该事件是否为合法转移以及合法时的下一模型。
 *
 * 逐项镜像 `transition` 的状态门与转移规则（仅跟踪安全关键字段），作为被测实现的
 * **独立对照模型**。
 */
export function predict(model: SessionModel, event: SessionEvent): Prediction {
  const S = SessionState;
  const m = cloneModel(model);

  switch (event.type) {
    case "scan":
      return m.state === S.Idle ? legal({ ...m, state: S.Scanning }) : illegal(m);

    case "scan-succeeded":
      return m.state === S.Scanning ? legal({ ...m, state: S.Analyzing }) : illegal(m);

    case "analysis-succeeded":
      return m.state === S.Analyzing
        ? legal({ ...m, state: S.AwarenessPresented })
        : illegal(m);

    case "accept-awareness":
      return m.state === S.AwarenessPresented
        ? legal({ ...m, state: S.Clarifying })
        : illegal(m);

    case "dismiss-awareness":
      return m.state === S.AwarenessPresented
        ? legal({ ...m, state: S.Idle })
        : illegal(m);

    case "answer": {
      if (m.state !== S.Clarifying) return illegal(m);
      const outcome: ClarifyOutcome = event.outcome;
      if (outcome.kind === "continue") return legal({ ...m, state: S.Clarifying });
      if (outcome.kind === "sufficient")
        return legal({ ...m, state: S.AwaitingUnderstanding });
      return legal({ ...m, state: S.Impasse });
    }

    case "confirm-understanding":
      // 置执行前置门之一（understandingConfirmed），仅在 awaiting_understanding 合法。
      return m.state === S.AwaitingUnderstanding
        ? legal({ ...m, understandingConfirmed: true, state: S.ScopeConfirm })
        : illegal(m);

    case "supplement-understanding":
      return m.state === S.AwaitingUnderstanding
        ? legal({ ...m, state: S.Clarifying })
        : illegal(m);

    case "impasse-choice": {
      if (m.state !== S.Impasse) return illegal(m);
      if (event.choice === "supplement") return legal({ ...m, state: S.Clarifying });
      if (event.choice === "force_execute")
        return legal({ ...m, state: S.ScopeConfirm });
      return legal({ ...m, state: S.Idle });
    }

    case "confirm-scope":
      // 置执行前置门之一（scopeConfirmed），仅在 scope_confirm 合法。
      return m.state === S.ScopeConfirm
        ? legal({ ...m, scopeConfirmed: true, state: S.ReadyConfirm })
        : illegal(m);

    case "start-execution":
      // 置执行前置门之一（executionConfirmed），仅在 ready_confirm 合法。
      return m.state === S.ReadyConfirm
        ? legal({ ...m, executionConfirmed: true, state: S.BackingUp })
        : illegal(m);

    case "backup-size-estimated": {
      if (m.state !== S.BackingUp) return illegal(m);
      const exceeded = event.estimate.exceededThreshold;
      return legal({
        ...m,
        backupEstimateExceeded: exceeded,
        state: exceeded ? S.AwaitingBackupConfirm : S.BackingUp,
      });
    }

    case "confirm-backup-size":
      // 置备份体积二次确认门（backupSizeConfirmed），仅在 awaiting_backup_confirm 合法。
      return m.state === S.AwaitingBackupConfirm
        ? legal({ ...m, backupSizeConfirmed: true, state: S.BackingUp })
        : illegal(m);

    case "cancel-backup-size":
      return m.state === S.AwaitingBackupConfirm
        ? legal({ ...m, state: S.Error })
        : illegal(m);

    case "backup-succeeded": {
      if (m.state !== S.BackingUp) return illegal(m);
      // 执行前置门 + 备份体积门必须满足，才允许进入 executing（Property 13 / 28 的「门」）。
      if (!modelExecutionPreconditionsMet(m)) return illegal(m);
      if (!modelBackupSizeGateSatisfied(m)) return illegal(m);
      return legal({ ...m, hasBackup: true, state: S.Executing });
    }

    case "block-on-user":
      return m.state === S.Executing
        ? legal({ ...m, state: S.BlockedOnUser })
        : illegal(m);

    case "confirm-risk":
    case "reply-blocking":
      return m.state === S.BlockedOnUser
        ? legal({ ...m, state: S.Executing })
        : illegal(m);

    case "execution-completed":
      return m.state === S.Executing
        ? legal({ ...m, state: S.Verifying })
        : illegal(m);

    case "verify-completed": {
      if (m.state !== S.Verifying) return illegal(m);
      const verdict = decideAfterVerify(event.results);
      if (verdict === "delivered") return legal({ ...m, state: S.Delivered });
      const onFailure = event.onFailure ?? "block";
      return legal({
        ...m,
        state: onFailure === "retry" ? S.Executing : S.BlockedOnUser,
      });
    }

    case "accept-delivery":
      // 置验收门（accepted），仅在 delivered 合法，无任何自动/超时路径。
      return m.state === S.Delivered
        ? legal({ ...m, accepted: true, state: S.Accepted })
        : illegal(m);

    case "error-occurred":
      return MODEL_ERRORABLE_STATES.has(m.state)
        ? legal({ ...m, state: S.Error })
        : illegal(m);

    case "error-recovered":
      // 注意：与实现一致，恢复回 idle 时**不**重置五个布尔门（仅清错误）。
      return m.state === S.Error ? legal({ ...m, state: S.Idle }) : illegal(m);

    default: {
      const _never: never = event;
      void _never;
      return illegal(m);
    }
  }
}

// ===========================================================================
// 3. RealSystem + SessionCommand —— fc.Command 通用命令
// ===========================================================================

/** 被测真实系统：持有一个可被 transition 不可变更新后替换的 `Session`。 */
export interface RealSystem {
  session: Session;
}

/**
 * 安全不变量钩子：在每条命令执行后对真实 `Session` 做断言（违反即抛错）。
 * 供各门测试（13/28/21）注入各自的安全断言。
 */
export type SessionInvariant = (session: Session) => void;

/** 校验模型与真实 session 在「状态 + 五个布尔门 + 是否已备份」上完全对齐。 */
function assertModelMatchesSession(m: SessionModel, s: Session, eventType: string): void {
  must(
    s.state === m.state,
    `状态不一致 after ${eventType}: model=${m.state} real=${s.state}`,
  );
  must(
    s.understandingConfirmed === m.understandingConfirmed,
    `understandingConfirmed 不一致 after ${eventType}: model=${m.understandingConfirmed} real=${s.understandingConfirmed}`,
  );
  must(
    s.scopeConfirmed === m.scopeConfirmed,
    `scopeConfirmed 不一致 after ${eventType}: model=${m.scopeConfirmed} real=${s.scopeConfirmed}`,
  );
  must(
    s.executionConfirmed === m.executionConfirmed,
    `executionConfirmed 不一致 after ${eventType}: model=${m.executionConfirmed} real=${s.executionConfirmed}`,
  );
  must(
    s.backupSizeConfirmed === m.backupSizeConfirmed,
    `backupSizeConfirmed 不一致 after ${eventType}: model=${m.backupSizeConfirmed} real=${s.backupSizeConfirmed}`,
  );
  must(
    s.accepted === m.accepted,
    `accepted 不一致 after ${eventType}: model=${m.accepted} real=${s.accepted}`,
  );
  must(
    (s.backup != null) === m.hasBackup,
    `备份存在性不一致 after ${eventType}: model.hasBackup=${m.hasBackup} real.backup=${String(s.backup != null)}`,
  );
}

/**
 * 通用状态机命令：承载一个 {@link SessionEvent}，对真实 `Session` 施加 `transition`，
 * 并断言结果与模型预测一致；随后运行注入的安全不变量。
 *
 * `check` 恒返回 true —— 让**所有**生成的命令（含当前状态下非法的事件）都执行，
 * 从而验证「非法状态转移被 `transition` 拒绝（返回 {ok:false} 且不改动状态门）」。
 */
export class SessionCommand implements fc.Command<SessionModel, RealSystem> {
  constructor(
    public readonly event: SessionEvent,
    private readonly invariants: readonly SessionInvariant[] = [],
  ) {}

  check(_m: Readonly<SessionModel>): boolean {
    return true;
  }

  run(m: SessionModel, r: RealSystem): void {
    const prediction = predict(m, this.event);
    const before = r.session;
    const result = transition(before, this.event, { now: () => FIXED_NOW });

    if (prediction.legal) {
      must(
        result.ok,
        `期望 ${this.event.type} 在状态 ${m.state} 为合法转移，却被拒绝：` +
          (result.ok ? "" : result.reason),
      );
      if (result.ok) {
        r.session = result.session;
        // 把模型推进到预测的下一状态（fast-check 约定：原地变更 model）。
        Object.assign(m, prediction.next);
      }
    } else {
      must(
        !result.ok,
        `期望 ${this.event.type} 在状态 ${m.state} 为非法转移被拒，却成功进入 ` +
          (result.ok ? result.session.state : ""),
      );
      // 非法转移：transition 须原样返回未改动的 session（状态门不可被绕过）。
      must(
        result.session === before,
        `非法转移 ${this.event.type} 不应改动 session 引用`,
      );
    }

    // 模型与真实系统逐字段对齐。
    assertModelMatchesSession(m, r.session, this.event.type);

    // 运行各门测试注入的安全不变量（如 Property 13 的执行前置门安全断言）。
    for (const inv of this.invariants) {
      inv(r.session);
    }
  }

  toString(): string {
    return `apply(${this.event.type})`;
  }
}

// ===========================================================================
// 4. 事件载荷生成器（最小忠实占位）
// ===========================================================================

const scanSummaryArb: fc.Arbitrary<Scan_Summary> = fc.record({
  scannedAt: fc.constant(FIXED_NOW),
  platform: fc.constantFrom("darwin", "linux", "win32"),
  recentDays: fc.constant(7),
  items: fc.constant([]),
});

const awarenessItemsArb: fc.Arbitrary<Awareness_Item[]> = fc.array(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    title: fc.string({ maxLength: 12 }),
    rationale: fc.string({ maxLength: 12 }),
    evidence: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  }),
  { maxLength: 3 },
);

const taskFrameArb: fc.Arbitrary<Task_Frame> = fc.record({
  awarenessItemId: fc.string({ minLength: 1, maxLength: 8 }),
  objective: fc.string({ maxLength: 12 }),
  phases: fc.constant([]),
  resolvedPreconditions: fc.constant([]),
  confidence: fc.constant({ basedOnUserInput: [], basedOnDefaultAssumption: [] }),
  acceptanceTests: fc.constant([]),
});

const workingDirArb: fc.Arbitrary<WorkingDirectory> = fc.record({
  rootAbsPath: fc.constantFrom("/tmp/work", "/tmp/project", "/Users/x/repo"),
});

const backupHandleArb: fc.Arbitrary<BackupHandle> = fc.record({
  strategy: fc.constantFrom("git-commit", "git-stash", "file-snapshot"),
  workingDirRoot: fc.constant("/tmp/work"),
  createdAt: fc.constant(FIXED_NOW),
  rollbackInstruction: fc.string({ minLength: 1, maxLength: 16 }),
});

const sizeEstimateArb: fc.Arbitrary<SizeEstimate> = fc
  .boolean()
  .map((exceeded) => ({
    totalBytes: exceeded ? 800_000_000 : 1_000,
    fileCount: 3,
    exceededThreshold: exceeded,
    thresholdBytes: 500_000_000,
  }));

const acceptanceResultsArb: fc.Arbitrary<AcceptanceTestResult[]> = fc.array(
  fc.record({
    testId: fc.string({ minLength: 1, maxLength: 6 }),
    description: fc.string({ maxLength: 10 }),
    checkMethod: fc.string({ maxLength: 10 }),
    passed: fc.boolean(),
    detail: fc.string({ maxLength: 10 }),
  }),
  { maxLength: 4 },
);

const clarifyOutcomeArb: fc.Arbitrary<ClarifyOutcome> = fc.oneof(
  fc.constant<ClarifyOutcome>({ kind: "continue" }),
  taskFrameArb.map<ClarifyOutcome>((taskFrame) => ({ kind: "sufficient", taskFrame })),
  fc.constant<ClarifyOutcome>({ kind: "impasse" }),
);

// ===========================================================================
// 5. 命令工厂 —— 每个 REST 端点 / 内部事件一个 Command 生成器
// ===========================================================================

/**
 * 构造覆盖**全部** `SessionEvent` 的命令生成器数组。每个命令均携带传入的安全不变量，
 * 在每步执行后校验（供 14.3/14.4/14.5 注入各自的门安全断言）。
 *
 * @param invariants 每步执行后运行的安全不变量（默认空）。
 */
export function buildCommandArbs(
  invariants: readonly SessionInvariant[] = [],
): fc.Arbitrary<fc.Command<SessionModel, RealSystem>>[] {
  const cmd = (event: SessionEvent) => new SessionCommand(event, invariants);
  return [
    // ---- 用户 REST 动作事件 ----
    fc.constant(cmd({ type: "scan" })),
    fc.string({ minLength: 1, maxLength: 8 }).map((itemId) =>
      cmd({ type: "accept-awareness", itemId }),
    ),
    fc.constant(cmd({ type: "dismiss-awareness" })),
    clarifyOutcomeArb.map((outcome) => cmd({ type: "answer", outcome })),
    fc.constant(cmd({ type: "confirm-understanding" })),
    fc.constant(cmd({ type: "supplement-understanding" })),
    fc
      .constantFrom("supplement", "force_execute", "abandon")
      .map((choice) =>
        cmd({
          type: "impasse-choice",
          choice: choice as "supplement" | "force_execute" | "abandon",
        }),
      ),
    workingDirArb.map((workingDir) => cmd({ type: "confirm-scope", workingDir })),
    fc.constant(cmd({ type: "start-execution" })),
    fc.constant(cmd({ type: "confirm-backup-size" })),
    fc.constant(cmd({ type: "cancel-backup-size" })),
    fc.constant(cmd({ type: "confirm-risk" })),
    fc.constant(cmd({ type: "reply-blocking" })),
    fc.constant(cmd({ type: "accept-delivery" })),
    // ---- 内部管线事件 ----
    scanSummaryArb.map((scanSummary) => cmd({ type: "scan-succeeded", scanSummary })),
    awarenessItemsArb.map((awarenessItems) =>
      cmd({ type: "analysis-succeeded", awarenessItems }),
    ),
    sizeEstimateArb.map((estimate) => cmd({ type: "backup-size-estimated", estimate })),
    backupHandleArb.map((handle) => cmd({ type: "backup-succeeded", handle })),
    fc.constant(cmd({ type: "execution-completed" })),
    fc.constant(cmd({ type: "block-on-user" })),
    fc
      .tuple(acceptanceResultsArb, fc.constantFrom("retry", "block", undefined))
      .map(([results, onFailure]) =>
        cmd({
          type: "verify-completed",
          results,
          onFailure: onFailure as "retry" | "block" | undefined,
        }),
      ),
    fc
      .record({ code: fc.string({ maxLength: 8 }), message: fc.string({ maxLength: 12 }) })
      .map((error) => cmd({ type: "error-occurred", error })),
    fc.constant(cmd({ type: "error-recovered" })),
  ];
}

/** 默认命令生成器（无额外安全不变量）。 */
export const commandArbs = buildCommandArbs();

/**
 * 生成一个随机命令序列的 arbitrary。
 *
 * @param invariants 注入到每条命令的安全不变量。
 * @param maxCommands 序列最大长度（默认 40，足以走完整条闭环并探索非法转移）。
 */
export function sessionCommandsArb(
  invariants: readonly SessionInvariant[] = [],
  maxCommands = 40,
): fc.Arbitrary<Iterable<fc.Command<SessionModel, RealSystem>>> {
  return fc.commands(buildCommandArbs(invariants), { maxCommands });
}

/** 为 `fc.modelRun` 提供成对的初始模型 + 真实系统（每次属性运行调用一次）。 */
export function makeSetup(): { model: SessionModel; real: RealSystem } {
  return { model: initialModel(), real: { session: createInitialSession() } };
}

/** 便捷封装：对一组命令执行 `fc.modelRun`（从全新初始状态出发）。 */
export function runCommandSequence(
  cmds: Iterable<fc.Command<SessionModel, RealSystem>>,
): void {
  fc.modelRun(makeSetup, cmds);
}
