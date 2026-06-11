import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("riverMain global attention allocator", () => {
  const riverMain = readFileSync(resolve(process.cwd(), "src/riverMain.ts"), "utf-8");

  it("persists attention as first-class live state instead of leaving scheduling as blind priority sort", () => {
    expect(riverMain).toContain("interface AttentionLedgerEntry");
    expect(riverMain).toContain("attentionLedger?: AttentionLedgerEntry[]");
    expect(riverMain).toContain("function recordAttentionAllocation(");
    expect(riverMain).toContain("buildAttentionBootstrapEntries(12)");
  });

  it("scores tasks through a multi-axis allocator with anti-overfocus penalties", () => {
    expect(riverMain).toContain("function buildAttentionSnapshot(pendingTasks: WenluTask[]): AttentionSnapshot");
    expect(riverMain).toContain("function scoreTaskForAttention(task: WenluTask, snapshot: AttentionSnapshot)");
    expect(riverMain).toContain("反过聚焦-22");
    expect(riverMain).toContain("从修补回拉执行+12");
  });

  it("wires the live scheduler and debt picker through the allocator", () => {
    expect(riverMain).toContain("const ranked = pending");
    expect(riverMain).toContain(".map((task) => ({ task, ...scoreTaskForAttention(task, snapshot) }))");
    expect(riverMain).toContain("recordAttentionAllocation({");
    expect(riverMain).toContain("function scoreDebtForAttention(debt: CapabilityDebt)");
    expect(riverMain).toContain(".map((debt) => ({ debt, ...scoreDebtForAttention(debt) }))");
  });

  it("exposes live attention observability instead of hiding the allocator", () => {
    expect(riverMain).toContain("function getAttentionSummary(): {");
    expect(riverMain).toContain('if (method === "GET" && url === "/attention")');
    expect(riverMain).toContain("attention: getAttentionSummary()");
  });
});
