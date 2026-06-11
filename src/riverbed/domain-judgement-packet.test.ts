import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildDomainJudgementPacket,
  type BuildPacketInput,
} from "./domain-judgement-packet.js";
import { evaluateNoEngineTriggerGuard } from "./no-engine-trigger-guard.js";
import { RIVERBED_DOMAIN_IDS } from "./riverbed-domain.js";

const TARGET_OBJECT_TYPES = [
  "belief",
  "userModel",
  "conversation",
  "context",
  "manual",
  "riverbed",
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

/**
 * 生成任意合法 BuildPacketInput。
 * - domain ∈ 合法 14 域
 * - targetObjectId trim 后保证非空（前缀稳定字符再补任意空白）
 * - score/confidence 默认任意有限/边界值（NaN/负/超界）
 */
function buildPacketInputArb(
  scoreArb: fc.Arbitrary<number> = fc.oneof(
    fc.double(),
    fc.constantFrom(NaN, Infinity, -Infinity, -1, 2, 1.5, -0.3),
  ),
): fc.Arbitrary<BuildPacketInput> {
  return fc.record(
    {
      domain: fc.constantFrom(...RIVERBED_DOMAIN_IDS),
      targetObjectType: fc.constantFrom(...TARGET_OBJECT_TYPES),
      // 保证 trim 后非空：固定非空 token + 任意尾随
      targetObjectId: fc.string().map((s) => `t_${s}`),
      targetSummary: fc.string(),
      judgementType: fc.constantFrom(...JUDGEMENT_TYPES),
      score: scoreArb,
      confidence: scoreArb,
      severity: fc.constantFrom(...SEVERITIES),
      verdict: fc.constantFrom(...VERDICTS),
      reason: fc.string(),
      freshness: fc.constantFrom(...FRESHNESS),
      constraintLevel: fc.constantFrom(...CONSTRAINT_LEVELS),
      suggestedNextStep: fc.option(fc.string(), { nil: null }),
      recoveryRequired: fc.boolean(),
      createdAt: fc.date().map((d) => d.toISOString()),
    },
    {
      requiredKeys: [
        "domain",
        "targetObjectType",
        "targetObjectId",
        "targetSummary",
        "judgementType",
        "score",
        "confidence",
        "severity",
        "verdict",
        "reason",
        "freshness",
        "constraintLevel",
        "suggestedNextStep",
        "recoveryRequired",
        "createdAt",
      ],
    },
  );
}

describe("buildDomainJudgementPacket — Property 1: 守卫不变量", () => {
  // **Validates: Requirements 3.1, 3.2, 3.5**
  it("任意合法输入产出的 packet 经守卫 allowed === true", () => {
    fc.assert(
      fc.property(buildPacketInputArb(), (input) => {
        const packet = buildDomainJudgementPacket(input);
        expect(evaluateNoEngineTriggerGuard(packet).allowed).toBe(true);
      }),
    );
  });
});

describe("buildDomainJudgementPacket — Property 2: clamp 不变量", () => {
  // **Validates: Requirements 2.1, 2.2**
  it("含 NaN/负数/>1 的 score/confidence 产出 packet 仍 ∈ [0,1]", () => {
    const wildNumber = fc.oneof(
      fc.constantFrom(NaN, Infinity, -Infinity),
      fc.double({ min: -1e9, max: 1e9, noNaN: false }),
      fc.constantFrom(-1, -0.5, 1.5, 2, 100),
    );
    fc.assert(
      fc.property(buildPacketInputArb(wildNumber), (input) => {
        const packet = buildDomainJudgementPacket(input);
        expect(packet.score).toBeGreaterThanOrEqual(0);
        expect(packet.score).toBeLessThanOrEqual(1);
        expect(packet.confidence).toBeGreaterThanOrEqual(0);
        expect(packet.confidence).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("buildDomainJudgementPacket — Property 3: packetId 稳定性（幂等）", () => {
  // **Validates: Requirements 2.3**
  it("语义相同(仅可选字段顺序/空白不同)的两份输入产出同一 packetId", () => {
    fc.assert(
      fc.property(
        buildPacketInputArb(fc.double({ min: 0, max: 1, noNaN: true })),
        // 用于给 trim 字段加的任意空白(两侧)
        fc.string().filter((s) => s.trim() === ""),
        fc.string().filter((s) => s.trim() === ""),
        fc.array(fc.string()),
        (base, padA, padB, extraNodes) => {
          // 不提供 packetId,强制走稳定哈希路径
          const { packetId: _ignored, ...rest } = base as BuildPacketInput & {
            packetId?: string;
          };
          // a / b 语义相同：trim 字段加不同空白,可选数组字段顺序/内容不同
          const a: BuildPacketInput = {
            ...rest,
            targetObjectId: `${padA}${base.targetObjectId.trim()}${padB}`,
            reason: `${padA}${base.reason.trim()}${padB}`,
            matchedNodeIds: extraNodes,
            evidenceRefs: [],
            suggestedCutList: extraNodes,
          };
          const b: BuildPacketInput = {
            ...rest,
            targetObjectId: `${padB}${base.targetObjectId.trim()}${padA}`,
            reason: `${padB}${base.reason.trim()}${padA}`,
            matchedNodeIds: [...extraNodes].reverse(),
            evidenceRefs: [],
            suggestedCutList: [...extraNodes].reverse(),
          };
          expect(buildDomainJudgementPacket(a).packetId).toBe(
            buildDomainJudgementPacket(b).packetId,
          );
        },
      ),
    );
  });
});

describe("buildDomainJudgementPacket — 校验顺序与边界单元测试", () => {
  // _Requirements: 2.4, 2.5, 3.3, 3.6_
  function validInput(overrides: Partial<BuildPacketInput> = {}): BuildPacketInput {
    return {
      domain: "D0_ASPIRATION",
      targetObjectType: "belief",
      targetObjectId: "obj-1",
      targetSummary: "摘要",
      judgementType: "alignment",
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
    };
  }

  it("非法 domain 先于 targetObjectId 校验抛 INVALID_DOMAIN（即使 target 也为空）", () => {
    expect(() =>
      buildDomainJudgementPacket(
        validInput({ domain: "NOT_A_DOMAIN" as never, targetObjectId: "   " }),
      ),
    ).toThrow("DOMAIN_JUDGEMENT_PACKET_INVALID_DOMAIN");
  });

  it("合法 domain 但 targetObjectId trim 后为空抛 TARGET_REQUIRED", () => {
    expect(() =>
      buildDomainJudgementPacket(validInput({ targetObjectId: "   " })),
    ).toThrow("DOMAIN_JUDGEMENT_PACKET_TARGET_REQUIRED");
  });

  it("输入夹带 executionAllowed:true 抛 DOMAIN_ENGINE_TRIGGER_BLOCKED", () => {
    expect(() =>
      buildDomainJudgementPacket(
        validInput({ executionAllowed: true } as never),
      ),
    ).toThrow("DOMAIN_ENGINE_TRIGGER_BLOCKED");
  });

  it("无建议字段时 suggestedNextStep===null 且 suggestedCutList===[]", () => {
    const packet = buildDomainJudgementPacket(validInput());
    expect(packet.suggestedNextStep).toBeNull();
    expect(packet.suggestedCutList).toEqual([]);
  });
});
