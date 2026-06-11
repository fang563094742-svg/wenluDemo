import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("riverMain capability debt live loop", () => {
  const riverMain = readFileSync(resolve(process.cwd(), "src/riverMain.ts"), "utf-8");

  it("defines capability debt as first-class live state", () => {
    expect(riverMain).toContain("interface CapabilityDebt");
    expect(riverMain).toContain("capabilityDebts?: CapabilityDebt[]");
    expect(riverMain).toContain("capabilityDebtBackfilledAt?: string");
    expect(riverMain).toContain("kind?: \"execution\" | \"repair\" | \"exploration\"");
    expect(riverMain).toContain("blockedByDebtId?: string");
    expect(riverMain).toContain("waitingForRepair?: boolean");
  });

  it("classifies failed task lines into capability debts and auto-spawns repair lines", () => {
    expect(riverMain).toContain("function inferCapabilityDebtKind(text: string): CapabilityDebtKind | null");
    expect(riverMain).toContain("async function absorbCapabilityDebtFromTask(task: WenluTask");
    expect(riverMain).toContain("async function absorbCapabilityDebtFromFailureEvent");
    expect(riverMain).toContain("function backfillCapabilityDebtsFromTaskHistory()");
    expect(riverMain).toContain("function maybeSpawnRepairTaskForDebt(debt: CapabilityDebt): WenluTask | null");
    expect(riverMain).toContain("[能力债识别]");
    expect(riverMain).toContain("[能力债修补]");
  });

  it("exposes debt inspection and repair tools to the live brain", () => {
    expect(riverMain).toContain('name: "list_capability_debts"');
    expect(riverMain).toContain('name: "repair_capability_debt"');
    expect(riverMain).toContain("pickMostUrgentCapabilityDebt()");
    expect(riverMain).toContain("resumeTasksUnblockedByDebt");
    expect(riverMain).toContain("executeToolObserved");
  });
});
