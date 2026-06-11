/**
 * 最高约束硬覆盖 — observe 零改变 / fail-open / 不固化错误经验 / 去隐私（不可跳过）
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_FLYWHEEL,
  resolveFlywheelConfig,
  routeTask,
  distillSkill,
  searchSkills,
  recordSkillOutcome,
  emptyKB,
  addSkill,
  scanResidualPrivacy,
  type DistillInput,
} from "../index.js";
import { mkSkill } from "./_factory.js";
import type { ExecutionStep } from "../../execution-kernel/index.js";

describe("P8 observe 缺省零改变（纯函数不改宿主）", () => {
  it("缺省配置即 observe，全 enabled 关", () => {
    expect(DEFAULT_FLYWHEEL.mode).toBe("observe");
    expect(DEFAULT_FLYWHEEL.enabled.router || DEFAULT_FLYWHEEL.enabled.distiller).toBe(false);
  });
  it("resolveFlywheelConfig 不改入参", () => {
    const mind = {} as Record<string, never>;
    const snap = JSON.stringify(mind);
    resolveFlywheelConfig(mind);
    expect(JSON.stringify(mind)).toBe(snap);
  });
  it("searchSkills/routeTask 不改 KB", () => {
    const kb = addSkill(emptyKB(), mkSkill());
    const snap = JSON.stringify(kb);
    searchSkills(kb, "下棋", "mac");
    routeTask({ taskDesc: "下棋", platform: "mac", kb, minTrust: 1 });
    expect(JSON.stringify(kb)).toBe(snap);
  });
});

describe("fail-open 硬覆盖（任一段异常不阻断主链）", () => {
  it("router 探针抛错 → llm", () => {
    const d = routeTask({
      taskDesc: "x",
      platform: "mac",
      kb: emptyKB(),
      deterministic: { canSolve: () => { throw new Error("x"); } },
      minTrust: 1,
    });
    expect(d.tier).toBe("llm");
  });
  it("distiller 异常输入 → ok:false 不抛", () => {
    expect(distillSkill(null as unknown as DistillInput).ok).toBe(false);
  });
  it("recordSkillOutcome 未知 id → 原样返回", () => {
    const kb = addSkill(emptyKB(), mkSkill());
    expect(recordSkillOutcome(kb, "missing", true)).toBe(kb);
  });
});

describe("不固化错误经验硬覆盖", () => {
  it("verified=false 任何轨迹恒拒绝", () => {
    const step = (a: string): ExecutionStep => ({ intent: "i", action: a, diff: "d", outcome: "achieved", createdAt: "" });
    const input: DistillInput = {
      goal: "g", trace: [step("a")], verified: false, platform: "mac",
      taxonomy: { taskType: "t" }, verify: { kind: "state-assert", spec: "s" },
    };
    expect(distillSkill(input).ok).toBe(false);
  });
});

describe("去隐私硬覆盖", () => {
  it("蒸馏产物恒经 scanResidualPrivacy clean（含隐私的输入也是）", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/Users/u/x", "a@b.com", "10.0.0.1", "sk-ABCDEFGHIJ1234567890", "plain"),
        (token) => {
          const step = (a: string): ExecutionStep => ({ intent: "i", action: a, diff: "d", outcome: "achieved", createdAt: "" });
          const input: DistillInput = {
            goal: `do ${token}`, trace: [step(`run ${token}`)], verified: true, platform: "mac",
            taxonomy: { taskType: "t" }, verify: { kind: "state-assert", spec: `check ${token}` },
          };
          const r = distillSkill(input);
          if (r.ok) expect(scanResidualPrivacy(r.skill).clean).toBe(true);
        },
      ),
    );
  });
});
