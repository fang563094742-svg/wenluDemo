/**
 * PerceptionLoop 属性测试 — Task 2.2
 * P1 感知 fail-open：probe 缺失/抛异常 ⟹ resolve 且 outcome="unknown"，不 reject。
 * P2 四态完备且互斥：∀ 输入恰返回四态之一。
 * P3 观测零改变：纯函数不改入参深度。
 * Validates: Requirements 1.5, 1.7
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  observeAction,
  judgeOutcome,
  probeState,
  type WorldState,
  type StateProbe,
  type ActionOutcome,
} from "../index.js";

const FOUR: ReadonlyArray<ActionOutcome> = ["achieved", "no_effect", "wrong_effect", "unknown"];

function ws(snapshot: Record<string, unknown>): WorldState {
  return { kind: "generic", snapshot, capturedAt: "2026-01-01T00:00:00.000Z" };
}

describe("PerceptionLoop · P1 fail-open (Req 1.7)", () => {
  it("probe 缺失 ⟹ outcome=unknown，不 reject", async () => {
    const step = await observeAction({ intent: "i", action: "a", intendedEffect: "x" });
    expect(step.outcome).toBe("unknown");
  });

  it("probe 抛异常 ⟹ outcome=unknown，不 reject", async () => {
    const throwing: StateProbe = { read() { throw new Error("boom"); } };
    await expect(
      observeAction({ intent: "i", action: "a", intendedEffect: "x", probe: throwing }),
    ).resolves.toBeDefined();
    const step = await observeAction({ intent: "i", action: "a", intendedEffect: "x", probe: throwing });
    expect(step.outcome).toBe("unknown");
  });

  it("probe 异步 reject ⟹ outcome=unknown，不 reject", async () => {
    const rejecting: StateProbe = { read() { return Promise.reject(new Error("async boom")); } };
    const step = await observeAction({ intent: "i", action: "a", intendedEffect: "x", probe: rejecting });
    expect(step.outcome).toBe("unknown");
  });

  it("probeState fail-open ⟹ undefined", async () => {
    const throwing: StateProbe = { read() { throw new Error("x"); } };
    expect(await probeState(throwing)).toBeUndefined();
    expect(await probeState()).toBeUndefined();
  });
});

describe("PerceptionLoop · P2 四态完备且互斥 (Req 1.5)", () => {
  it("∀ (before, after, intendedEffect) ⟹ 恰返回四态之一", () => {
    fc.assert(
      fc.property(
        fc.option(fc.dictionary(fc.string(), fc.string()), { nil: undefined }),
        fc.option(fc.dictionary(fc.string(), fc.string()), { nil: undefined }),
        fc.string(),
        (b, a, eff) => {
          const before = b ? ws(b) : undefined;
          const after = a ? ws(a) : undefined;
          const { outcome } = judgeOutcome(before, after, eff);
          expect(FOUR).toContain(outcome);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("after 缺失 ⟹ unknown", () => {
    expect(judgeOutcome(ws({ a: 1 }), undefined, "x").outcome).toBe("unknown");
  });

  it("状态未变 ⟹ no_effect", () => {
    const s = { piece: "白王,e1" };
    expect(judgeOutcome(ws(s), ws({ ...s }), "e1").outcome).toBe("no_effect");
  });

  it("变了且命中预期 ⟹ achieved", () => {
    const r = judgeOutcome(ws({ piece: "白王,e1" }), ws({ piece: "白王,d1" }), "d1");
    expect(r.outcome).toBe("achieved");
  });

  it("变了但未命中预期 ⟹ wrong_effect", () => {
    const r = judgeOutcome(ws({ piece: "白王,e1" }), ws({ piece: "白王,f1" }), "d1");
    expect(r.outcome).toBe("wrong_effect");
  });
});

describe("PerceptionLoop · P3 观测零改变 (Req 1.5)", () => {
  it("judgeOutcome 不改入参", () => {
    const before = ws({ x: "1" });
    const after = ws({ x: "2" });
    const bs = JSON.stringify(before);
    const as = JSON.stringify(after);
    judgeOutcome(before, after, "2");
    expect(JSON.stringify(before)).toBe(bs);
    expect(JSON.stringify(after)).toBe(as);
  });
});

describe("PerceptionLoop · 语义裁判注入（LLM 增强，fail-open 回退 token）", () => {
  it("注入 judge 且产出 ⟹ 用语义判定覆盖 token 兜底", async () => {
    const judge = { judge: async () => ({ outcome: "achieved" as const, reason: "语义确认达成" }) };
    const probe: StateProbe = { read: async () => ws({ board: "moved" }) };
    const step = await observeAction({ intent: "i", action: "move", intendedEffect: "完全不匹配的预期xyz", before: ws({ board: "start" }), probe, judge });
    expect(step.outcome).toBe("achieved"); // token 本会判 wrong_effect，语义覆盖为 achieved
    expect(step.diff).toContain("语义判定");
  });

  it("judge 返回 null ⟹ 沿用 token 兜底", async () => {
    const judge = { judge: async () => null };
    const probe: StateProbe = { read: async () => ws({ board: "moved" }) };
    const step = await observeAction({ intent: "i", action: "move", intendedEffect: "moved", before: ws({ board: "start" }), probe, judge });
    expect(step.outcome).toBe("achieved"); // token 命中预期
  });

  it("judge 抛异常 ⟹ fail-open 回退 token 兜底，不 reject", async () => {
    const judge = { judge: async () => { throw new Error("llm down"); } };
    const probe: StateProbe = { read: async () => ws({ board: "moved" }) };
    const step = await observeAction({ intent: "i", action: "move", intendedEffect: "moved", before: ws({ board: "start" }), probe, judge });
    expect(["achieved", "no_effect", "wrong_effect", "unknown"]).toContain(step.outcome);
  });

  it("无后态时不调 judge ⟹ token 兜底 unknown", async () => {
    let called = false;
    const judge = { judge: async () => { called = true; return { outcome: "achieved" as const, reason: "x" }; } };
    const step = await observeAction({ intent: "i", action: "a", intendedEffect: "x", judge });
    expect(called).toBe(false);
    expect(step.outcome).toBe("unknown");
  });
});
