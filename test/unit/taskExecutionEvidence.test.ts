import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const riverMain = readFileSync("src/riverMain.ts", "utf-8");

describe("task execution evidence persistence", () => {
  it("keeps report_progress and finish_task hooks in the task loop", () => {
    expect(riverMain).toContain('tc.name === "report_progress"');
    expect(riverMain).toContain('tc.name === "finish_task"');
    expect(riverMain).toContain("进度已记录");
  });

  it("persists task status and result on finish", () => {
    expect(riverMain).toContain('cur.status = st === "done" || st === "failed" || st === "blocked" ? st : "done"');
    expect(riverMain).toContain("cur.result = String((tc.arguments as any).result ?? \"\")");
    expect(riverMain).toContain('mind.conversation.push({ role: "wenlu", text: `【任务线·静默】');
  });
});
