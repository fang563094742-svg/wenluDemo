#!/usr/bin/env tsx
import { decideTasklineNextStep, type TasklineCandidate } from "../src/cognitive-core/taskline-planner.js";
import fs from "node:fs";

function readInput(arg?: string): TasklineCandidate[] {
  if (!arg || arg === "-") {
    const raw = fs.readFileSync(0, "utf8");
    return JSON.parse(raw);
  }
  return JSON.parse(fs.readFileSync(arg, "utf8"));
}

const inputPath = process.argv[2] ?? "-";
const candidates = readInput(inputPath);
const decision = decideTasklineNextStep(candidates);
console.log(JSON.stringify(decision, null, 2));
