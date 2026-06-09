import { describe, expect, it } from "vitest";
import { inspectGoalMonitor } from "../../src/goalMonitor.js";

describe("inspectGoalMonitor", () => {
  const goal = {
    dimensions: [
      { id: "g_results", name: "结果", current: 15, target: 100, lastEvidence: "尚无真实外发" },
      { id: "g_understand", name: "理解", current: 26, target: 100, lastEvidence: "有阶段性理解" },
    ],
  };

  it("marks busy text actions without shrink evidence as no progress", () => {
    const monitor = inspectGoalMonitor({
      goal,
      recentActions: [
        "add_belief 用户很重视一致性",
        "add_knowledge 记录新的规则文本",
        "say_to_user 汇报机制修复",
      ],
      lastGoalUpdateCycle: undefined,
      currentCycle: 816,
      noveltyCount: 3,
    });

    expect(monitor.largestGap?.dimensionId).toBe("g_results");
    expect(monitor.hasShrinkSignal).toBe(false);
    expect(monitor.deltaSignal.strongestEvidenceType).toBe("understanding");
    expect(monitor.deltaSignal.summary).toContain("未命中最大差距维度");
  });

  it("treats result evidence on the largest gap dimension as progress", () => {
    const monitor = inspectGoalMonitor({
      goal,
      recentActions: [
        "update_goal g_results 当前真实外发留证+1",
        "公开外发 发送证据 已留证",
        "收款链 result evidence",
      ],
      lastGoalUpdateCycle: 816,
      currentCycle: 816,
      noveltyCount: 2,
    });

    expect(monitor.largestGap?.dimensionId).toBe("g_results");
    expect(monitor.deltaSignal.strongestEvidenceType).toBe("goal_update");
    expect(monitor.hasShrinkSignal).toBe(true);
    expect(monitor.deltaSignal.summary).toContain("已命中最大差距维度 g_results");
  });
});
