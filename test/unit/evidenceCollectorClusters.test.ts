import { describe, expect, it } from "vitest";
import { createEvidenceCollector } from "../../src/verification/evidenceCollector.js";

describe("evidenceCollector recentFailureClusters", () => {
  it("groups repeated board-truth failures into one dominant cluster", () => {
    const collector = createEvidenceCollector();
    collector.store({
      taskId: "t1",
      assertions: [
        {
          id: "a1",
          passed: false,
          evidence: {
            type: "ui-check",
            timestamp: "2026-06-10T06:00:00.000Z",
            summary: "缺少 OCR 棋盘识别",
          },
        },
      ],
    } as any);
    collector.store({
      taskId: "t2",
      assertions: [
        {
          id: "a2",
          passed: false,
          evidence: {
            type: "ui-check",
            timestamp: "2026-06-10T06:01:00.000Z",
            detail: "无法确认棋盘坐标真值",
          },
        },
      ],
    } as any);
    collector.store({
      taskId: "t3",
      assertions: [
        {
          id: "a3",
          passed: false,
          evidence: {
            type: "probe",
            timestamp: "2026-06-10T06:02:00.000Z",
            detail: "request timeout",
          },
        },
      ],
    } as any);

    const clusters = collector.recentFailureClusters();
    expect(clusters[0]).toMatchObject({
      pattern: "missing-ocr-or-board-truth",
      count: 2,
      latestTimestamp: "2026-06-10T06:01:00.000Z",
    });
    expect(clusters[0].sampleTaskIds).toContain("t1");
    expect(clusters[0].sampleTaskIds).toContain("t2");
    expect(clusters[1]).toMatchObject({ pattern: "timeout", count: 1 });
  });
});
