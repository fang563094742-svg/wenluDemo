import { describe, expect, it } from "vitest";
import { shrinkToSingleBlocker } from "../../src/planner/singleBlocker.js";

describe("shrinkToSingleBlocker", () => {
  it("returns the single root blocker when nothing is ready", () => {
    const result = shrinkToSingleBlocker({
      goal: "ship feature",
      items: [
        { id: "a", title: "collect logs", status: "done", priority: 1 },
        { id: "b", title: "fix env", status: "blocked", priority: 2, blockedBy: ["a"], evidence: "permission denied" },
        { id: "c", title: "run deploy", status: "pending", priority: 3, blockedBy: ["b"] },
      ],
    });

    expect(result.highestPriorityReady).toBeNull();
    expect(result.uniqueBlocker?.id).toBe("b");
    expect(result.nextAction).toContain("fix env");
  });

  it("prefers the highest priority ready item before chasing lower-priority dependency chains", () => {
    const result = shrinkToSingleBlocker({
      goal: "ship feature",
      items: [
        { id: "a", title: "write patch", status: "pending", priority: 2 },
        { id: "b", title: "collect fixture", status: "pending", priority: 1 },
        { id: "c", title: "run tests", status: "pending", priority: 3, blockedBy: ["a"] },
      ],
    });

    expect(result.highestPriorityReady?.id).toBe("b");
    expect(result.uniqueBlocker).toBeNull();
    expect(result.nextAction).toContain("collect fixture");
  });

  it("returns the highest priority ready in-progress item when no blockers exist", () => {
    const result = shrinkToSingleBlocker({
      goal: "close loop",
      items: [
        { id: "a", title: "collect evidence", status: "in_progress", priority: 1 },
        { id: "b", title: "write summary", status: "pending", priority: 2, blockedBy: ["a"] },
      ],
    });

    expect(result.highestPriorityReady?.id).toBe("a");
    expect(result.uniqueBlocker).toBeNull();
    expect(result.nextAction).toContain("collect evidence");
  });
});
