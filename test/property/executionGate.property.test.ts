// Feature: proactive-awareness-demo, Property 13: 执行前置状态门（安全关键）。*For any* 用户事件序列，Session 进入 `executing` 状态当且仅当依次满足：`understandingConfirmed`（用户对"我可以开始执行吗"肯定确认）∧ `scopeConfirmed`（Working_Directory 已确认）∧ `executionConfirmed`（"开始执行"确认）∧ 备份成功创建（backup 非空）。任一前置未满足时，状态绝不进入 `backing_up` 之后，且 `Executor.run` 从不被调用。
//
// **Validates: Requirements 8.11, 9.4, 10.2, 10.3, 11.1, 11.2**
//
// 实现说明：本测试用任务 14.3 搭建的可复用 fast-check 状态机模型框架（./sessionModel.ts，
// `fc.commands` / `fc.modelRun`）驱动随机用户/管线事件序列，对 `transition` 施加两类校验：
//  (A) 模型对照：每个事件在当前状态下「合法/被拒」及转移后状态、五个布尔门必须与独立
//      模型 `predict` 完全一致 —— 据此验证「非法状态转移被 transition 拒绝」。
//  (B) Property 13 安全不变量（注入到每步之后）：只要 Session 处于 `executing`（或之后的
//      verifying/delivered/accepted/blocked_on_user 等执行链路状态），就必然
//      understandingConfirmed ∧ scopeConfirmed ∧ executionConfirmed ∧ backup != null。
//      即任一前置未满足，状态绝不进入 executing。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SessionState,
  createInitialSession,
} from "../../src/orchestrator/session.js";
import type { Session } from "../../src/orchestrator/session.js";
import {
  transition,
  executionPreconditionsMet,
} from "../../src/orchestrator/stateMachine.js";
import type { SessionEvent } from "../../src/orchestrator/stateMachine.js";
import {
  sessionCommandsArb,
  runCommandSequence,
  FIXED_NOW,
  type SessionInvariant,
} from "./sessionModel.js";

// ---------------------------------------------------------------------------
// Property 13 安全不变量
// ---------------------------------------------------------------------------

/**
 * 一旦进入「执行链路」（executing 及由 executing 派生的后续状态），四个执行前置必全满足：
 * understandingConfirmed ∧ scopeConfirmed ∧ executionConfirmed ∧ backup != null。
 *
 * 这些后续状态（blocked_on_user / verifying / delivered / accepted）只能从 executing
 * 经合法转移到达，因此它们也必然继承「四前置已满足」这一事实——任一前置未满足，
 * 状态绝不会进入 executing，自然也到不了这些后续状态。
 */
const EXECUTION_CHAIN_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  SessionState.Executing,
  SessionState.BlockedOnUser,
  SessionState.Verifying,
  SessionState.Delivered,
  SessionState.Accepted,
]);

const executionGateInvariant: SessionInvariant = (s: Session) => {
  if (EXECUTION_CHAIN_STATES.has(s.state)) {
    expect(
      s.understandingConfirmed,
      `进入 ${s.state} 时 understandingConfirmed 必须为 true`,
    ).toBe(true);
    expect(
      s.scopeConfirmed,
      `进入 ${s.state} 时 scopeConfirmed 必须为 true`,
    ).toBe(true);
    expect(
      s.executionConfirmed,
      `进入 ${s.state} 时 executionConfirmed 必须为 true`,
    ).toBe(true);
    expect(s.backup != null, `进入 ${s.state} 时 backup 必须非空`).toBe(true);
    // 与纯谓词保持一致（三用户确认门）。
    expect(executionPreconditionsMet(s)).toBe(true);
  }
};

describe("Property 13: 执行前置状态门（状态机模型测试）", () => {
  it("任意事件序列下：非法转移被拒，且 executing 链路恒满足四前置（A+B）", () => {
    fc.assert(
      fc.property(sessionCommandsArb([executionGateInvariant]), (cmds) => {
        // runCommandSequence 内部从全新初始 Session 出发执行 fc.modelRun；
        // 模型对照(A) 与执行前置门不变量(B) 在每步之后由命令逐一断言。
        runCommandSequence(cmds);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 针对性必要性检验：缺任一前置都无法进入 executing（防御性纵深的直接覆盖）
  // -------------------------------------------------------------------------

  /** 把会话推进到 backing_up，并按需置/不置各布尔门，返回该处的 Session。 */
  function driveToBackingUp(opts: {
    understanding: boolean;
    scope: boolean;
    execution: boolean;
  }): Session {
    const now = () => FIXED_NOW;
    let s = createInitialSession();
    const apply = (event: SessionEvent) => {
      const r = transition(s, event, { now });
      if (r.ok) s = r.session;
      return r;
    };
    apply({ type: "scan" });
    apply({ type: "scan-succeeded", scanSummary: { scannedAt: FIXED_NOW, platform: "darwin", recentDays: 7, items: [] } });
    apply({ type: "analysis-succeeded", awarenessItems: [] });
    apply({ type: "accept-awareness", itemId: "a1" });
    apply({
      type: "answer",
      outcome: {
        kind: "sufficient",
        taskFrame: {
          awarenessItemId: "a1",
          objective: "obj",
          phases: [],
          resolvedPreconditions: [],
          confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
          acceptanceTests: [],
        },
      },
    });
    if (opts.understanding) apply({ type: "confirm-understanding" });
    if (opts.scope) apply({ type: "confirm-scope", workingDir: { rootAbsPath: "/tmp/work" } });
    if (opts.execution) apply({ type: "start-execution" });
    return s;
  }

  it("正常路径：三确认门齐备 + 备份成功 → 进入 executing", () => {
    const s = driveToBackingUp({ understanding: true, scope: true, execution: true });
    expect(s.state).toBe(SessionState.BackingUp);
    const r = transition(
      s,
      {
        type: "backup-succeeded",
        handle: {
          strategy: "git-commit",
          workingDirRoot: "/tmp/work",
          createdAt: FIXED_NOW,
          rollbackInstruction: "git reset",
        },
      },
      { now: () => FIXED_NOW },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.state).toBe(SessionState.Executing);
      expect(r.session.backup).not.toBeNull();
      expect(r.session.understandingConfirmed).toBe(true);
      expect(r.session.scopeConfirmed).toBe(true);
      expect(r.session.executionConfirmed).toBe(true);
    }
  });

  it("缺 understandingConfirmed：backup-succeeded 不可能在 backing_up 触达（前置门挡在更早状态）", () => {
    // 不 confirm-understanding，则 confirm-scope/start-execution 在错误状态被拒，
    // 会话停在 awaiting_understanding，根本到不了 backing_up。
    const s = driveToBackingUp({ understanding: false, scope: true, execution: true });
    expect(s.state).toBe(SessionState.AwaitingUnderstanding);
    expect(s.understandingConfirmed).toBe(false);
    // 即便强行施加 backup-succeeded 也被拒（状态不符）。
    const r = transition(
      s,
      {
        type: "backup-succeeded",
        handle: {
          strategy: "git-commit",
          workingDirRoot: "/tmp/work",
          createdAt: FIXED_NOW,
          rollbackInstruction: "git reset",
        },
      },
      { now: () => FIXED_NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.session.state).not.toBe(SessionState.Executing);
  });

  it("防御性纵深：人为伪造 backing_up 但缺执行前置门 → backup-succeeded 被显式拒绝", () => {
    // 构造一个「状态为 backing_up 但布尔门未全置」的非法内部态，验证 backup-succeeded
    // 仍被执行前置门拦下，绝不进入 executing（Property 13 的充要性「门」侧）。
    const base = createInitialSession();
    const forged: Session = {
      ...base,
      state: SessionState.BackingUp,
      understandingConfirmed: true,
      scopeConfirmed: false, // 缺一个前置
      executionConfirmed: true,
    };
    const r = transition(
      forged,
      {
        type: "backup-succeeded",
        handle: {
          strategy: "git-commit",
          workingDirRoot: "/tmp/work",
          createdAt: FIXED_NOW,
          rollbackInstruction: "git reset",
        },
      },
      { now: () => FIXED_NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.session.state).toBe(SessionState.BackingUp);
  });

  it("备份体积超阈值且未二次确认时：backup-succeeded 被备份体积门拒绝（不进入 executing）", () => {
    let s = driveToBackingUp({ understanding: true, scope: true, execution: true });
    // 体积估算超阈值 → 进入 awaiting_backup_confirm（此处不做 confirm-backup-size）。
    const est = transition(
      s,
      {
        type: "backup-size-estimated",
        estimate: {
          totalBytes: 800_000_000,
          fileCount: 3,
          exceededThreshold: true,
          thresholdBytes: 500_000_000,
        },
      },
      { now: () => FIXED_NOW },
    );
    expect(est.ok).toBe(true);
    if (est.ok) s = est.session;
    expect(s.state).toBe(SessionState.AwaitingBackupConfirm);
    // 在 awaiting_backup_confirm 直接 backup-succeeded 非法（状态不符），绝不进入 executing。
    const r = transition(
      s,
      {
        type: "backup-succeeded",
        handle: {
          strategy: "file-snapshot",
          workingDirRoot: "/tmp/work",
          createdAt: FIXED_NOW,
          rollbackInstruction: "restore",
        },
      },
      { now: () => FIXED_NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.session.state).not.toBe(SessionState.Executing);
  });
});
