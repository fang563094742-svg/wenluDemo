/**
 * skill-spec 属性测试 — P4 去隐私 / P6 适用条件 / P11 反哺规格完整（最高约束·不可跳过）
 * Validates: Requirements 1.6, 7.5, 6.3
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { scanResidualPrivacy, skillMatches, isReshareReady, newSkillId } from "../skill-spec.js";
import { mkSkill } from "./_factory.js";

describe("P4 去隐私扫描", () => {
  it("占位 ${var} 不算泄露", () => {
    const s = mkSkill({ exec: { vars: ["path1"], steps: [{ op: "open", args: { a1: "${path1}" } }] } });
    expect(scanResidualPrivacy(s).clean).toBe(true);
  });

  it("残留绝对用户路径被判脏", () => {
    const s = mkSkill({ exec: { vars: [], steps: [{ op: "open", args: { a1: "/Users/zhangsan/secret.txt" } }] } });
    const r = scanResidualPrivacy(s);
    expect(r.clean).toBe(false);
    expect(r.leaks.join(",")).toMatch(/mac-user-path/);
  });

  it("残留邮箱/token/IP 被判脏", () => {
    for (const bad of ["a@b.com", "sk-ABCDEFGHIJ1234567890", "192.168.1.1"]) {
      const s = mkSkill({ exec: { vars: [], steps: [{ op: "x", args: { a1: bad } }] } });
      expect(scanResidualPrivacy(s).clean, bad).toBe(false);
    }
  });
});

describe("P6 适用条件匹配", () => {
  it("平台不兼容恒不匹配", () => {
    const s = mkSkill({ platform: ["win"] });
    expect(skillMatches(s, "下棋 走子", "mac")).toBe(false);
  });

  it("any 平台对任意平台匹配（描述命中时）", () => {
    const s = mkSkill({ platform: ["any"], when: { taskPattern: "部署 deploy", preconditions: [] } });
    expect(skillMatches(s, "帮我 deploy 服务", "linux")).toBe(true);
  });

  it("描述不含任何 pattern token 不匹配", () => {
    const s = mkSkill({ when: { taskPattern: "下棋 chess", preconditions: [] } });
    expect(skillMatches(s, "写一封邮件", "mac")).toBe(false);
  });

  it("空 pattern 不匹配", () => {
    const s = mkSkill({ when: { taskPattern: "", preconditions: [] } });
    expect(skillMatches(s, "任何任务都行", "mac")).toBe(false);
  });
});

describe("P11 反哺规格完整", () => {
  it("合法技能 isReshareReady=true", () => {
    expect(isReshareReady(mkSkill())).toBe(true);
  });
  it("缺 taxonomy.taskType ⟹ 不完整", () => {
    const s = mkSkill();
    (s.taxonomy as { taskType?: string }).taskType = "";
    expect(isReshareReady(s)).toBe(false);
  });
  it("newSkillId 唯一", () => {
    fc.assert(fc.property(fc.constant(null), () => {
      expect(newSkillId()).not.toBe(newSkillId());
    }));
  });
});
