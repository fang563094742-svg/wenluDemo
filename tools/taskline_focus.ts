import {
  decideTasklineNextStep,
  type TasklineCandidate,
  type TasklineDecision,
} from "../src/cognitive-core/taskline-planner.ts";
import fs from "node:fs";
import path from "node:path";

function readInput(arg?: string): TasklineCandidate[] {
  if (!arg || arg === "-") {
    const raw = fs.readFileSync(0, "utf8");
    return JSON.parse(raw);
  }
  return JSON.parse(fs.readFileSync(arg, "utf8"));
}

function ensureParentDir(outputPath: string): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeDecision(outputPath: string, decision: TasklineDecision): void {
  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

const inputPath = process.argv[2] ?? "-";
const outputPath = process.argv[3];

const candidates = readInput(inputPath);
const decision = decideTasklineNextStep(candidates);

if (outputPath) {
  writeDecision(outputPath, decision);
}

console.log(JSON.stringify(decision, null, 2));
