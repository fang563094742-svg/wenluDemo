/**
 * skill-kb 属性测试 — P6 适用守卫 / P7 信誉单调（最高约束·不可跳过）
 * Validates: Requirements 4.2, 4.3
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { emptyKB, addSkill, searchSkills, reputationOf, recordSkillOutcome } from "../skill-kb.js";
import { mkSkill } from "./_factory.js";

describe("KB 不可变操作", () => {
  it("addSkill 返回新 KB，不改入参", () => {
    const kb0 = emptyKB();
    const kb1 = addSkill(kb0, mkSkill());
    expect(kb0.skills.length).toBe(0);
    expect(kb1.skills.length).toBe(1);
  });
  it("同 id 视为升级覆盖", () => {
    const s = mkSkill();
    const kb = addSkill(addSkill(emptyKB(), s), { ...s, name: "升级版" });
    expect(kb.skills.length).toBe(1);
    expect(kb.skills[0].name).toBe("升级版");
  });
});

describe("P6 检索适用守卫", () => {
  it("平台不兼容的技能不返回", () => {
    const kb = addSkill(emptyKB(), mkSkill({ platform: ["win"] }));
    expect(searchSkills(kb, "下棋 走子", "mac")).toHaveLength(0);
  });
  it("taxonomy.taskType 收窄", () => {
    const kb = addSkill(emptyKB(), mkSkill({ taxonomy: { taskType: "game", app: "chess" } }));
    expect(searchSkills(kb, "下棋 走子", "mac", { taskType: "email" })).toHaveLength(0);
    expect(searchSkills(kb, "下棋 走子", "mac", { taskType: "game" })).toHaveLength(1);
  });
  it("按信誉降序排序", () => {
    const low = mkSkill({ when: { taskPattern: "下棋", preconditions: [] }, provenance: { createdAt: "", verifiedCount: 1, totalCount: 10 } });
    const high = mkSkill({ when: { taskPattern: "下棋", preconditions: [] }, provenance: { createdAt: "", verifiedCount: 9, totalCount: 10 } });
    const kb = addSkill(addSkill(emptyKB(), low), high);
    const res = searchSkills(kb, "下棋", "mac");
    expect(res[0].id).toBe(high.id);
  });
});

describe("P7 信誉单调", () => {
  it("success 不降低 reputation，fail 不升高", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), fc.boolean(), (ok, extra, success) => {
        const total = ok + extra;
        const s = mkSkill({ provenance: { createdAt: "", verifiedCount: ok, totalCount: total } });
        const kb = addSkill(emptyKB(), s);
        const before = reputationOf(s);
        const after = reputationOf(recordSkillOutcome(kb, s.id, success).skills[0]);
        if (success) expect(after).toBeGreaterThanOrEqual(before - 1e-9);
        else expect(after).toBeLessThanOrEqual(before + 1e-9);
      }),
    );
  });
  it("recordSkillOutcome 未命中 id 原样返回（fail-open）", () => {
    const kb = addSkill(emptyKB(), mkSkill());
    expect(recordSkillOutcome(kb, "nope", true)).toBe(kb);
  });
  it("无样本技能信誉中性 0.5", () => {
    expect(reputationOf(mkSkill({ provenance: { createdAt: "", verifiedCount: 0, totalCount: 0 } }))).toBe(0.5);
  });
});
