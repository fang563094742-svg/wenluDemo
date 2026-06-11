#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

interface VerifySpec {
  kind: "command-exit-0" | "file-exists" | "file-contains";
  path?: string;
  command?: string;
  needle?: string;
  description: string;
}

interface VerifyResult extends VerifySpec {
  passed: boolean;
  observed: string;
}

interface EvidenceChain {
  id: string;
  goal: string;
  createdAt: string;
  specPath: string;
  results: VerifyResult[];
  verdict: "passed" | "failed";
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
  const spec = JSON.parse(raw) as { id: string; goal: string; checks: VerifySpec[] };
  const results = spec.checks.map(runCheck);
  const verdict = results.every((r) => r.passed) ? "passed" : "failed";
  const outDir = resolve(ROOT, "artifacts", "verification_chains", spec.id);
  await mkdir(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-");
  const outPath = resolve(outDir, `${basename(inputPath, ".json")}_${ts}.json`);
  const evidence: EvidenceChain = {
    id: spec.id,
    goal: spec.goal,
    createdAt: new Date().toISOString(),
    specPath: inputPath,
    results,
    verdict,
  };
  await writeFile(outPath, JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({ verdict, evidencePath: outPath, failedChecks: results.filter((r) => !r.passed).map((r) => r.description) }, null, 2));
  process.exit(verdict === "passed" ? 0 : 1);
}

function runCheck(check: VerifySpec): VerifyResult {
  try {
    if (check.kind === "command-exit-0") {
      if (!check.command) throw new Error("missing command");
      execSync(check.command, { cwd: ROOT, stdio: "pipe", encoding: "utf8", shell: "/bin/bash" });
      return { ...check, passed: true, observed: "exit=0" };
    }
    if (check.kind === "file-exists") {
      if (!check.path) throw new Error("missing path");
      execSync(`test -f ${shellQuote(resolve(ROOT, check.path))}`, { stdio: "pipe", encoding: "utf8", shell: "/bin/bash" });
      return { ...check, passed: true, observed: resolve(ROOT, check.path) };
    }
    if (check.kind === "file-contains") {
      if (!check.path || !check.needle) throw new Error("missing path/needle");
      const filePath = resolve(ROOT, check.path);
      const content = execSync(`cat ${shellQuote(filePath)}`, { stdio: "pipe", encoding: "utf8", shell: "/bin/bash" });
      const passed = content.includes(check.needle);
      return { ...check, passed, observed: passed ? `found:${check.needle}` : `missing:${check.needle}` };
    }
    return { ...check, passed: false, observed: "unknown check kind" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...check, passed: false, observed: message };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
