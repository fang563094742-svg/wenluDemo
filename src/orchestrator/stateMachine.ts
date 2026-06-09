/**
 * proactive-awareness-demo —— Orchestrator / Session 状态转移与状态门（任务 14.2）。
 *
 * 职责（仅限本任务）：
 *  - 用一个**纯/近纯**的事件驱动状态机驱动 `Session` 走完 design.md「Session 状态机」
 *    定义的全部转移（扫描→分析→察觉→澄清→定面→定界→确认→备份→执行→验收）。
 *  - 强制四类安全关键状态门：
 *      1. **执行前置门**（Property 13 / R8.11、R9.4、R10.2/3/4、R11.1）：仅当
 *         `understandingConfirmed ∧ scopeConfirmed ∧ executionConfirmed ∧ 备份已创建`
 *         全部满足，Session 才允许进入 `executing`。
 *      2. **备份体积二次确认门**（Property 28 / R11.1、R11.2）：备份体积超阈值时必经
 *         `awaiting_backup_confirm`，且在 `backupSizeConfirmed` 为 true 前绝不进入实际备份/
 *         `executing`；用户取消则转 `error`、绝不进入 `executing`。
 *      3. **verifying 强制验收门**（R12.5、R15.1）：`executing` 声称完成后必经
 *         `verifying`，由 {@link decideAfterVerify} 裁决——验收测试存在且全部通过才进入
 *         `delivered`，否则回 `executing` 重试或转 `blocked_on_user`。
 *      4. **验收门**（Property 21 / R15.4、R15.6）：`accepted` 只能由用户"确认完成"动作置
 *         true，不存在任何自动/超时路径。
 *
 * **布尔门不变量**（本模块强制）：五个布尔门
 * `understandingConfirmed` / `scopeConfirmed` / `executionConfirmed` /
 * `backupSizeConfirmed` / `accepted` 只能由其对应的**用户 REST 动作事件**置 `true`
 * （分别为 `confirm-understanding` / `confirm-scope` / `start-execution` /
 * `confirm-backup-size` / `accept-delivery`）。任何内部管线事件都不会触碰这五个门，
 * 因此状态门不可被绕过。
 *
 * **纯度说明**：{@link transition} 不修改入参 `session`，而是返回一个**新的** `Session`
 * 对象（不可变更新），唯一的副作用面是 `updatedAt` 时间戳——可经 `options.now` 注入时钟
 * 使其在测试中完全确定。该设计便于任务 14.3/14.4/14.5 用 `fast-check` 的
 * `fc.commands` / `fc.modelRun` 搭建 `SessionModel` + 各端点 Command 做状态机模型测试
 * （非法状态转移会被 `transition` 以 `{ ok: false }` 拒绝，而非抛错）。
 *
 * 范围说明：本模块只承载"状态如何转移 + 状态门"的逻辑，**不**接线扫描/分析/执行等真实
 * 模块（属任务 14.6 `orchestrator.ts`），也不调用 Executor。事件载荷引用到的跨模块类型
 * 暂从 `session.ts` 的自洽占位定义导入（最终对齐见任务 14.6）。
 *
 * _Requirements: 8.11, 9.4, 10.2, 10.3, 10.4, 11.1, 11.2, 12.5, 15.1, 15.4, 15.6_
 */

import { SessionState } from "./session.js";
import type {
  Session,
  Scan_Summary,
  Awareness_Item,
  Task_Frame,
  WorkingDirectory,
  BackupHandle,
  SizeEstimate,
  AcceptanceTestResult,
} from "./session.js";
import { decideAfterVerify } from "../delivery/decideAfterVerify.js";

// 复用 Delivery_Verifier 的验收裁决纯函数作为 verifying 强制验收门的单一来源
// （R12.5/R15.1, design Property 26），并对外 re-export 供 14.5 验收门测试复用。
export { decideAfterVerify };

// ===========================================================================
// 事件模型 —— 驱动状态机的离散事件
//
// 分两类：
//  - 用户 REST 动作事件（USER_ACTION_EVENT_TYPES）：对应 Conversation_UI 的离散动作，
//    其中五个会置布尔门。
//  - 内部管线事件：由 Orchestrator 在驱动各模块（scanner/analyzer/clarifier/backup/
//    executor/delivery）时产生，仅改变状态与承载产物，绝不置布尔门。
// ===========================================================================

/** 非致命错误载荷（与 `Session.lastError` 结构一致）。 */
export interface SessionErrorInfo {
  code: string;
  message: string;
}

/**
 * 用户在 `clarifying` 状态提交一次答复（`POST /answer`）后，Clarifier 的评估结果。
 * 由 Clarifier（任务 7.9）产出，决定澄清是继续、充分（产出 Task_Frame）还是僵局。
 */
export type ClarifyOutcome =
  | { kind: "continue" }
  | { kind: "sufficient"; taskFrame: Task_Frame }
  | { kind: "impasse" };

/**
 * 驱动 Session 状态机的事件联合体。
 *
 * 设置布尔门的事件（仅此五个）：
 *  - `confirm-understanding`  → `understandingConfirmed`（R8.11）
 *  - `confirm-scope`          → `scopeConfirmed`（R9.4）
 *  - `start-execution`        → `executionConfirmed`（R10.2/10.3/10.4）
 *  - `confirm-backup-size`    → `backupSizeConfirmed`（R11.2）
 *  - `accept-delivery`        → `accepted`（R15.4/15.6）
 */
export type SessionEvent =
  // ---- 用户 REST 动作事件 ----------------------------------------------------
  /** `POST /scan`：手动触发一次扫描（R1.1/R1.2）。 */
  | { type: "scan" }
  /** `POST /accept`：接受某条 Awareness_Item，进入澄清（R8.1）。 */
  | { type: "accept-awareness"; itemId: string }
  /** 用户忽略全部察觉 / 本次无可执行事项，回到 idle（R7.3）。 */
  | { type: "dismiss-awareness" }
  /** `POST /answer`：回答澄清问题，附带 Clarifier 评估结果（R8.6-8.9, R8.12）。 */
  | { type: "answer"; outcome: ClarifyOutcome }
  /** `POST /confirm-understanding`：对"我可以开始执行吗"作肯定确认（R8.11）。置门。 */
  | { type: "confirm-understanding" }
  /** 用户对当前理解提出补充/否定，退回继续澄清（R8.11 反向）。 */
  | { type: "supplement-understanding" }
  /** 僵局三选一（R8.12）：补充信息 / 高风险下强制执行 / 放弃任务。 */
  | { type: "impasse-choice"; choice: "supplement" | "force_execute" | "abandon" }
  /** `POST /confirm-scope`：确认 Working_Directory（R9.4）。置门，落定工作目录。 */
  | { type: "confirm-scope"; workingDir: WorkingDirectory }
  /** `POST /start-execution`："开始执行"最终确认（R10.2/10.3/10.4）。置门。 */
  | { type: "start-execution" }
  /** `POST /confirm-backup-size`：备份体积超阈值时的二次确认（R11.2）。置门。 */
  | { type: "confirm-backup-size" }
  /** 用户取消备份（体积二次确认时取消）→ 中止执行（R11.2）。 */
  | { type: "cancel-backup-size" }
  /** `POST /confirm-risk`：高危动作确认放行后恢复执行（R13.3）。 */
  | { type: "confirm-risk" }
  /** `POST /answer`（执行中阻断性提问）：答复后恢复执行（R14.4）。 */
  | { type: "reply-blocking" }
  /** `POST /accept-delivery`：用户"确认完成"验收（R15.5）。置门。 */
  | { type: "accept-delivery" }
  // ---- 内部管线事件（不置任何布尔门）----------------------------------------
  /** 扫描成功，产出 Scan_Summary（R1.4）。 */
  | { type: "scan-succeeded"; scanSummary: Scan_Summary }
  /** 分析成功，产出 Awareness_Item[]（≤3）。 */
  | { type: "analysis-succeeded"; awarenessItems: Awareness_Item[] }
  /** 进入 backing_up 后的体积估算结果；超阈值则转 awaiting_backup_confirm（R11）。 */
  | { type: "backup-size-estimated"; estimate: SizeEstimate }
  /** 备份成功创建 → 进入执行（受执行前置门 + 备份体积门约束，R11.1）。 */
  | { type: "backup-succeeded"; handle: BackupHandle }
  /** 执行循环声称完成 → 进入 verifying 强制验收（R12.5/R15.1）。 */
  | { type: "execution-completed" }
  /** 执行中遇到高危动作 / 阻断性问题 → 暂停（R13.1/R14.2）。 */
  | { type: "block-on-user"; reason?: string }
  /** verifying 验收测试完成，附结果集；裁决见 decideAfterVerify（R12.5/R15.1）。 */
  | {
      type: "verify-completed";
      results: AcceptanceTestResult[];
      /** 存在 failed 时的处理：回 executing 重试或转 blocked_on_user（默认 block）。 */
      onFailure?: "retry" | "block";
    }
  /** 非致命错误：当前处理阶段转 error，服务保持运行（R1.5/R5.5/R11.2）。 */
  | { type: "error-occurred"; error: SessionErrorInfo }
  /** 从 error 恢复回 idle，服务保持可运行（R1.6/R5.6）。 */
  | { type: "error-recovered" };

/** 用户 REST 动作事件类型集合（其余为内部管线事件）。 */
export const USER_ACTION_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "scan",
  "accept-awareness",
  "dismiss-awareness",
  "answer",
  "confirm-understanding",
  "supplement-understanding",
  "impasse-choice",
  "confirm-scope",
  "start-execution",
  "confirm-backup-size",
  "cancel-backup-size",
  "confirm-risk",
  "reply-blocking",
  "accept-delivery",
]);

/** 是否为用户 REST 动作事件（与内部管线事件区分）。 */
export function isUserActionEvent(event: SessionEvent): boolean {
  return USER_ACTION_EVENT_TYPES.has(event.type);
}

// ===========================================================================
// 转移结果类型
// ===========================================================================

/** 合法转移：返回不可变更新后的新 Session。 */
export interface TransitionOk {
  ok: true;
  session: Session;
}

/** 非法转移：返回原 Session（未改动）与描述性拒绝原因。 */
export interface TransitionRejected {
  ok: false;
  reason: string;
  session: Session;
}

export type TransitionResult = TransitionOk | TransitionRejected;

/** 转移可选项。 */
export interface TransitionOptions {
  /** 注入时钟（返回 ISO8601 字符串），便于测试确定性；默认取当前时刻。 */
  now?: () => string;
}

// ===========================================================================
// 状态门纯谓词（安全关键，便于独立做 property-based 测试）
// ===========================================================================

/**
 * 执行前置门（Property 13 的"门"部分）：三个用户确认门是否全部满足。
 *
 * 注意：完整的"可进入 executing"还要求**备份已成功创建**（backup 非空）——该条件由
 * `backup-succeeded` 事件在 `backing_up → executing` 时一并落实（事件会写入 `backup`），
 * 故进入 `executing` 后必有 `understandingConfirmed ∧ scopeConfirmed ∧
 * executionConfirmed ∧ backup != null`（R8.11、R9.4、R10、R11.1）。
 */
export function executionPreconditionsMet(session: Session): boolean {
  return (
    session.understandingConfirmed &&
    session.scopeConfirmed &&
    session.executionConfirmed
  );
}

/** 备份体积是否需要二次确认门（即估算结果是否超阈值，R11）。 */
export function requiresBackupSizeConfirm(estimate: SizeEstimate): boolean {
  return estimate.exceededThreshold;
}

/**
 * 备份体积二次确认门（Property 28 的"门"部分）：
 * 若已有体积估算且超阈值，则必须 `backupSizeConfirmed === true` 才算满足；
 * 否则（未超阈值，或尚无估算）天然满足。
 */
export function backupSizeGateSatisfied(session: Session): boolean {
  const est = session.backupSizeEstimate;
  if (est && est.exceededThreshold) {
    return session.backupSizeConfirmed === true;
  }
  return true;
}

// ===========================================================================
// transition —— 纯/近纯状态转移核心
// ===========================================================================

/** 可发生非致命错误（→ error）的"处理中"状态集合。 */
const ERRORABLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
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

function reject(session: Session, reason: string): TransitionRejected {
  return { ok: false, reason, session };
}

function commit(
  session: Session,
  patch: Partial<Session>,
  now: string,
): TransitionOk {
  return { ok: true, session: { ...session, ...patch, updatedAt: now } };
}

/**
 * 对 `session` 施加一个事件，返回新的会话状态或拒绝结果。
 *
 * - **不修改入参**：返回全新的 `Session` 对象（不可变更新），可安全用于状态机模型测试。
 * - **非法事件被拒**：在当前状态不允许的事件返回 `{ ok: false, reason }`，绝不抛错、
 *   绝不改变状态门——这正是各安全关键状态门"不可绕过"的体现。
 *
 * @param session 当前会话（不会被修改）。
 * @param event   要施加的事件。
 * @param options 可选项（注入时钟）。
 */
export function transition(
  session: Session,
  event: SessionEvent,
  options: TransitionOptions = {},
): TransitionResult {
  const now = options.now?.() ?? new Date().toISOString();
  const S = SessionState;

  switch (event.type) {
    // ---- idle / 扫描 / 分析 / 察觉 -----------------------------------------
    case "scan": {
      if (session.state !== S.Idle) {
        return reject(session, `scan 仅在 idle 状态合法（当前 ${session.state}）`);
      }
      return commit(session, { state: S.Scanning }, now);
    }

    case "scan-succeeded": {
      if (session.state !== S.Scanning) {
        return reject(session, `scan-succeeded 仅在 scanning 状态合法（当前 ${session.state}）`);
      }
      return commit(
        session,
        { scanSummary: event.scanSummary, state: S.Analyzing },
        now,
      );
    }

    case "analysis-succeeded": {
      if (session.state !== S.Analyzing) {
        return reject(session, `analysis-succeeded 仅在 analyzing 状态合法（当前 ${session.state}）`);
      }
      return commit(
        session,
        { awarenessItems: event.awarenessItems, state: S.AwarenessPresented },
        now,
      );
    }

    case "accept-awareness": {
      if (session.state !== S.AwarenessPresented) {
        return reject(session, `accept-awareness 仅在 awareness_presented 状态合法（当前 ${session.state}）`);
      }
      return commit(
        session,
        { acceptedItemId: event.itemId, state: S.Clarifying },
        now,
      );
    }

    case "dismiss-awareness": {
      if (session.state !== S.AwarenessPresented) {
        return reject(session, `dismiss-awareness 仅在 awareness_presented 状态合法（当前 ${session.state}）`);
      }
      return commit(session, { state: S.Idle }, now);
    }

    // ---- 澄清定面 -----------------------------------------------------------
    case "answer": {
      if (session.state !== S.Clarifying) {
        return reject(session, `answer 仅在 clarifying 状态合法（当前 ${session.state}）`);
      }
      const outcome = event.outcome;
      if (outcome.kind === "continue") {
        // 下一轮澄清问题：停留 clarifying（R8.6）。
        return commit(session, { state: S.Clarifying }, now);
      }
      if (outcome.kind === "sufficient") {
        // 信息充分 → 产出 Task_Frame，进入"我可以开始执行吗"等待肯定确认（R8.7-8.11）。
        return commit(
          session,
          { taskFrame: outcome.taskFrame, state: S.AwaitingUnderstanding },
          now,
        );
      }
      // outcome.kind === "impasse"：达最大轮次仍有高风险，进入三选一僵局（R8.12）。
      return commit(session, { state: S.Impasse }, now);
    }

    case "confirm-understanding": {
      if (session.state !== S.AwaitingUnderstanding) {
        return reject(session, `confirm-understanding 仅在 awaiting_understanding 状态合法（当前 ${session.state}）`);
      }
      // 置执行前置门之一：用户对"基于以上理解，我可以开始执行吗"作肯定确认（R8.11）。
      return commit(
        session,
        { understandingConfirmed: true, state: S.ScopeConfirm },
        now,
      );
    }

    case "supplement-understanding": {
      if (session.state !== S.AwaitingUnderstanding) {
        return reject(session, `supplement-understanding 仅在 awaiting_understanding 状态合法（当前 ${session.state}）`);
      }
      // 用户提出补充/否定 → 退回继续澄清（不置门）。
      return commit(session, { state: S.Clarifying }, now);
    }

    case "impasse-choice": {
      if (session.state !== S.Impasse) {
        return reject(session, `impasse-choice 仅在 impasse 状态合法（当前 ${session.state}）`);
      }
      if (event.choice === "supplement") {
        return commit(session, { state: S.Clarifying }, now);
      }
      if (event.choice === "force_execute") {
        // 高风险下强制执行：仍须经定界 + 最终确认门，不跳过任何后续状态门（R8.12）。
        return commit(session, { state: S.ScopeConfirm }, now);
      }
      // abandon：放弃任务回 idle。
      return commit(session, { state: S.Idle }, now);
    }

    // ---- 定界 / 最终确认 ----------------------------------------------------
    case "confirm-scope": {
      if (session.state !== S.ScopeConfirm) {
        return reject(session, `confirm-scope 仅在 scope_confirm 状态合法（当前 ${session.state}）`);
      }
      // 置执行前置门之一：Working_Directory 经用户确认（R9.4）。
      return commit(
        session,
        {
          scopeConfirmed: true,
          workingDir: event.workingDir,
          state: S.ReadyConfirm,
        },
        now,
      );
    }

    case "start-execution": {
      if (session.state !== S.ReadyConfirm) {
        return reject(session, `start-execution 仅在 ready_confirm 状态合法（当前 ${session.state}）`);
      }
      // 置执行前置门之一："开始执行"最终确认（R10.2/10.3/10.4）。进入备份阶段。
      return commit(
        session,
        { executionConfirmed: true, state: S.BackingUp },
        now,
      );
    }

    // ---- 备份（含体积二次确认门）-------------------------------------------
    case "backup-size-estimated": {
      if (session.state !== S.BackingUp) {
        return reject(session, `backup-size-estimated 仅在 backing_up 状态合法（当前 ${session.state}）`);
      }
      // 超阈值 → 必经 awaiting_backup_confirm 二次确认门（R11, Property 28）。
      const nextState = requiresBackupSizeConfirm(event.estimate)
        ? S.AwaitingBackupConfirm
        : S.BackingUp;
      return commit(
        session,
        { backupSizeEstimate: event.estimate, state: nextState },
        now,
      );
    }

    case "confirm-backup-size": {
      if (session.state !== S.AwaitingBackupConfirm) {
        return reject(session, `confirm-backup-size 仅在 awaiting_backup_confirm 状态合法（当前 ${session.state}）`);
      }
      // 置备份体积二次确认门：用户确认继续备份（R11.2）。
      return commit(
        session,
        { backupSizeConfirmed: true, state: S.BackingUp },
        now,
      );
    }

    case "cancel-backup-size": {
      if (session.state !== S.AwaitingBackupConfirm) {
        return reject(session, `cancel-backup-size 仅在 awaiting_backup_confirm 状态合法（当前 ${session.state}）`);
      }
      // 用户取消 → 中止执行，绝不进入 executing（R11.2）。
      return commit(
        session,
        {
          state: S.Error,
          lastError: {
            code: "BACKUP_CANCELLED",
            message: "用户取消了备份体积二次确认，已中止本次执行。",
          },
        },
        now,
      );
    }

    case "backup-succeeded": {
      if (session.state !== S.BackingUp) {
        return reject(session, `backup-succeeded 仅在 backing_up 状态合法（当前 ${session.state}）`);
      }
      // 执行前置门（防御性纵深）：正常路径下三门必为 true，仍在此再次校验，
      // 确保进入 executing 当且仅当全部前置满足（R8.11/R9.4/R10, Property 13）。
      if (!executionPreconditionsMet(session)) {
        return reject(
          session,
          "执行前置门未满足：understandingConfirmed/scopeConfirmed/executionConfirmed 必须全部为 true。",
        );
      }
      // 备份体积二次确认门：超阈值时必须已二次确认（R11.2, Property 28）。
      if (!backupSizeGateSatisfied(session)) {
        return reject(
          session,
          "备份体积二次确认门未满足：体积超阈值但 backupSizeConfirmed 仍为 false。",
        );
      }
      return commit(session, { backup: event.handle, state: S.Executing }, now);
    }

    // ---- 执行 / 阻断 / 验收 -------------------------------------------------
    case "block-on-user": {
      if (session.state !== S.Executing) {
        return reject(session, `block-on-user 仅在 executing 状态合法（当前 ${session.state}）`);
      }
      // 高危动作 / 阻断性问题暂停执行（R13.1/R14.2）。
      return commit(session, { state: S.BlockedOnUser }, now);
    }

    case "confirm-risk":
    case "reply-blocking": {
      if (session.state !== S.BlockedOnUser) {
        return reject(session, `${event.type} 仅在 blocked_on_user 状态合法（当前 ${session.state}）`);
      }
      // 用户确认高危 / 答复阻断性问题后恢复执行循环（R13.3/R14.4）。
      return commit(session, { state: S.Executing }, now);
    }

    case "execution-completed": {
      if (session.state !== S.Executing) {
        return reject(session, `execution-completed 仅在 executing 状态合法（当前 ${session.state}）`);
      }
      // 声称完成 → 必经 verifying 强制验收门（R12.5/R15.1）。
      return commit(session, { state: S.Verifying }, now);
    }

    case "verify-completed": {
      if (session.state !== S.Verifying) {
        return reject(session, `verify-completed 仅在 verifying 状态合法（当前 ${session.state}）`);
      }
      // verifying 强制验收门：验收测试存在且全部通过才进入 delivered（R12.5/R15.1）。
      const verdict = decideAfterVerify(event.results);
      if (verdict === "delivered") {
        return commit(
          session,
          { acceptanceTestResults: event.results, state: S.Delivered },
          now,
        );
      }
      // 存在 failed（或空集合）：回 executing 重试，或转 blocked_on_user 让用户三选一。
      const onFailure = event.onFailure ?? "block";
      const nextState = onFailure === "retry" ? S.Executing : S.BlockedOnUser;
      return commit(
        session,
        { acceptanceTestResults: event.results, state: nextState },
        now,
      );
    }

    case "accept-delivery": {
      if (session.state !== S.Delivered) {
        return reject(session, `accept-delivery 仅在 delivered 状态合法（当前 ${session.state}）`);
      }
      // 验收门：仅用户"确认完成"置 accepted=true，无任何自动/超时路径（R15.4/15.6）。
      return commit(session, { accepted: true, state: S.Accepted }, now);
    }

    // ---- 错误处理 -----------------------------------------------------------
    case "error-occurred": {
      if (!ERRORABLE_STATES.has(session.state)) {
        return reject(session, `error-occurred 在 ${session.state} 状态不适用`);
      }
      // 非致命错误：转 error，服务保持运行（R1.5/R5.5/R11.2）。
      return commit(
        session,
        { state: S.Error, lastError: event.error },
        now,
      );
    }

    case "error-recovered": {
      if (session.state !== S.Error) {
        return reject(session, `error-recovered 仅在 error 状态合法（当前 ${session.state}）`);
      }
      // 回到 idle，服务保持可运行（R1.6/R5.6）。
      return commit(session, { state: S.Idle, lastError: undefined }, now);
    }

    default: {
      const _never: never = event;
      return reject(session, `未知事件: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * 判断事件在当前会话状态下是否为合法转移（不产生新状态，仅做判定）。
 * 便于状态机模型测试（14.3/14.4/14.5）的 Command 前置条件检查。
 */
export function canApply(session: Session, event: SessionEvent): boolean {
  return transition(session, event).ok;
}
