#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { shrinkToSingleBlocker } from "../src/planner/singleBlocker.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx tools/plan_shrink.ts <input.json>");
  process.exit(1);
}

const input = JSON.parse(readFileSync(file, "utf8"));
const result = shrinkToSingleBlocker(input);
console.log(JSON.stringify(result, null, 2));
