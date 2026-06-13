import { describe, expect, it } from "vitest";

import { shrinkToSingleBlocker } from "../singleBlocker.js";

describe("shrinkToSingleBlocker", () => {
  it("picks the smallest priority ready item", () => {
    const plan = shrinkToSingleBlocker({
      goal: "ship fix",
      items: [
        { id: "c", title: "low", status: "pending", priority: 30 },
        { id: "a", title: "high", status: "pending", priority: 10 },
        { id: "b", title: "mid", status: "in_progress", priority: 20 },
      ],
    });

    expect(plan.highestPriorityReady?.id).toBe("a");
    expect(plan.uniqueBlocker).toBeNull();
    expect(plan.nextAction).toContain("high");
  });

  it("shrinks to the smallest priority root blocker when nothing is ready", () => {
    const plan = shrinkToSingleBlocker({
      goal: "ship fix",
      items: [
        { id: "root-b", title: "second blocker", status: "blocked", priority: 20 },
        { id: "root-a", title: "first blocker", status: "blocked", priority: 10 },
        { id: "child", title: "downstream work", status: "pending", priority: 5, blockedBy: ["root-b"] },
      ],
    });

    expect(plan.highestPriorityReady).toBeNull();
    expect(plan.uniqueBlocker?.id).toBe("root-a");
    expect(plan.nextAction).toContain("first blocker");
  });

  it("treats missing priority as lowest priority", () => {
    const plan = shrinkToSingleBlocker({
      goal: "ship fix",
      items: [
        { id: "explicit", title: "explicit", status: "pending", priority: 10 },
        { id: "missing", title: "missing", status: "pending" },
      ],
    });

    expect(plan.highestPriorityReady?.id).toBe("explicit");
  });
});
