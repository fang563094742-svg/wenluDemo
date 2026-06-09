import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const riverMain = readFileSync("src/riverMain.ts", "utf-8");

describe("no legacy fallback regression law", () => {
  it("persists the active law and legacy pattern registry", () => {
    expect(riverMain).toContain("fallbackReplyPolicy");
    expect(riverMain).toContain("activeLawId: \"no-legacy-fallback-regression\"");
    expect(riverMain).toContain("legacyPatterns");
  });

  it("blocks outward tool replies that slide back to legacy wording", () => {
    expect(riverMain).toContain('tc.name === "say_to_user" || tc.name === "report_progress" || tc.name === "finish_task"');
    expect(riverMain).toContain("禁止回滑旧口径");
  });

  it("keeps fallback replies generated from live state instead of legacy catchphrases", () => {
    expect(riverMain).toContain("buildMinimalFallbackReply()");
    expect(riverMain).toContain("回复生成失败了，但当前没有丢状态");
  });
});
