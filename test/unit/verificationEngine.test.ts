import { describe, expect, it } from "vitest";
import { createVerificationEngine } from "../../src/verification/verificationEngine.js";
import { shellAssertion, fileAssertion, stateAssertion } from "../../src/verification/assertionTypes.js";

describe("verificationEngine evidence chain", () => {
  it("fails empty legacy verifyCmd with deterministic evidence", async () => {
    const engine = createVerificationEngine();
    const result = await engine.verifyLegacy("empty-verify", "");

    expect(result.overallVerdict).toBe("failed");
    expect(result.hardGatesPassed).toBe(false);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.assertions[0]?.error).toContain("missing cmd");
    expect(result.assertions[0]?.evidence.summary).toContain("ERROR: missing cmd");
  });

  it("collects multi-probe evidence for pass/fail chain", async () => {
    const engine = createVerificationEngine();
    const result = await engine.verify(
      "proof-chain",
      [
        shellAssertion({ description: "shell truth", cmd: "printf 'ok'", expect: "stdout-contains", expectValue: "ok" }),
        fileAssertion({ description: "package exists", path: "package.json" }),
        stateAssertion({ description: "state captured", field: "run.id", expectValue: 7 }),
      ],
      { taskId: "proof-chain", stateSnapshot: { run: { id: 7 } }, workingDir: process.cwd() },
    );

    expect(result.overallVerdict).toBe("passed");
    expect(result.assertions).toHaveLength(3);
    expect(result.assertions.every((item) => item.evidence.timestamp.length > 0)).toBe(true);
    expect(result.assertions.map((item) => item.evidence.type)).toEqual(["stdout", "file-content", "state-snapshot"]);
  });
});
