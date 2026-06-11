/**
 * DefinitionOfDone 属性测试 — Task 4.2
 * P7 用户画像投影（非空 ⟹ userAligned，空 ⟹ 退回不报错）；P8 无过程奖励。
 * Validates: Requirements 3.2, 3.4, 3.7
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildDefinitionOfDone,
  remainingToDone,
  remainingToDoneSemantic,
  type UserModelReadLike,
  type WorldState,
} from "../index.js";

describe("DefinitionOfDone · P7 用户画像投影 (Req 3.2, 3.7)", () => {
  it("非空 userModel ⟹ userAligned=true 且条件含画像投影", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            aspect: fc.constantFrom("boundary", "value", "communication-style", "goal"),
            content: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
            confidence: fc.float({ min: 0, max: 1, noNaN: true }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (insights) => {
          const um: UserModelReadLike = { insights };
          const dod = buildDefinitionOfDone({ goal: "做一件事", userModel: um });
          expect(dod.userAligned).toBe(true);
          expect(dod.doneConditions.some((c) => c.includes("满足用户["))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("空/缺省 userModel ⟹ 退回 goal-gap，不报错，userAligned=false", () => {
    const a = buildDefinitionOfDone({ goal: "做一件事" });
    expect(a.userAligned).toBe(false);
    expect(a.doneConditions.length).toBeGreaterThan(0);
    const b = buildDefinitionOfDone({ goal: "做一件事", userModel: { insights: [] } });
    expect(b.userAligned).toBe(false);
  });

  it("提供 goalGap ⟹ 完成条件含北极星对齐项", () => {
    const dod = buildDefinitionOfDone({ goal: "g", goalGap: { gap: 70, topDimension: "g_results" } });
    expect(dod.doneConditions.some((c) => c.includes("北极星"))).toBe(true);
  });
});

describe("DefinitionOfDone · P8 无过程奖励 (Req 3.4)", () => {
  it("DefinitionOfDone 不含任何对过程/坚持发分的字段", () => {
    const dod = buildDefinitionOfDone({ goal: "g", userModel: { insights: [{ aspect: "goal", content: "x", confidence: 0.9 }] } });
    const json = JSON.stringify(dod).toLowerCase();
    expect(json).not.toContain("reward");
    expect(json).not.toContain("score");
    expect(json).not.toContain("坚持");
    expect(json).not.toContain("努力");
    // 完成条件全部指向客观达成/验证，不奖励过程
    expect(dod.verifyHint).toBeTruthy();
  });
});

describe("DefinitionOfDone · remainingToDone", () => {
  it("无当前态 ⟹ 全部 missing", () => {
    const dod = buildDefinitionOfDone({ goal: "g" });
    const r = remainingToDone(dod, undefined);
    expect(r.satisfied.length).toBe(0);
    expect(r.missing.length).toBe(dod.doneConditions.length);
  });

  it("当前态命中关键 token ⟹ 计入 satisfied", () => {
    const dod = buildDefinitionOfDone({ goal: "部署服务" });
    const current: WorldState = { kind: "generic", snapshot: { note: "部署服务核心产出已客观达成可验证" }, capturedAt: "t" };
    const r = remainingToDone(dod, current);
    expect(r.satisfied.length).toBeGreaterThan(0);
  });
});

describe("DefinitionOfDone · remainingToDoneSemantic 语义增强（fail-open 回退 token）", () => {
  it("注入 judge 且产出 ⟹ 用语义判定，只采纳属于本 dod 的条件", async () => {
    const dod = buildDefinitionOfDone({ goal: "下完这盘棋" });
    const current: WorldState = { kind: "generic", snapshot: { board: "checkmate" }, capturedAt: "t" };
    const judge = {
      judge: async (inp: { doneConditions: string[] }) => ({
        satisfied: [inp.doneConditions[0], "幻觉出来的不存在条件"], // 含幻觉，应被过滤
        missing: [],
      }),
    };
    const r = await remainingToDoneSemantic(dod, current, judge);
    expect(r.satisfied).toContain(dod.doneConditions[0]);
    expect(r.satisfied).not.toContain("幻觉出来的不存在条件"); // 过滤幻觉
    expect(r.satisfied.every((c) => dod.doneConditions.includes(c))).toBe(true);
  });

  it("judge 抛异常 ⟹ fail-open 回退 token 版", async () => {
    const dod = buildDefinitionOfDone({ goal: "部署服务" });
    const current: WorldState = { kind: "generic", snapshot: { note: "部署服务核心产出已客观达成可验证" }, capturedAt: "t" };
    const judge = { judge: async () => { throw new Error("llm down"); } };
    const r = await remainingToDoneSemantic(dod, current, judge);
    // 回退到 token 版，应与 remainingToDone 一致
    expect(r.satisfied.length).toBe(remainingToDone(dod, current).satisfied.length);
  });

  it("无 judge / 无当前态 ⟹ 回退 token 版", async () => {
    const dod = buildDefinitionOfDone({ goal: "x" });
    const r = await remainingToDoneSemantic(dod, undefined);
    expect(r.missing.length).toBe(dod.doneConditions.length);
  });
});
