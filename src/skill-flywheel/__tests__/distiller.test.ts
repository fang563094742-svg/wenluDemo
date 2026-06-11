/**
 * distiller 属性测试 — P3 不固化错误经验 / P4 去隐私 / P5 值结构分离（最高约束·不可跳过）
 * Validates: Requirements 3.4, 3.5, 7.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { distillSkill, type DistillInput } from "../distiller.js";
import { scanResidualPrivacy } from "../skill-spec.js";
import type { ExecutionStep } from "../../execution-kernel/index.js";

function step(action: string, outcome: ExecutionStep["outcome"] = "achieved"): ExecutionStep {
  return { intent: "i", action, diff: "d", outcome, createdAt: new Date().toISOString() };
}

function baseInput(over: Partial<DistillInput> = {}): DistillInput {
  return {
    goal: "打开下棋应用走一步",
    trace: [step("open /tmp/board"), step("move e2e4")],
    verified: true,
    platform: "mac",
    taxonomy: { taskType: "game", app: "chess" },
    verify: { kind: "state-assert", spec: "board changed" },
    ...over,
  };
}

describe("P3 不固化错误经验", () => {
  it("verified=false 恒拒绝", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("achieved", "no_effect", "wrong_effect", "unknown")), (outcomes) => {
        const trace = outcomes.map((o) => step("x", o as ExecutionStep["outcome"]));
        const r = distillSkill(baseInput({ verified: false, trace }));
        expect(r.ok).toBe(false);
      }),
    );
  });
  it("无达成步骤拒绝", () => {
    const r = distillSkill(baseInput({ trace: [step("x", "no_effect"), step("y", "unknown")] }));
    expect(r.ok).toBe(false);
  });
  it("只采纳 achieved 步骤", () => {
    const r = distillSkill(baseInput({ trace: [step("open a"), step("bad b", "wrong_effect"), step("move c")] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.exec.steps.map((s) => s.op)).toEqual(["open", "move"]);
  });
});

describe("P4 去隐私 + P5 值结构分离", () => {
  it("含绝对用户路径的轨迹蒸馏后必去隐私干净", () => {
    const r = distillSkill(baseInput({ trace: [step("open /Users/zhangsan/board.pgn"), step("move e2e4")] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(scanResidualPrivacy(r.skill).clean).toBe(true);
      // 值被替换为占位，vars 非空
      expect(r.skill.exec.vars.length).toBeGreaterThan(0);
      const allArgs = r.skill.exec.steps.flatMap((s) => Object.values(s.args)).join(" ");
      expect(allArgs).toMatch(/\$\{/);
      expect(allArgs).not.toMatch(/zhangsan/);
    }
  });
  it("含邮箱的轨迹被占位化", () => {
    const r = distillSkill(baseInput({ trace: [step("send a@b.com")] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(scanResidualPrivacy(r.skill).clean).toBe(true);
  });
  it("任意 achieved 轨迹蒸馏产物恒去隐私干净（不变量）", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 5 }), (actions) => {
        const trace = actions.map((a) => step(a || "noop"));
        const r = distillSkill(baseInput({ trace }));
        if (r.ok) expect(scanResidualPrivacy(r.skill).clean).toBe(true);
      }),
    );
  });
});

describe("蒸馏 fail-open", () => {
  it("空输入不抛，返回 ok:false", () => {
    expect(distillSkill(undefined as unknown as DistillInput).ok).toBe(false);
  });
});
