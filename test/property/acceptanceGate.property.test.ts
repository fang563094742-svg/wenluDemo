// Feature: proactive-awareness-demo, Property 21: 验收门（安全关键）。*For any* 用户事件序列，Session 的 `accepted` 为 true 当且仅当序列中包含用户"确认完成"事件；不存在任何自动完成、超时或其他途径能使 `accepted` 变为 true。
//
// **Validates: Requirements 15.4, 15.6**
//
// 实现说明：本测试复用任务 14.3 搭建的可复用 fast-check 状态机模型框架
// （./sessionModel.ts，`fc.commands` / `fc.modelRun`）驱动随机用户/管线事件序列，
// 从两个互补角度验证「验收门」：
//  (A) 模型对照 + 注入安全不变量：用 `sessionCommandsArb([acceptanceGateInvariant])`
//      驱动事件序列；框架在每步之后断言 `accepted` 与独立模型 `predict` 完全一致
//      （predict 仅在 delivered 状态遇到 accept-delivery 事件才置 accepted=true），并额外
//      注入 Property 21 安全不变量：`accepted === true ⇒ state === accepted`，即除了用户
//      "确认完成"动作把会话推进到终态 `accepted`，没有任何其他途径能令 accepted 为 true。
//  (B) 充要性（iff）+ 无自动/超时路径：对一条随机原始事件序列手工重放 `transition`，
//      逐步检测 `accepted` 的「false→true」翻转——每次翻转都必须由 `accept-delivery`
//      事件、且当时状态为 `delivered` 触发；序列结束后断言
//      `session.accepted === （序列中发生过一次成功的 accept-delivery）`。
//      事件联合体中根本不存在任何"自动完成/超时"事件，故该断言同时证明「无自动/超时路径」。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SessionState,
  createInitialSession,
} from "../../src/orchestrator/session.js";
import type { Session, Task_Frame } from "../../src/orchestrator/session.js";
import { transition } from "../../src/orchestrator/stateMachine.js";
import type { SessionEvent } from "../../src/orchestrator/stateMachine.js";
import {
  sessionCommandsArb,
  runCommandSequence,
  FIXED_NOW,
  type SessionInvariant,
} from "./sessionModel.js";

// ===========================================================================
// Property 21 安全不变量（注入到状态机模型框架的每步之后）
// ===========================================================================

/**
 * 验收门安全不变量：`accepted === true` 蕴含 `state === accepted`。
 *
 * 理由：`accepted` 这个布尔门只能由用户"确认完成"动作（`accept-delivery`）置 true，而该
 * 动作仅在 `delivered` 状态合法，并把会话推进到终态 `accepted`。因此只要 accepted 为 true，
 * 会话必处于 `accepted` 终态——不存在任何「accepted 为 true 但状态不是 accepted」的中间态，
 * 也就排除了"自动完成/超时/其他途径"先置门再绕过状态推进的可能。
 */
const acceptanceGateInvariant: SessionInvariant = (s: Session) => {
  if (s.accepted) {
    expect(
      s.state,
      `accepted 为 true 时状态必须为 accepted（当前 ${s.state}）——验收只能由用户"确认完成"达成`,
    ).toBe(SessionState.Accepted);
  }
  // 反向：处于 accepted 终态，则 accepted 门必为 true（用户已确认完成）。
  if (s.state === SessionState.Accepted) {
    expect(s.accepted, "进入 accepted 终态时 accepted 门必为 true").toBe(true);
  }
};

describe("Property 21: 验收门（状态机模型测试）", () => {
  it("任意事件序列下：accepted 与模型一致，且 accepted===true ⇒ state===accepted（A）", () => {
    fc.assert(
      fc.property(sessionCommandsArb([acceptanceGateInvariant]), (cmds) => {
        // runCommandSequence 从全新初始 Session 出发执行 fc.modelRun；
        // 模型对照（accepted 字段逐步与 predict 比对）与验收门不变量在每步之后断言。
        runCommandSequence(cmds);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // (B) 充要性（iff）+ 无自动/超时路径：手工重放随机原始事件序列
  // -------------------------------------------------------------------------

  const taskFrame: Task_Frame = {
    awarenessItemId: "a1",
    objective: "obj",
    phases: [],
    resolvedPreconditions: [],
    confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
    acceptanceTests: [],
  };

  /** 覆盖**全部** SessionEvent 类型的最小原始事件生成器（payload 对验收门无关，取最简）。 */
  const anyEventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
    fc.constant<SessionEvent>({ type: "scan" }),
    fc.constant<SessionEvent>({
      type: "scan-succeeded",
      scanSummary: { scannedAt: FIXED_NOW, platform: "darwin", recentDays: 7, items: [] },
    }),
    fc.constant<SessionEvent>({ type: "analysis-succeeded", awarenessItems: [] }),
    fc.constant<SessionEvent>({ type: "accept-awareness", itemId: "a1" }),
    fc.constant<SessionEvent>({ type: "dismiss-awareness" }),
    fc.constant<SessionEvent>({ type: "answer", outcome: { kind: "continue" } }),
    fc.constant<SessionEvent>({ type: "answer", outcome: { kind: "sufficient", taskFrame } }),
    fc.constant<SessionEvent>({ type: "answer", outcome: { kind: "impasse" } }),
    fc.constant<SessionEvent>({ type: "confirm-understanding" }),
    fc.constant<SessionEvent>({ type: "supplement-understanding" }),
    fc.constantFrom("supplement", "force_execute", "abandon").map<SessionEvent>((choice) => ({
      type: "impasse-choice",
      choice: choice as "supplement" | "force_execute" | "abandon",
    })),
    fc.constant<SessionEvent>({ type: "confirm-scope", workingDir: { rootAbsPath: "/tmp/work" } }),
    fc.constant<SessionEvent>({ type: "start-execution" }),
    fc.boolean().map<SessionEvent>((exceeded) => ({
      type: "backup-size-estimated",
      estimate: {
        totalBytes: exceeded ? 800_000_000 : 1_000,
        fileCount: 3,
        exceededThreshold: exceeded,
        thresholdBytes: 500_000_000,
      },
    })),
    fc.constant<SessionEvent>({ type: "confirm-backup-size" }),
    fc.constant<SessionEvent>({ type: "cancel-backup-size" }),
    fc.constant<SessionEvent>({
      type: "backup-succeeded",
      handle: {
        strategy: "git-commit",
        workingDirRoot: "/tmp/work",
        createdAt: FIXED_NOW,
        rollbackInstruction: "git reset",
      },
    }),
    fc.constant<SessionEvent>({ type: "block-on-user" }),
    fc.constant<SessionEvent>({ type: "confirm-risk" }),
    fc.constant<SessionEvent>({ type: "reply-blocking" }),
    fc.constant<SessionEvent>({ type: "execution-completed" }),
    // verify-completed：非空且全通过 → delivered（可解锁 accept-delivery）；否则回 executing/block。
    fc.boolean().map<SessionEvent>((allPass) => ({
      type: "verify-completed",
      results: [
        {
          testId: "t1",
          description: "d",
          checkMethod: "m",
          passed: allPass,
          detail: "x",
        },
      ],
      onFailure: "block",
    })),
    fc.constant<SessionEvent>({ type: "accept-delivery" }),
    fc.constant<SessionEvent>({ type: "error-occurred", error: { code: "E", message: "m" } }),
    fc.constant<SessionEvent>({ type: "error-recovered" }),
  );

  it("充要性：序列结束时 accepted===true 当且仅当序列中发生过成功的 accept-delivery（B）", () => {
    fc.assert(
      fc.property(fc.array(anyEventArb, { maxLength: 40 }), (events) => {
        let s = createInitialSession();
        let sawSuccessfulAcceptDelivery = false;

        for (const ev of events) {
          const before = s;
          const r = transition(s, ev, { now: () => FIXED_NOW });
          if (!r.ok) {
            // 非法转移：状态与 accepted 门均不得改变。
            expect(r.session).toBe(before);
            expect(r.session.accepted).toBe(before.accepted);
            continue;
          }
          // 检测 accepted 的「false→true」翻转：唯一允许的来源是 delivered 上的 accept-delivery。
          if (!before.accepted && r.session.accepted) {
            expect(ev.type, "唯有 accept-delivery 能把 accepted 置为 true").toBe(
              "accept-delivery",
            );
            expect(before.state, "accept-delivery 仅在 delivered 状态合法").toBe(
              SessionState.Delivered,
            );
            sawSuccessfulAcceptDelivery = true;
          }
          // accepted 门一经置 true 不可被任何后续事件清除（单调，无回退路径）。
          if (before.accepted) {
            expect(r.session.accepted).toBe(true);
          }
          s = r.session;
        }

        // 双向蕴含：最终 accepted 为 true ⟺ 序列中确实发生过一次成功的用户"确认完成"。
        expect(s.accepted).toBe(sawSuccessfulAcceptDelivery);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 针对性示例：正常验收路径 + 「无自动/旁路」反例
  // -------------------------------------------------------------------------

  /** 把会话推进到 delivered（三确认门齐备、备份成功、验收测试全通过）。 */
  function driveToDelivered(): Session {
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
    apply({ type: "answer", outcome: { kind: "sufficient", taskFrame } });
    apply({ type: "confirm-understanding" });
    apply({ type: "confirm-scope", workingDir: { rootAbsPath: "/tmp/work" } });
    apply({ type: "start-execution" });
    apply({
      type: "backup-succeeded",
      handle: {
        strategy: "git-commit",
        workingDirRoot: "/tmp/work",
        createdAt: FIXED_NOW,
        rollbackInstruction: "git reset",
      },
    });
    apply({ type: "execution-completed" });
    apply({
      type: "verify-completed",
      results: [
        { testId: "t1", description: "d", checkMethod: "m", passed: true, detail: "ok" },
      ],
    });
    return s;
  }

  it("正常路径：delivered 上用户 accept-delivery → accepted=true 且进入 accepted 终态", () => {
    const s = driveToDelivered();
    expect(s.state).toBe(SessionState.Delivered);
    expect(s.accepted).toBe(false);

    const r = transition(s, { type: "accept-delivery" }, { now: () => FIXED_NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.state).toBe(SessionState.Accepted);
      expect(r.session.accepted).toBe(true);
    }
  });

  it("无旁路：delivered 上除 accept-delivery 外的任何事件都不会置 accepted=true", () => {
    const delivered = driveToDelivered();
    const nonAcceptEvents: SessionEvent[] = [
      { type: "execution-completed" },
      { type: "block-on-user" },
      { type: "confirm-risk" },
      { type: "reply-blocking" },
      { type: "scan" },
      { type: "start-execution" },
      { type: "confirm-understanding" },
      { type: "error-occurred", error: { code: "E", message: "m" } },
      { type: "error-recovered" },
    ];
    for (const ev of nonAcceptEvents) {
      const r = transition(delivered, ev, { now: () => FIXED_NOW });
      // 这些事件在 delivered 状态都非法（被拒），且 accepted 恒为 false。
      expect(r.ok, `事件 ${ev.type} 不应在 delivered 状态合法`).toBe(false);
      expect(r.session.accepted).toBe(false);
      expect(r.session.state).not.toBe(SessionState.Accepted);
    }
  });

  it("无早置：accept-delivery 在非 delivered 状态被拒，accepted 保持 false", () => {
    // 在 idle（以及任何非 delivered 状态）直接"确认完成"都不可能置 accepted。
    const idle = createInitialSession();
    const r = transition(idle, { type: "accept-delivery" }, { now: () => FIXED_NOW });
    expect(r.ok).toBe(false);
    expect(r.session.accepted).toBe(false);
    expect(r.session.state).toBe(SessionState.Idle);
  });
});
