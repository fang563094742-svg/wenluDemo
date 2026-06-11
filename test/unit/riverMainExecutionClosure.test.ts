import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("riverMain execution closure", () => {
  const riverMain = readFileSync(resolve(process.cwd(), "src/riverMain.ts"), "utf-8");

  it("routes every live execution surface through governed execution", () => {
    expect(riverMain).toContain("async function executeGovernedTool(");
    expect(riverMain).toContain("const result = await executeGovernedTool(plan.name, { ...plan.args, __fromReply: true }, {");
    expect(riverMain).toContain("const result = await executeGovernedTool(tc.name, tc.arguments, {");
    expect(riverMain).toContain("executeGovernedTool(tc.name, { ...tc.arguments, __fromReply: true }, {");
    expect(riverMain).toContain("[仲裁驳回:");
  });

  it("does not let frontdoor contracts hijack direct structured verification requests", () => {
    expect(riverMain).toContain("function isDirectStructuredVerificationIntent(text: string): boolean");
    expect(riverMain).toContain("if (isDirectStructuredVerificationIntent(trimmed)) return null;");
    expect(riverMain).toContain("declare_verifiable_task");
    expect(riverMain).toContain("verify_task");
  });

  it("wires structured verification into the live core instead of leaving verification as an island", () => {
    expect(riverMain).toContain("parseStructuredAssertions(args.assertions)");
    expect(riverMain).toContain("runStructuredVerification(id, vt.assertions)");
    expect(riverMain).toContain("已声明结构化可验证任务");
    expect(riverMain).toContain("verificationEvidence.store(result)");
    expect(riverMain).toContain("recentFailureClusters(30)");
  });

  it("turns grown sensors into reusable shell-visible executables", () => {
    expect(riverMain).toContain("const WENLU_BIN_DIR = resolvePath(WENLU_DIR, \"bin\")");
    expect(riverMain).toContain("async function ensureSensorExecutables(): Promise<void>");
    expect(riverMain).toContain("const wrapperBody = `#!/bin/sh\\nexec \"${full}\" \"$@\"\\n`;");
    expect(riverMain).toContain("await safeExec(wrapper, [], { timeout: 8000, maxBuffer: 512 * 1024 })");
    expect(riverMain).toContain("process.env.PATH = SYSTEM_PATH");
  });

  it("treats non-zero command exits as real failures", () => {
    expect(riverMain).toContain("class ExecNonZeroError extends Error");
    expect(riverMain).toContain("reject(new ExecNonZeroError({");
    expect(riverMain).toContain("child.on(\"close\", (code, signal) => {");
  });

  it("blocks fake single-step capability forging by inspecting referenced scripts", () => {
    expect(riverMain).toContain("async function inferCapabilityChainDepth(script: string): Promise<number>");
    expect(riverMain).toContain("countScriptSteps(content)");
    expect(riverMain).toContain("这不是组合能力（只有单步）");
  });
});
