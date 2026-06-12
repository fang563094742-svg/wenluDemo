#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  createVerificationEngine,
  fileAssertion,
  httpAssertion,
  shellAssertion,
  stateAssertion,
  type Assertion,
  type AssertionContext,
  type AssertionSeverity,
  type VerificationResult,
} from "../../src/verification/index.js";

interface VerifySpec {
  id: string;
  goal: string;
  checks: LegacyCheck[];
  context?: {
    stateSnapshot?: unknown;
    workingDir?: string;
  };
}

type LegacyCheck =
  | {
      kind: "command-exit-0";
      description: string;
      command: string;
      severity?: AssertionSeverity;
      timeoutMs?: number;
    }
  | {
      kind: "file-exists";
      description: string;
      path: string;
      severity?: AssertionSeverity;
    }
  | {
      kind: "file-contains";
      description: string;
      path: string;
      needle: string;
      severity?: AssertionSeverity;
    };

interface EvidenceChainArtifact {
  id: string;
  goal: string;
  createdAt: string;
  specPath: string;
  overallVerdict: VerificationResult["overallVerdict"];
  hardGatesPassed: boolean;
  softScore: number;
  summary: string;
  verification: VerificationResult;
  failedChecks: string[];
}

const ROOT = resolve(".");
const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/verify/runVerificationChain.ts <spec.json>");
  process.exit(2);
}

const specPath = isAbsolute(arg) ? arg : resolve(ROOT, arg);
void main(specPath);

async function main(inputPath: string) {
  const raw = await readFile(inputPath, "utf8");
  const spec = JSON.parse(raw) as VerifySpec;
  const engine = createVerificationEngine();
  const workingDir = spec.context?.workingDir ? resolve(ROOT, spec.context.workingDir) : ROOT;
  const context: AssertionContext = {
    taskId: spec.id,
    stateSnapshot: spec.context?.stateSnapshot ?? {},
    workingDir,
  };

  const result = await engine.verify(spec.id, spec.checks.map(toAssertion), context);
  const outDir = resolve(ROOT, "artifacts", "verification_chains", spec.id);
  await mkdir(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-");
  const outPath = resolve(outDir, `${basename(inputPath, ".json")}_${ts}.json`);
  const artifact: EvidenceChainArtifact = {
    id: spec.id,
    goal: spec.goal,
    createdAt: new Date().toISOString(),
    specPath: inputPath,
    overallVerdict: result.overallVerdict,
    hardGatesPassed: result.hardGatesPassed,
    softScore: result.softScore,
    summary: result.summary,
    verification: result,
    failedChecks: result.assertions.filter((item) => !item.passed).map((item) => item.description),
  };
  await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  console.log(JSON.stringify({
    verdict: result.overallVerdict,
    evidencePath: outPath,
    failedChecks: artifact.failedChecks,
    hardGatesPassed: result.hardGatesPassed,
    softScore: result.softScore,
  }, null, 2));
  process.exit(result.overallVerdict === "failed" ? 1 : 0);
}

function toAssertion(check: LegacyCheck): Assertion {
  switch (check.kind) {
    case "command-exit-0":
      return shellAssertion({
        description: check.description,
        cmd: check.command,
        severity: check.severity,
        timeoutMs: check.timeoutMs,
      });
    case "file-exists":
      return fileAssertion({
        description: check.description,
        path: check.path,
        severity: check.severity,
      });
    case "file-contains":
      return fileAssertion({
        description: check.description,
        path: check.path,
        contains: check.needle,
        severity: check.severity,
      });
    default:
      return unreachable(check);
  }
}

function unreachable(value: never): never {
  throw new Error(`unsupported check: ${JSON.stringify(value)}`);
}
