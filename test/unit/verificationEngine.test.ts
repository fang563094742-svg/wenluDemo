import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { shellAssertion, fileAssertion, stateAssertion } from "../../src/verification/assertionTypes.js";
import { createVerificationEngine } from "../../src/verification/verificationEngine.js";

const execFileAsync = promisify(execFile);

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

  it("bridges legacy verification chain into structured artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-chain-"));
    const specPath = join(dir, "spec.json");
    const checkedFile = join(dir, "proof.txt");
    await writeFile(checkedFile, "proof-ok\n", "utf8");
    await writeFile(specPath, JSON.stringify({
      id: "legacy-bridge",
      goal: "prove legacy chain emits structured evidence",
      context: { workingDir: dir },
      checks: [
        { kind: "command-exit-0", description: "shell proof", command: "printf 'proof-ok'" },
        { kind: "file-exists", description: "proof file exists", path: checkedFile },
        { kind: "file-contains", description: "proof file contains token", path: checkedFile, needle: "proof-ok" },
      ],
    }), "utf8");

    const { stdout } = await execFileAsync("npx", ["tsx", "scripts/verify/runVerificationChain.ts", specPath], { cwd: process.cwd() });
    const cli = JSON.parse(stdout) as { verdict: string; evidencePath: string; hardGatesPassed: boolean; softScore: number };
    expect(cli.verdict).toBe("passed");
    expect(cli.hardGatesPassed).toBe(true);
    expect(cli.softScore).toBe(1);

    const artifact = JSON.parse(await readFile(cli.evidencePath, "utf8")) as {
      overallVerdict: string;
      verification: { overallVerdict: string; assertions: Array<{ passed: boolean; evidence: { timestamp: string } }> };
      failedChecks: string[];
    };
    expect(artifact.overallVerdict).toBe("passed");
    expect(artifact.verification.overallVerdict).toBe("passed");
    expect(artifact.verification.assertions).toHaveLength(3);
    expect(artifact.verification.assertions.every((item) => item.passed && item.evidence.timestamp.length > 0)).toBe(true);
    expect(artifact.failedChecks).toEqual([]);
  });
});
