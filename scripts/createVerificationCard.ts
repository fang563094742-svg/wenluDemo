#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface VerificationAssertion {
  type: "file_exists" | "file_contains" | "json_field" | "http_status" | "command_exit_code" | "state_snapshot";
  target: string;
  expected: string | number | boolean;
  field?: string;
  reason: string;
}

interface VerificationEvidence {
  kind: "file" | "error" | "state" | "note";
  path?: string;
  note: string;
}

interface VerificationCard {
  goal: string;
  status: "planned" | "passed" | "failed" | "blocked";
  artifacts: string[];
  assertions: VerificationAssertion[];
  evidence: VerificationEvidence[];
  failureMode: string;
}

function parseJsonArg<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

async function main() {
  const outputPath = process.argv[2];
  const goal = process.argv[3] ?? "未命名验收任务";
  const artifacts = parseJsonArg<string[]>(process.argv[4], []);
  const assertions = parseJsonArg<VerificationAssertion[]>(process.argv[5], []);
  const evidence = parseJsonArg<VerificationEvidence[]>(process.argv[6], []);
  const failureMode = process.argv[7] ?? "未提供失败判定标准";

  if (!outputPath) {
    throw new Error("缺少输出路径：用法 tsx scripts/createVerificationCard.ts <outputPath> <goal> [artifactsJson] [assertionsJson] [evidenceJson] [failureMode]");
  }

  const card: VerificationCard = {
    goal,
    status: "planned",
    artifacts,
    assertions,
    evidence,
    failureMode
  };

  const fullPath = resolve(outputPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(card, null, 2)}\n`, "utf8");
  console.log(fullPath);
}

void main();
