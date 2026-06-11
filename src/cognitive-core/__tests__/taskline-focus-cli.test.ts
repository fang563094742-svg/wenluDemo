import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("tools/taskline_focus.ts", () => {
  it("writes a decision file that collapses to a single blocker", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskline-focus-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "decision.json");

    fs.writeFileSync(
      inputPath,
      JSON.stringify([
        { id: "a", title: "补规则", status: "pending", priority: 80, evidence: "已有草案" },
        { id: "b", title: "修权限", status: "blocked", priority: 90, blocker: "缺 token", unblockCost: 3, evidence: "403 response" }
      ]),
      "utf8"
    );

    const stdout = execFileSync("npx", ["tsx", "tools/taskline_focus.ts", inputPath, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    const parsedStdout = JSON.parse(stdout);
    const parsedFile = JSON.parse(fs.readFileSync(outputPath, "utf8"));

    expect(parsedStdout.plan.focusMode).toBe("single_blocker");
    expect(parsedStdout.plan.chosenId).toBe("b");
    expect(parsedFile.plan.nextStep).toContain("阻塞");
  });
});
