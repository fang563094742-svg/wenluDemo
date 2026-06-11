import { describe, it, expect } from "vitest";
import {
  evaluateInterrupt,
  INTERCEPT_SPLITTING_THRESHOLD,
  KNOCK_SPLITTING_THRESHOLD,
  type KnockRateState,
} from "./interrupt-engine.js";
import { emptyRiverbedState, upsertRiverbedNode, type RiverbedNode } from "./riverbed-store.js";
import {
  buildDomainJudgementPacket,
  type BuildPacketInput,
} from "./domain-judgement-packet.js";

/** 构造一个河床节点，可覆盖域/理由/建议/权威分。 */
function makeNode(opts: {
  domain?: BuildPacketInput["domain"];
  reason?: string;
  nextStep?: string | null;
  authority?: number;
}): RiverbedNode {
  const rb = emptyRiverbedState();
  const packet = buildDomainJudgementPacket({
    domain: opts.domain ?? "D9_COGNITION",
    targetObjectType: "belief",
    targetObjectId: `t-${Math.random()}`,
    targetSummary: "摘要",
    judgementType: "signal",
    score: 0.5,
    confidence: 0.8,
    severity: "high",
    verdict: "observe",
    reason: opts.reason ?? "理由",
    freshness: "fresh",
    constraintLevel: "ADVISORY",
    suggestedNextStep: opts.nextStep ?? null,
    recoveryRequired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const { node } = upsertRiverbedNode(rb, packet, 0);
  if (typeof opts.authority === "number") node.interruptAuthority = opts.authority;
  return node;
}

const NOW = Date.parse("2026-06-11T00:00:00.000Z");

describe("evaluateInterrupt — 基础行为", () => {
  it("无重叠 → null（不硬凑打断）", () => {
    const node = makeNode({ reason: "棋盘残局分析", authority: 0.9 });
    const out = evaluateInterrupt({
      presentContext: "完全无关的网络协议话题",
      candidates: [node],
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });

  it("authority<=0 的节点不参与", () => {
    const node = makeNode({ reason: "目标对齐", nextStep: "锁定唯一主战场", authority: 0 });
    const out = evaluateInterrupt({
      presentContext: "目标对齐 主战场",
      candidates: [node],
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });

  it("commitment 域(D2_GOAL) + 高分裂度 → intercept", () => {
    const node = makeNode({
      domain: "D2_GOAL",
      reason: "主战场漂移",
      nextStep: "先锁唯一主战场再行动",
      authority: 0.9,
    });
    const out = evaluateInterrupt({
      presentContext: "主战场 漂移 主战场",
      splittingScore: INTERCEPT_SPLITTING_THRESHOLD,
      candidates: [node],
      nowMs: NOW,
    });
    expect(out).not.toBeNull();
    expect(out!.level).toBe("intercept");
    expect(out!.messageText).toContain("主战场");
  });

  it("knock 域(D6_FAILURE) + 中分裂度 → knock，且第二次同小时降级 whisper", () => {
    const node = makeNode({
      domain: "D6_FAILURE",
      reason: "重复踩同一个坑",
      nextStep: "先补能力债再继续",
      authority: 0.9,
    });
    const knockState: KnockRateState = { hits: [] };
    const first = evaluateInterrupt({
      presentContext: "重复 坑 能力债",
      splittingScore: KNOCK_SPLITTING_THRESHOLD,
      candidates: [node],
      nowMs: NOW,
      knockState,
    });
    expect(first!.level).toBe("knock");

    const second = evaluateInterrupt({
      presentContext: "重复 坑 能力债",
      splittingScore: KNOCK_SPLITTING_THRESHOLD,
      candidates: [node],
      nowMs: NOW + 60_000, // 同一小时内
      knockState,
    });
    expect(second!.level).toBe("whisper"); // 限频降级
  });

  it("低分裂度即便命中 commitment 域也只 whisper", () => {
    const node = makeNode({
      domain: "D2_GOAL",
      reason: "主战场",
      nextStep: "锁定主战场",
      authority: 0.9,
    });
    const out = evaluateInterrupt({
      presentContext: "主战场 锁定",
      splittingScore: 0.1,
      candidates: [node],
      nowMs: NOW,
    });
    expect(out!.level).toBe("whisper");
  });

  it("确定性：同输入恒同输出", () => {
    const node = makeNode({ domain: "D2_GOAL", reason: "主战场", nextStep: "锁定主战场", authority: 0.9 });
    const args = {
      presentContext: "主战场 锁定",
      splittingScore: 0.9,
      candidates: [node],
      nowMs: NOW,
    };
    const a = evaluateInterrupt(args);
    const b = evaluateInterrupt(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
