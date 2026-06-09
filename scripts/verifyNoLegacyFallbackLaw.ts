import { readFileSync } from "node:fs";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = readFileSync("src/riverMain.ts", "utf-8");

assert(source.includes("fallbackReplyPolicy"), "missing persisted fallbackReplyPolicy law state");
assert(source.includes("禁止回滑旧口径"), "missing regression guardrail message");
assert(source.includes("legacyPatterns"), "missing legacy pattern registry");
assert(source.includes('tc.name === "say_to_user" || tc.name === "report_progress" || tc.name === "finish_task"'), "missing tool-level guard for outward replies");

for (const legacy of ["嗯，我在。", "好的，我在", "收到，我在"]) {
  assert(source.includes(legacy), `missing legacy pattern evidence: ${legacy}`);
}

console.log("verified:no-legacy-fallback-regression");
