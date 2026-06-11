import { describe, expect, it } from "vitest";
import { decideTasklineNextStep, shrinkTasklineToSingleBlocker } from "../../src/cognitive-core/taskline-planner.js";

describe("taskline planner", () => {
  it("shrinks to evidence collection before execution", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "run verify", status: "in_progress", priority: 90 },
      { id: "b", title: "write docs", status: "pending", priority: 50, evidence: "drafted" },
    ]);

    expect(plan.focusMode).toBe("need_evidence");
    expect(plan.chosenId).toBe("a");
    expect(plan.deferredIds).toContain("b");
  });

  it("shrinks multiple blocked tasks to one blocker", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "task a", status: "blocked", priority: 80, blocker: "missing token", evidence: "saw 401", unblockCost: 10 },
      { id: "b", title: "task b", status: "blocked", priority: 60, blocker: "missing file", evidence: "ENOENT", unblockCost: 5 },
      { id: "c", title: "task c", status: "pending", priority: 99, evidence: "ready" },
    ]);

    expect(plan.focusMode).toBe("single_blocker");
    expect(plan.chosenId).toBe("a");
    expect(plan.nextStep).toContain("只解一个阻塞");
    expect(plan.deferredIds).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("chooses one ready item when no blocker exists", () => {
    const decision = decideTasklineNextStep([
      { id: "a", title: "task a", status: "pending", priority: 40, evidence: "ok" },
      { id: "b", title: "task b", status: "in_progress", priority: 40, evidence: "ok" },
    ]);

    expect(decision.plan.focusMode).toBe("execute_ready");
    expect(decision.plan.chosenId).toBe("b");
    expect(decision.policy.nextStepRule).toContain("只输出一个");
  });

  it("returns all_clear for done tasks", () => {
    const plan = shrinkTasklineToSingleBlocker([
      { id: "a", title: "task a", status: "done", priority: 1, evidence: "done" },
    ]);

    expect(plan.focusMode).toBe("all_clear");
    expect(plan.chosenId).toBeNull();
  });

  it("switches to external wait when blocker is waiting on outside event", () => {
    const decision = decideTasklineNextStep([
      {
        id: "a",
        title: "wait for callback",
        status: "blocked",
        priority: 80,
        blocker: "awaiting webhook",
        evidence: "callback url registered",
        waitType: "http_callback",
      },
      {
        id: "b",
        title: "write followup",
        status: "pending",
        priority: 40,
        evidence: "draft ready",
      },
    ]);

    expect(decision.plan.focusMode).toBe("wait_external");
    expect(decision.plan.chosenId).toBe("a");
    expect(decision.plan.nextStep).toContain("等待外部事件");
  });
});
