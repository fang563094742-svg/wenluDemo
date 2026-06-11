import { describe, it, expect } from "vitest";
import {
  emptyCalibrationProfile,
  applyDelta,
  parseDelta,
  profileAsSystemBlock,
  checkDrift,
} from "./index.js";

describe("applyDelta", () => {
  it("覆盖式合并；不修改入参", () => {
    const p = emptyCalibrationProfile();
    const next = applyDelta(p, { currentFocus: "打穿主战场" });
    expect(next.currentFocus).toBe("打穿主战场");
    expect(p.currentFocus).toBeNull(); // 入参不变
  });

  it("锁定字段不被覆盖", () => {
    const p = { ...emptyCalibrationProfile(), currentFocus: "旧", locks: { currentFocus: true as const } };
    const next = applyDelta(p, { currentFocus: "新" });
    expect(next.currentFocus).toBe("旧");
  });

  it("空白值被忽略", () => {
    const p = { ...emptyCalibrationProfile(), petPeeves: "原值" };
    const next = applyDelta(p, { petPeeves: "   " });
    expect(next.petPeeves).toBe("原值");
  });
});

describe("parseDelta", () => {
  it("解析合法 JSON，只取 8 维字符串", () => {
    const { delta } = parseDelta('{"delta":{"currentFocus":"X","unknownField":"Y"},"reasoning":"r"}');
    expect(delta.currentFocus).toBe("X");
    expect((delta as Record<string, unknown>).unknownField).toBeUndefined();
  });
  it("含 code fence 也能解析", () => {
    const { delta } = parseDelta('```json\n{"delta":{"petPeeves":"绕弯"}}\n```');
    expect(delta.petPeeves).toBe("绕弯");
  });
  it("非法 JSON → 空 delta", () => {
    expect(Object.keys(parseDelta("不是json").delta).length).toBe(0);
  });
});

describe("profileAsSystemBlock / checkDrift", () => {
  it("空画像 → 空块", () => {
    expect(profileAsSystemBlock(emptyCalibrationProfile())).toBe("");
  });
  it("有字段 → 含标签", () => {
    const p = { ...emptyCalibrationProfile(), currentFocus: "主战场" };
    expect(profileAsSystemBlock(p)).toContain("当前最在意的");
    expect(profileAsSystemBlock(p)).toContain("主战场");
  });
  it("空字段≥3 → 应澄清", () => {
    const r = checkDrift(emptyCalibrationProfile(), Date.now());
    expect(r.shouldClarify).toBe(true);
    expect(r.emptyFields.length).toBe(8);
  });
});
