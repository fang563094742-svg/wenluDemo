import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { aggregateDomainJudgementPackets } from "./domain-aggregation.js";
import {
  buildDomainJudgementPacket,
  type DomainJudgementPacket,
} from "./domain-judgement-packet.js";
import { RIVERBED_DOMAIN_IDS } from "./riverbed-domain.js";

const SEVERITIES = ["none", "low", "medium", "high", "critical"] as const;
const VERDICTS = [
  "support",
  "warn",
  "block",
  "rewrite",
  "observe",
  "escalate",
  "confirm_required",
] as const;
const FRESHNESS = ["fresh", "aging", "manual_only", "placeholder", "stale"] as const;
const CONSTRAINT_LEVELS = [
  "ADVISORY",
  "WEAK_DEFAULT",
  "STRONG_DEFAULT",
  "HARD_CONSTRAINT",
  "CONFIRMATION_GATE",
] as const;
const JUDGEMENT_TYPES = [
  "alignment",
  "risk",
  "conflict",
  "opportunity",
  "constraint",
  "rewrite",
  "recovery",
  "boundary",
  "signal",
] as const;

/** 与被测模块一致的严重度排名（用于断言单调性，不 import 私有常量）。 */
const SEVERITY_RANK: Record<(typeof SEVERITIES)[number], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * 生成任意合法 DomainJudgementPacket。
 * 通过 `buildDomainJudgementPacket` 构造，保证字段归一化、守卫通过、是真实合法包。
 */
function packetArb(): fc.Arbitrary<DomainJudgementPacket> {
  return fc
    .record({
      domain: fc.constantFrom(...RIVERBED_DOMAIN_IDS),
      targetObjectId: fc.string().map((s) => `t_${s}`),
      targetSummary: fc.string(),
      judgementType: fc.constantFrom(...JUDGEMENT_TYPES),
      score: fc.double({ min: 0, max: 1, noNaN: true }),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      severity: fc.constantFrom(...SEVERITIES),
      verdict: fc.constantFrom(...VERDICTS),
      reason: fc.string(),
      freshness: fc.constantFrom(...FRESHNESS),
      constraintLevel: fc.constantFrom(...CONSTRAINT_LEVELS),
      recoveryRequired: fc.boolean(),
      createdAt: fc.date().map((d) => d.toISOString()),
    })
    .map((fields) =>
      buildDomainJudgementPacket({
        domain: fields.domain,
        targetObjectType: "belief",
        targetObjectId: fields.targetObjectId,
        targetSummary: fields.targetSummary,
        judgementType: fields.judgementType,
        score: fields.score,
        confidence: fields.confidence,
        severity: fields.severity,
        verdict: fields.verdict,
        reason: fields.reason,
        freshness: fields.freshness,
        constraintLevel: fields.constraintLevel,
        suggestedNextStep: null,
        recoveryRequired: fields.recoveryRequired,
        createdAt: fields.createdAt,
      }),
    );
}

describe("aggregateDomainJudgementPackets — Property 7: 聚合单调性", () => {
  // **Validates: Requirements 7.2**
  it("highestSeverity 的 rank ≥ 任意单条 packet 的 severity rank；空集合 highestSeverity===null", () => {
    fc.assert(
      fc.property(fc.array(packetArb()), (packets) => {
        const agg = aggregateDomainJudgementPackets(packets);

        if (packets.length === 0) {
          expect(agg.highestSeverity).toBeNull();
          return;
        }

        expect(agg.highestSeverity).not.toBeNull();
        const aggRank = SEVERITY_RANK[agg.highestSeverity!];
        for (const packet of packets) {
          expect(aggRank).toBeGreaterThanOrEqual(SEVERITY_RANK[packet.severity]);
        }
        // 单调上界恰好等于集合内最大 rank
        const maxRank = Math.max(...packets.map((p) => SEVERITY_RANK[p.severity]));
        expect(aggRank).toBe(maxRank);
      }),
    );
  });
});

describe("aggregateDomainJudgementPackets — blockedDomains/constraintLevel 单元测试", () => {
  // _Requirements: 7.3, 7.4, 7.5_
  function packet(overrides: Partial<DomainJudgementPacket>): DomainJudgementPacket {
    return buildDomainJudgementPacket({
      domain: "D0_ASPIRATION",
      targetObjectType: "belief",
      targetObjectId: "obj-1",
      targetSummary: "摘要",
      judgementType: "signal",
      score: 0.5,
      confidence: 0.5,
      severity: "low",
      verdict: "observe",
      reason: "理由",
      freshness: "fresh",
      constraintLevel: "ADVISORY",
      suggestedNextStep: null,
      recoveryRequired: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    });
  }

  it("同一 domain 多条 block 判断包在 blockedDomains 中只出现一次（去重）", () => {
    const agg = aggregateDomainJudgementPackets([
      packet({ domain: "D2_GOAL", verdict: "block", targetObjectId: "a" }),
      packet({ domain: "D2_GOAL", verdict: "block", targetObjectId: "b" }),
      packet({ domain: "D2_GOAL", verdict: "block", targetObjectId: "c" }),
    ]);
    expect(agg.blockedDomains).toEqual(["D2_GOAL"]);
  });

  it("constraintLevel 取最高级别", () => {
    const agg = aggregateDomainJudgementPackets([
      packet({ constraintLevel: "ADVISORY", targetObjectId: "a" }),
      packet({ constraintLevel: "CONFIRMATION_GATE", targetObjectId: "b" }),
      packet({ constraintLevel: "STRONG_DEFAULT", targetObjectId: "c" }),
    ]);
    expect(agg.constraintLevel).toBe("CONFIRMATION_GATE");
  });

  it("verdict==='block' 进入 blockedDomains", () => {
    const agg = aggregateDomainJudgementPackets([
      packet({ domain: "D3_DECISION", verdict: "block", constraintLevel: "ADVISORY" }),
    ]);
    expect(agg.blockedDomains).toContain("D3_DECISION");
  });

  it("constraintLevel==='HARD_CONSTRAINT' 即使 verdict 非 block 也进入 blockedDomains", () => {
    const agg = aggregateDomainJudgementPackets([
      packet({
        domain: "D4_BEHAVIOR",
        verdict: "observe",
        constraintLevel: "HARD_CONSTRAINT",
      }),
    ]);
    expect(agg.blockedDomains).toContain("D4_BEHAVIOR");
  });

  it("既非 block 也非 HARD_CONSTRAINT 的 domain 不进入 blockedDomains", () => {
    const agg = aggregateDomainJudgementPackets([
      packet({
        domain: "D5_EXECUTION",
        verdict: "support",
        constraintLevel: "WEAK_DEFAULT",
      }),
    ]);
    expect(agg.blockedDomains).not.toContain("D5_EXECUTION");
  });
});
