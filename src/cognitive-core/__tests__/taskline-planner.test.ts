import { describe, expect, it } from "vitest";

import { decideTasklineNextStep, shrinkTasklineToSingleBlocker } from "../taskline-planner.js";

describe("shrinkTasklineToSingleBlocker", () => {
  it("优先收缩到唯一 blocker，而不是继续推进其它任务", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "写文档", status: "pending", priority: 95, evidence: "已有需求列表" },
      { id: "b", title: "装依赖", status: "blocked", priority: 70, blocker: "npm install 失败", unblockCost: 5, evidence: "npm ERR! network timeout" },
      { id: "c", title: "补测试", status: "in_progress", priority: 90, evidence: "已有 failing case" },
    ]);

    expect(plan.focusMode).toBe("single_blocker");
    expect(plan.chosenId).toBe("b");
    expect(plan.blocker).toContain("npm install 失败");
    expect(plan.deferredIds.sort()).toEqual(["a", "c"]);
  });

  it("多个 blocker 时选择最值得先解开的唯一阻塞", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "修权限", status: "blocked", priority: 80, blocker: "缺 token", unblockCost: 3, evidence: "401 screenshot" },
      { id: "b", title: "重建索引", status: "blocked", priority: 92, blocker: "磁盘占满", unblockCost: 40, evidence: "df -h 100%" },
    ]);

    expect(plan.focusMode).toBe("single_blocker");
    expect(plan.chosenId).toBe("b");
    expect(plan.nextStep).toContain("磁盘占满");
  });

  it("没有 blocker 时只选一个 ready 焦点，其余全部延后", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "补规则", status: "pending", priority: 88, evidence: "已有规则草案" },
      { id: "b", title: "写脚本", status: "in_progress", priority: 75, evidence: "已有半成品脚本" },
      { id: "c", title: "补文案", status: "pending", priority: 60, evidence: "已有用户原话" },
    ]);

    expect(plan.focusMode).toBe("execute_ready");
    expect(plan.chosenId).toBe("a");
    expect(plan.deferredIds.sort()).toEqual(["b", "c"]);
    expect(plan.nextStep).toContain("补规则");
  });

  it("活跃项没有证据时，先收缩到补证据而不是继续规划", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "看棋盘现状", status: "in_progress", priority: 95 },
      { id: "b", title: "推导下一步", status: "pending", priority: 90 },
      { id: "c", title: "修 OCR", status: "blocked", priority: 80, blocker: "日志为空" },
    ]);

    expect(plan.focusMode).toBe("need_evidence");
    expect(plan.chosenId).toBe("a");
    expect(plan.nextStep).toContain("先补证据");
  });

  it("全部完成时直接收口，不再制造新任务", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "补规则", status: "done", priority: 88 },
      { id: "b", title: "写脚本", status: "done", priority: 75 },
    ]);

    expect(plan.focusMode).toBe("all_clear");
    expect(plan.chosenId).toBeNull();
    expect(plan.nextStep).toContain("验收或收口");
  });

  it("chess 场景先补现场证据，再避免并列推进", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "focus_target_app", title: "确保 Chess 在前台", status: "done", priority: 100, evidence: "Chess front app observed" },
      { id: "capture_truth", title: "读取当前棋局现场", status: "in_progress", priority: 98 },
      { id: "identify_active_blocker", title: "判断唯一阻塞", status: "pending", priority: 92 },
      { id: "take_next_action", title: "执行一个直接减阻动作", status: "pending", priority: 88 },
      { id: "verify_effect", title: "验证动作效果", status: "pending", priority: 80 },
    ]);

    expect(plan.focusMode).toBe("need_evidence");
    expect(plan.chosenId).toBe("capture_truth");
    expect(plan.deferredIds.sort()).toEqual(["identify_active_blocker", "take_next_action", "verify_effect"]);
  });

  it("外部等待型 blocker 已留证时，优先进入等待而不是继续扩张", () => {
    const plan = shrinkTasklineToSingleBlocker([
      {
        id: "wait_opponent",
        title: "等待对手落子",
        status: "blocked",
        priority: 99,
        blocker: "当前不是我方回合",
        evidence: "turnHint=black",
        waitType: "opponent_moved",
        unblockCost: 1,
      },
      { id: "rebuild_notes", title: "整理复盘", status: "pending", priority: 60, evidence: "草稿已存在" },
    ]);

    expect(plan.focusMode).toBe("wait_external");
    expect(plan.chosenId).toBe("wait_opponent");
    expect(plan.nextStep).toContain("等待外部事件");
  });
});

describe("decideTasklineNextStep", () => {
  it("固化拆解、优先级、下一步和止损规则", () => {
    const decision = decideTasklineNextStep([
      { id: "a", title: "查日志", status: "pending", priority: 60, evidence: "已有错误时间点" },
      { id: "b", title: "修权限", status: "blocked", priority: 85, blocker: "缺少访问令牌", unblockCost: 3, evidence: "403 response" },
    ]);

    expect(decision.plan.focusMode).toBe("single_blocker");
    expect(decision.policy.taskBreakdown).toHaveLength(5);
    expect(decision.policy.taskBreakdown[2]).toContain("外部等待型 blocker");
    expect(decision.policy.priorityRule).toContain("priority 数值越大");
    expect(decision.policy.nextStepRule).toContain("只允许一个 chosenId");
    expect(decision.policy.stopRule).toContain("连续两轮没有新增证据");
  });
});
