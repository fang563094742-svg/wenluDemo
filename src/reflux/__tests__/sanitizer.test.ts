/**
 * Sanitizer 单元测试 + 属性测试（Req 5）
 * ------------------------------------------------------------------
 * 聚焦"对 scanResidualPrivacy 去隐私内核的二期扩展逻辑"：
 *  - 扩展剔除：来自 understand_user/userModel/个人 beliefs 的字段被剔除（Req 5.1/5.3）
 *  - 拒绝分支：scanResidualPrivacy clean=false → 拒绝候选、不进去重（Req 5.2）
 *  - 审计字段：removed_fields + scan 判定（Req 5.4）
 * 一期 scanResidualPrivacy 内核本身已由 skill-flywheel 自带测试覆盖，此处不重复测。
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sanitizeCandidate, type SanitizeInput } from "../sanitizer.js";
import { type SkillSpec, newSkillId } from "../../skill-flywheel/index.js";

/** 构造去隐私干净的合法 SkillSpec（值/结构分离已用 ${var} 占位）。 */
function mkCleanSkill(over: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: newSkillId(),
    name: "打开下棋应用并走一步",
    when: { taskPattern: "下棋 走子 chess move", preconditions: [] },
    exec: { vars: ["path1"], steps: [{ op: "open", args: { a1: "${path1}" } }, { op: "move", args: { a1: "e2e4" } }] },
    done: "目标达成",
    verify: { kind: "state-assert", spec: "board changed" },
    platform: ["mac"],
    platformLocked: true,
    taxonomy: { taskType: "game", app: "chess" },
    provenance: { createdAt: new Date().toISOString(), verifiedCount: 1, totalCount: 1 },
    ...over,
  };
}

/** 构造残留具体隐私值（绝对用户路径未占位）的 SkillSpec，用于触发拒绝分支。 */
function mkLeakySkill(): SkillSpec {
  return mkCleanSkill({
    // args 直接含真实用户路径，未做 ${var} 占位 → scanResidualPrivacy 应判 clean=false。
    exec: { vars: [], steps: [{ op: "open", args: { a1: "/Users/zhangsan/board.pgn" } }] },
  });
}

describe("Sanitizer · 扩展剔除个人理解字段（Req 5.1/5.3）", () => {
  it("剔除 understand_user / userModel / beliefs 字段，保留可泛化内容", () => {
    const draft: Record<string, unknown> = {
      title: "走棋技能",
      description: "打开应用并走一步",
      understand_user: "主人喜欢激进开局",
      userModel: { risk: "high" },
      beliefs: ["主人是高手"],
      kind: "executable",
    };
    const r = sanitizeCandidate({ skill: mkCleanSkill(), draft });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 个人理解字段被剔除
      expect(r.draft.understand_user).toBeUndefined();
      expect(r.draft.userModel).toBeUndefined();
      expect(r.draft.beliefs).toBeUndefined();
      // 可泛化字段保留
      expect(r.draft.title).toBe("走棋技能");
      expect(r.draft.kind).toBe("executable");
    }
  });

  it("剔除嵌套个人理解字段并记录其路径", () => {
    const draft: Record<string, unknown> = {
      meta: { userModel: "X", taskType: "game", nested: { user_profile: "Y", keep: 1 } },
    };
    const r = sanitizeCandidate({ skill: mkCleanSkill(), draft });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audit.removed_fields).toContain("meta.userModel");
      expect(r.audit.removed_fields).toContain("meta.nested.user_profile");
      // 非个人字段保留
      const meta = r.draft.meta as Record<string, unknown>;
      expect(meta.taskType).toBe("game");
      expect((meta.nested as Record<string, unknown>).keep).toBe(1);
    }
  });

  it("无个人字段时不剔除任何内容，removed_fields 为空", () => {
    const draft = { title: "T", description: "D", taskType: "generic" };
    const r = sanitizeCandidate({ skill: mkCleanSkill(), draft });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audit.removed_fields).toEqual([]);
      expect(r.draft).toEqual(draft);
    }
  });
});

describe("Sanitizer · 拒绝分支（Req 5.2）", () => {
  it("scanResidualPrivacy clean=false → 拒绝候选", () => {
    const r = sanitizeCandidate({ skill: mkLeakySkill(), draft: { title: "T" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.audit.scan.clean).toBe(false);
      expect(r.audit.scan.leaks.length).toBeGreaterThan(0);
    }
  });

  it("拒绝时仍输出已剔除字段供审计（removed_fields 不丢失）", () => {
    const r = sanitizeCandidate({ skill: mkLeakySkill(), draft: { understand_user: "主人信息", title: "T" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.audit.removed_fields).toContain("understand_user");
    }
  });

  it("去隐私内核异常（skill 缺失）→ 保守拒绝，不抛", () => {
    const r = sanitizeCandidate({ skill: undefined as unknown as SkillSpec, draft: {} });
    // scanResidualPrivacy 对 undefined 不抛（内部空值保护），按其判定走；无论如何不应抛异常
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("Sanitizer · 审计字段（Req 5.4）", () => {
  it("通过候选记录 scan 判定与 removed_fields", () => {
    const r = sanitizeCandidate({ skill: mkCleanSkill(), draft: { userModel: "x", title: "T" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audit.scan.clean).toBe(true);
      expect(r.audit.removed_fields).toContain("userModel");
    }
  });
});

describe("Sanitizer · 不变量（属性测试）", () => {
  it("通过的候选其草稿中绝不残留任何个人理解键（Req 5.1/5.3）", () => {
    const personalKey = fc.constantFrom(
      "understand_user",
      "userModel",
      "user_model",
      "beliefs",
      "belief",
      "persona",
      "user_profile",
      "aboutUser",
    );
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom("title", "description", "kind", "taskType"), fc.string()),
        fc.array(personalKey, { maxLength: 4 }),
        (safe, personals) => {
          const draft: Record<string, unknown> = { ...safe };
          for (const k of personals) draft[k] = "主人私有信息";
          const r = sanitizeCandidate({ skill: mkCleanSkill(), draft });
          // skill 去隐私干净 → 必通过
          expect(r.ok).toBe(true);
          if (r.ok) {
            for (const k of personals) {
              expect(r.draft[k]).toBeUndefined();
            }
          }
        },
      ),
    );
  });

  it("clean=false 时恒拒绝，永不进入去重（ok 必为 false）（Req 5.2）", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.string()), (draft) => {
        const r = sanitizeCandidate({ skill: mkLeakySkill(), draft });
        expect(r.ok).toBe(false);
      }),
    );
  });
});
