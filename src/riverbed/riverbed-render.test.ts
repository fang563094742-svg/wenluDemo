import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { renderRiverbedBlock } from "./riverbed-render.js";
import {
  buildDomainJudgementPacket,
  type BuildPacketInput,
  type DomainJudgementPacket,
} from "./domain-judgement-packet.js";
import { aggregateDomainJudgementPackets } from "./domain-aggregation.js";
import {
  emptyRiverbedState,
  upsertRiverbedNode,
  type RiverbedNode,
} from "./riverbed-store.js";
import { RIVERBED_DOMAIN_IDS } from "./riverbed-domain.js";

/** 渲染输出的默认字符上限（与 riverbed-render.ts 的 DEFAULT_MAX_CHARS 对齐）。 */
const DEFAULT_MAX_CHARS = 1500;

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
const TARGET_OBJECT_TYPES = [
  "belief",
  "userModel",
  "conversation",
  "context",
  "manual",
  "riverbed",
] as const;

/** 安全文本：不含任何引擎触发字段名（避免与守卫语义冲突）。 */
const safeTextArb: fc.Arbitrary<string> = fc
  .string()
  .filter(
    (s) =>
      !s.includes("enginePacket") &&
      !s.includes("executionAllowed") &&
      !s.includes("selectedEngine"),
  );

const buildPacketInputArb: fc.Arbitrary<BuildPacketInput> = fc.record({
  domain: fc.constantFrom(...RIVERBED_DOMAIN_IDS),
  targetObjectType: fc.constantFrom(...TARGET_OBJECT_TYPES),
  targetObjectId: fc.constantFrom("t1", "t2", "t3", "target-x", "obj-42"),
  targetSummary: safeTextArb,
  judgementType: fc.constantFrom(...JUDGEMENT_TYPES),
  score: fc.double({ min: 0, max: 1, noNaN: true }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  severity: fc.constantFrom(...SEVERITIES),
  verdict: fc.constantFrom(...VERDICTS),
  reason: safeTextArb,
  freshness: fc.constantFrom(...FRESHNESS),
  constraintLevel: fc.constantFrom(...CONSTRAINT_LEVELS),
  suggestedNextStep: fc.option(safeTextArb, { nil: null }),
  suggestedCutList: fc.array(safeTextArb, { maxLength: 4 }),
  recoveryRequired: fc.boolean(),
  createdAt: fc.constantFrom(
    "2026-01-01T00:00:00.000Z",
    "2026-02-02T12:00:00.000Z",
  ),
});

const packetArb: fc.Arbitrary<DomainJudgementPacket> = buildPacketInputArb.map((input) =>
  buildDomainJudgementPacket(input),
);

/** 由判断包集合构造河床节点集合（经 upsert，nodeId 唯一）。 */
const nodesArb: fc.Arbitrary<RiverbedNode[]> = fc
  .array(packetArb, { maxLength: 20 })
  .map((packets) => {
    const rb = emptyRiverbedState();
    packets.forEach((packet, i) => upsertRiverbedNode(rb, packet, i));
    return rb.nodes;
  });

// ──────────────────────────────────────────────────────────────────
// Task 11.2 — Property 12: 渲染纯净
// ──────────────────────────────────────────────────────────────────

describe("renderRiverbedBlock — Property 12: 渲染纯净", () => {
  // **Validates: Requirements 8.4**
  it("输出不含引擎触发字段名且长度 <= 默认上限", () => {
    fc.assert(
      fc.property(nodesArb, (nodes) => {
        const agg = aggregateDomainJudgementPackets(nodes.map((n) => n.packet));
        const out = renderRiverbedBlock(nodes, agg);

        expect(out).not.toContain("enginePacket");
        expect(out).not.toContain("executionAllowed");
        expect(out).not.toContain("selectedEngine");
        expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 11.3 — 空集合 / 上限边界 / 截断单元测试
// ──────────────────────────────────────────────────────────────────

function makePacket(overrides: Partial<BuildPacketInput> = {}): DomainJudgementPacket {
  return buildDomainJudgementPacket({
    domain: "D9_COGNITION",
    targetObjectType: "belief",
    targetObjectId: "t1",
    targetSummary: "摘要",
    judgementType: "signal",
    score: 0.5,
    confidence: 0.5,
    severity: "high",
    verdict: "warn",
    reason: "理由",
    freshness: "fresh",
    constraintLevel: "ADVISORY",
    suggestedNextStep: null,
    recoveryRequired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("renderRiverbedBlock — 边界单元测试", () => {
  it("空 nodes 返回占位串「（河床尚在形成）」", () => {
    const agg = aggregateDomainJudgementPackets([]);
    expect(renderRiverbedBlock([], agg)).toBe("（河床尚在形成）");
  });

  it("maxChars=0 返回空字符串", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(rb, makePacket({ targetObjectId: "a" }), 0);
    const agg = aggregateDomainJudgementPackets(rb.nodes.map((n) => n.packet));
    expect(renderRiverbedBlock(rb.nodes, agg, 0)).toBe("");
  });

  it("超长内容被截断到 <= maxChars", () => {
    const rb = emptyRiverbedState();
    for (let i = 0; i < 12; i += 1) {
      upsertRiverbedNode(
        rb,
        makePacket({
          targetObjectId: `t-${i}`,
          reason: "这是一个很长的理由".repeat(20),
          suggestedNextStep: "下一步建议".repeat(20),
        }),
        0,
      );
    }
    const agg = aggregateDomainJudgementPackets(rb.nodes.map((n) => n.packet));
    const maxChars = 120;
    const out = renderRiverbedBlock(rb.nodes, agg, maxChars);
    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out.length).toBeGreaterThan(0);
  });
});
