// Feature: proactive-awareness-demo, Property 28: 备份体积二次确认门（安全关键）。*For any* Working_Directory 体积估算结果，当 `estimateSize` 的 `totalBytes` 超过阈值（`exceededThreshold=true`）时，Session 必经 `awaiting_backup_confirm` 状态、且在 `backupSizeConfirmed`（默认 false，仅用户二次确认置 true）为 true 之前绝不进入实际备份/`executing`（用户取消则转 `error`）；当未超阈值（`exceededThreshold=false`）时不需要该确认门，可直接进入实际备份。
//
// **Validates: Requirements 11.1, 11.2**
//
// 实现说明：本测试复用任务 14.3 搭建的可复用 fast-check 状态机模型框架
// （./sessionModel.ts，`fc.commands` / `fc.modelRun`）驱动随机用户/管线事件序列，对
// `transition` 施加两类校验：
//  (A) 模型对照（由框架内置）：每个事件在当前状态下「合法/被拒」及转移后状态、五个布尔门
//      与备份存在性必须与独立模型 `predict` 完全一致 —— 据此验证「非法状态转移被
//      transition 拒绝」，其中已镜像备份体积门（exceeded 时 backup-succeeded 须先确认）。
//  (B) Property 28 安全不变量（注入到每步之后）：
//      - 体积超阈值（exceededThreshold=true）后，状态绝不在 `backupSizeConfirmed=false`
//        时进入 `executing`（及其派生的执行链路状态）—— 即"二次确认前绝不进入实际备份/执行"。
//      - 任意处于执行链路的状态都满足纯谓词 `backupSizeGateSatisfied`。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SessionState,
  createInitialSession,
} from "../../src/orchestrator/session.js";
import type { Session, SizeEstimate } from "../../src/orchestrator/session.js";
import {
  transition,
  backupSizeGateSatisfied,
  requiresBackupSizeConfirm,
} from "../../src/orchestrator/stateMachine.js";
import type { SessionEvent } from "../../src/orchestrator/stateMachine.js";
import {
  sessionCommandsArb,
  runCommandSequence,
  FIXED_NOW,
  type SessionInvariant,
} from "./sessionModel.js";

// ---------------------------------------------------------------------------
// Property 28 安全不变量
// ---------------------------------------------------------------------------

/**
 * 「执行链路」状态：executing 及只能由 executing 经合法转移派生的后续状态。
 * 一旦到达这些状态，意味着 `backup-succeeded` 已发生（已进入实际备份/执行），
 * 因此备份体积门必须已满足。
 */
const EXECUTION_CHAIN_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  SessionState.Executing,
  SessionState.BlockedOnUser,
  SessionState.Verifying,
  SessionState.Delivered,
  SessionState.Accepted,
]);

/**
 * 备份体积二次确认门安全不变量：
 *  1. 体积估算超阈值（exceededThreshold=true）时，若尚未二次确认
 *     （backupSizeConfirmed=false），状态绝不进入执行链路（"确认前绝不进入实际备份/执行"）。
 *  2. 凡处于执行链路状态，纯谓词 `backupSizeGateSatisfied` 必为 true（门已满足）。
 */
const backupSizeGateInvariant: SessionInvariant = (s: Session) => {
  const est = s.backupSizeEstimate;
  if (est && est.exceededThreshold && !s.backupSizeConfirmed) {
    // 超阈值且未二次确认：绝不可能身处执行链路。
    expect(
      EXECUTION_CHAIN_STATES.has(s.state),
      `备份体积超阈值且未二次确认时，状态绝不能进入执行链路（当前 ${s.state}）`,
    ).toBe(false);
  }
  if (EXECUTION_CHAIN_STATES.has(s.state)) {
    // 进入执行链路 ⇒ 备份体积门必满足（未超阈值天然满足；超阈值则必已二次确认）。
    expect(
      backupSizeGateSatisfied(s),
      `进入 ${s.state} 时备份体积二次确认门必须满足`,
    ).toBe(true);
  }
};

describe("Property 28: 备份体积二次确认门（状态机模型测试）", () => {
  it("任意事件序列下：超阈值未确认绝不进入执行链路，执行链路恒满足体积门（A+B）", () => {
    fc.assert(
      fc.property(sessionCommandsArb([backupSizeGateInvariant]), (cmds) => {
        // runCommandSequence 内部从全新初始 Session 出发执行 fc.modelRun；
        // 模型对照(A) 与备份体积门不变量(B) 在每步之后由命令逐一断言。
        runCommandSequence(cmds);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 针对性必要性检验：超阈值/未超阈值/确认/取消四条路径的直接覆盖
  // -------------------------------------------------------------------------

  /** 把会话推进到 backing_up（三确认门齐备），返回该处的 Session。 */
  function driveToBackingUp(): Session {
    const now = () => FIXED_NOW;
    let s = createInitialSession();
    const apply = (event: SessionEvent) => {
      const r = transition(s, event, { now });
      if (r.ok) s = r.session;
      return r;
    };
    apply({ type: "scan" });
    apply({
      type: "scan-succeeded",
      scanSummary: { scannedAt: FIXED_NOW, platform: "darwin", recentDays: 7, items: [] },
    });
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
    apply({ type: "confirm-understanding" });
    apply({ type: "confirm-scope", workingDir: { rootAbsPath: "/tmp/work" } });
    apply({ type: "start-execution" });
    return s;
  }

  const EXCEEDED: SizeEstimate = {
    totalBytes: 800_000_000,
    fileCount: 3,
    exceededThreshold: true,
    thresholdBytes: 500_000_000,
  };
  const WITHIN: SizeEstimate = {
    totalBytes: 1_000,
    fileCount: 3,
    exceededThreshold: false,
    thresholdBytes: 500_000_000,
  };
  const HANDLE = {
    strategy: "file-snapshot" as const,
    workingDirRoot: "/tmp/work",
    createdAt: FIXED_NOW,
    rollbackInstruction: "restore",
  };
  const now = () => FIXED_NOW;

  it("超阈值：必经 awaiting_backup_confirm，且确认前 backup-succeeded 被拒、不进入 executing", () => {
    let s = driveToBackingUp();
    expect(s.state).toBe(SessionState.BackingUp);

    const est = transition(s, { type: "backup-size-estimated", estimate: EXCEEDED }, { now });
    expect(est.ok).toBe(true);
    if (est.ok) s = est.session;
    // 必经二次确认门状态。
    expect(s.state).toBe(SessionState.AwaitingBackupConfirm);
    expect(s.backupSizeConfirmed).toBe(false);

    // 确认前：直接 backup-succeeded 非法（状态不符），绝不进入 executing。
    const premature = transition(s, { type: "backup-succeeded", handle: HANDLE }, { now });
    expect(premature.ok).toBe(false);
    expect(premature.session.state).not.toBe(SessionState.Executing);

    // 二次确认后：回到 backing_up，门已满足。
    const confirmed = transition(s, { type: "confirm-backup-size" }, { now });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) s = confirmed.session;
    expect(s.state).toBe(SessionState.BackingUp);
    expect(s.backupSizeConfirmed).toBe(true);
    expect(backupSizeGateSatisfied(s)).toBe(true);

    // 现在 backup-succeeded 合法 → 进入 executing。
    const done = transition(s, { type: "backup-succeeded", handle: HANDLE }, { now });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.session.state).toBe(SessionState.Executing);
  });

  it("超阈值用户取消：转 error，绝不进入 executing", () => {
    let s = driveToBackingUp();
    const est = transition(s, { type: "backup-size-estimated", estimate: EXCEEDED }, { now });
    expect(est.ok).toBe(true);
    if (est.ok) s = est.session;
    expect(s.state).toBe(SessionState.AwaitingBackupConfirm);

    const cancelled = transition(s, { type: "cancel-backup-size" }, { now });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) s = cancelled.session;
    expect(s.state).toBe(SessionState.Error);
    expect(s.state).not.toBe(SessionState.Executing);
    expect(s.backupSizeConfirmed).toBe(false);
  });

  it("未超阈值：不需要二次确认门，停留 backing_up 并可直接进入实际备份/executing", () => {
    let s = driveToBackingUp();
    expect(requiresBackupSizeConfirm(WITHIN)).toBe(false);

    const est = transition(s, { type: "backup-size-estimated", estimate: WITHIN }, { now });
    expect(est.ok).toBe(true);
    if (est.ok) s = est.session;
    // 未超阈值：不进入 awaiting_backup_confirm，留在 backing_up。
    expect(s.state).toBe(SessionState.BackingUp);
    expect(s.backupSizeConfirmed).toBe(false);
    // 门天然满足（未超阈值无需确认）。
    expect(backupSizeGateSatisfied(s)).toBe(true);

    const done = transition(s, { type: "backup-succeeded", handle: HANDLE }, { now });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.session.state).toBe(SessionState.Executing);
  });
});
