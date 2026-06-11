import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("riverMain anti-backslide policy", () => {
  const riverMain = readFileSync(resolve(process.cwd(), "src/riverMain.ts"), "utf-8");

  it("contains direct-execution suppression patterns", () => {
    expect(riverMain).toContain("不要问我选项");
    expect(riverMain).toContain("直接检查你最近的失败簇并开始修");
  });

  it("documents direct-fix-first law in the system prompt", () => {
    expect(riverMain).toContain("直接修复优先：如果用户刚明确要求“先动手/开始修/不要问选项/检查失败簇”");
  });

  it("suppresses calibration using recent user messages, not only the latest one", () => {
    expect(riverMain).toContain("function getRecentUserMessages(limit = 3): string[]");
    expect(riverMain).toContain("const recentUserMessages = getRecentUserMessages();");
  });

  it("blocks reply-user replan replies when direct execution was explicitly requested", () => {
    expect(riverMain).toContain('if (decision.action === "replan-after-user")');
    expect(riverMain).toContain("if (!shouldSuppressCalibrationNow(lastUser)) {");
    expect(riverMain).toContain("onReplanHandled(interactionState, false);");
  });

  it("installs frontdoor action contract and anti-idle recovery for command-style input", () => {
    expect(riverMain).toContain("function inferUserIntentSurface(text: string): UserIntentSurface");
    expect(riverMain).toContain("function buildActionContract(text: string, surface: UserIntentSurface): ActionContract | null");
    expect(riverMain).toContain("async function runImmediateActionContract(contract: ActionContract): Promise<ImmediateActionReport>");
    expect(riverMain).toContain("[reply-loop] anti-idle-triggered");
    expect(riverMain).toContain("inspect_native_apps");
    expect(riverMain).toContain("focus_native_app");
  });
});
