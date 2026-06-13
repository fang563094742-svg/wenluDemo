import { describe, expect, it } from "vitest";

import { createRunCommandTool } from "../src/executor/tools/runCommand.js";
import { createToolRegistry } from "../src/executor/toolRegistry.js";
import { inspectNativeAppsTool } from "../src/executor/tools/inspectNativeApps.js";
import { HighRiskGuard } from "../src/executor/highRiskGuard.js";

describe("executor tool wiring", () => {
  it("uses PowerShell on Windows and /bin/sh elsewhere", async () => {
    const tool = createRunCommandTool(2000);
    const ctx = {
      workingDirRoot: process.cwd(),
      sandbox: {
        isInside: () => true,
      },
    } as any;

    const command = process.platform === "win32"
      ? "Write-Output 'wenlu-run-command-ok'"
      : "printf 'wenlu-run-command-ok'";

    const result = await tool.invoke({ command }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("wenlu-run-command-ok");
  });

  it("registers builtin executor tools including native app probes", () => {
    const registry = createToolRegistry();

    expect(registry.resolve("write_file")).toBeDefined();
    expect(registry.resolve("run_command")).toBeDefined();
    expect(registry.resolve("read_file")).toBeDefined();
    expect(registry.resolve("list_dir")).toBeDefined();
    expect(registry.resolve("delete_file")).toBeDefined();
    expect(registry.resolve("inspect_native_apps")).toBeDefined();
    expect(registry.resolve("focus_native_app")).toBeDefined();
  });

  it("treats focus_native_app as high risk for confirmation", () => {
    const guard = new HighRiskGuard(["powershell.exe", "Get-Process"]);
    expect(guard.isHighRisk({ id: "1", name: "focus_native_app", arguments: { app: "Chess" } })).toBe(true);
  });

  it("returns stable fallback evidence on non-Windows", async () => {
    const ctx = {
      workingDirRoot: process.cwd(),
      sandbox: {
        isInside: () => true,
      },
    } as any;
    const result = await inspectNativeAppsTool.invoke({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("capturedAt=");
    expect(result.output).toContain("evidence=");
  });
});
