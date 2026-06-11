/**
 * router 属性测试 — P1 三级降级 / P2 纯函数 + fail-open（最高约束·不可跳过）
 * Validates: Requirements 2.5, 2.7
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { routeTask, type DeterministicProbe } from "../router.js";
import { emptyKB, addSkill } from "../skill-kb.js";
import { mkSkill } from "./_factory.js";

const noProbe: DeterministicProbe = { canSolve: () => ({ ok: false }) };
const yesProbe: DeterministicProbe = { canSolve: () => ({ ok: true, toolRef: "chess.js" }) };

describe("P1 三级降级", () => {
  it("命中已验证技能 → skill", () => {
    const kb = addSkill(emptyKB(), mkSkill());
    const d = routeTask({ taskDesc: "下棋 走子", platform: "mac", kb, deterministic: yesProbe, minTrust: 1 });
    expect(d.tier).toBe("skill");
  });
  it("无技能但确定性可解 → deterministic", () => {
    const d = routeTask({ taskDesc: "下棋 走子", platform: "mac", kb: emptyKB(), deterministic: yesProbe, minTrust: 1 });
    expect(d.tier).toBe("deterministic");
    expect(d.ref).toBe("chess.js");
  });
  it("都不命中 → llm", () => {
    const d = routeTask({ taskDesc: "写诗", platform: "mac", kb: emptyKB(), deterministic: noProbe, minTrust: 1 });
    expect(d.tier).toBe("llm");
  });
  it("技能存在但验证次数不足 minTrust → 不走 skill", () => {
    const kb = addSkill(emptyKB(), mkSkill({ provenance: { createdAt: "", verifiedCount: 0, totalCount: 3 } }));
    const d = routeTask({ taskDesc: "下棋 走子", platform: "mac", kb, deterministic: noProbe, minTrust: 2 });
    expect(d.tier).toBe("llm");
  });
});

describe("P2 纯函数 + fail-open", () => {
  it("不改入参", () => {
    const kb = addSkill(emptyKB(), mkSkill());
    const snap = JSON.stringify(kb);
    routeTask({ taskDesc: "下棋", platform: "mac", kb, minTrust: 1 });
    expect(JSON.stringify(kb)).toBe(snap);
  });
  it("探针抛异常 → fail-open llm", () => {
    const boom: DeterministicProbe = { canSolve: () => { throw new Error("boom"); } };
    const d = routeTask({ taskDesc: "x任务y", platform: "mac", kb: emptyKB(), deterministic: boom, minTrust: 1 });
    expect(d.tier).toBe("llm");
    expect(d.reason).toMatch(/fail-open/);
  });
  it("任意输入恒返回合法 tier", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("mac" as const, "win" as const, "linux" as const, "any" as const), (desc, plat) => {
        const d = routeTask({ taskDesc: desc, platform: plat, kb: emptyKB(), minTrust: 1 });
        expect(["skill", "deterministic", "llm"]).toContain(d.tier);
      }),
    );
  });
});
