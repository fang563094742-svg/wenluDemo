import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  emptyRiverbedState,
  getActiveRiverbedNodes,
  upsertRiverbedNode,
  pruneRiverbedNodes,
  refluxRiverbed,
  type RefluxSignals,
  type RiverbedState,
} from "./riverbed-store.js";
import {
  buildDomainJudgementPacket,
  type BuildPacketInput,
  type DomainJudgementPacket,
} from "./domain-judgement-packet.js";
import { RIVERBED_DOMAIN_IDS } from "./riverbed-domain.js";

// ──────────────────────────────────────────────────────────────────
// 共享生成器：构造任意合法判断包（经 buildDomainJudgementPacket 归一化）。
// ──────────────────────────────────────────────────────────────────

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

/** 生成任意合法 BuildPacketInput，score/confidence 含越界值以覆盖 clamp。 */
const buildPacketInputArb: fc.Arbitrary<BuildPacketInput> = fc.record({
  domain: fc.constantFrom(...RIVERBED_DOMAIN_IDS),
  targetObjectType: fc.constantFrom(...TARGET_OBJECT_TYPES),
  targetObjectId: fc.constantFrom("t1", "t2", "t3", "target-x", "obj-42"),
  targetSummary: safeTextArb,
  judgementType: fc.constantFrom(...JUDGEMENT_TYPES),
  score: fc.double({ min: -2, max: 2, noNaN: true }),
  confidence: fc.double({ min: -2, max: 2, noNaN: true }),
  severity: fc.constantFrom(...SEVERITIES),
  verdict: fc.constantFrom(...VERDICTS),
  reason: safeTextArb,
  freshness: fc.constantFrom(...FRESHNESS),
  constraintLevel: fc.constantFrom(...CONSTRAINT_LEVELS),
  suggestedNextStep: fc.option(safeTextArb, { nil: null }),
  recoveryRequired: fc.boolean(),
  createdAt: fc.constantFrom(
    "2026-01-01T00:00:00.000Z",
    "2026-02-02T12:00:00.000Z",
    "2026-03-03T08:30:00.000Z",
  ),
});

/** 由 BuildPacketInput 生成归一化判断包。 */
const packetArb: fc.Arbitrary<DomainJudgementPacket> = buildPacketInputArb.map((input) =>
  buildDomainJudgementPacket(input),
);

// ──────────────────────────────────────────────────────────────────
// Task 9.2 — Property 4: upsert 幂等
// ──────────────────────────────────────────────────────────────────

describe("upsertRiverbedNode — Property 4: upsert 幂等", () => {
  // **Validates: Requirements 5.3**
  it("连续 upsert 同一 packet N 次后，该 nodeId 恰 1 个且 hitCount===N", () => {
    fc.assert(
      fc.property(packetArb, fc.integer({ min: 1, max: 20 }), (packet, n) => {
        const rb: RiverbedState = emptyRiverbedState();
        for (let i = 0; i < n; i += 1) {
          upsertRiverbedNode(rb, packet, i);
        }
        const matches = rb.nodes.filter((node) => node.nodeId === packet.packetId);
        expect(matches.length).toBe(1);
        expect(matches[0].hitCount).toBe(n);
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 10.2 — Property 8: reflux 有界 & 不删
// ──────────────────────────────────────────────────────────────────

const refluxSignalsArb: fc.Arbitrary<RefluxSignals> = fc.record({
  hitRate: fc.double({ min: 0, max: 1, noNaN: true }),
  repetition: fc.double({ min: 0, max: 1, noNaN: true }),
  settledPredictions: fc.array(
    fc.record({
      status: fc.constantFrom("hit" as const, "miss" as const),
      relatedTo: fc.option(
        fc.oneof(fc.constantFrom(...RIVERBED_DOMAIN_IDS), fc.string()),
        { nil: undefined },
      ),
    }),
    { maxLength: 8 },
  ),
});

describe("refluxRiverbed — Property 8: reflux 有界 & 不删", () => {
  // **Validates: Requirements 11.1, 11.5**
  it("校准后每节点 confidence/interruptAuthority ∈ [0,1] 且 nodes.length 不减少", () => {
    fc.assert(
      fc.property(
        fc.array(packetArb, { maxLength: 12 }),
        refluxSignalsArb,
        fc.integer({ min: 0, max: 500 }),
        (packets, signals, currentCycle) => {
          const rb: RiverbedState = emptyRiverbedState();
          packets.forEach((packet, i) => upsertRiverbedNode(rb, packet, i));
          const countBefore = rb.nodes.length;

          refluxRiverbed(rb, signals, currentCycle);

          expect(rb.nodes.length).toBeGreaterThanOrEqual(countBefore);
          for (const node of rb.nodes) {
            expect(node.packet.confidence).toBeGreaterThanOrEqual(0);
            expect(node.packet.confidence).toBeLessThanOrEqual(1);
            expect(node.interruptAuthority).toBeGreaterThanOrEqual(0);
            expect(node.interruptAuthority).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Task 9.3 — getActiveRiverbedNodes / pruneRiverbedNodes 单元测试
// ──────────────────────────────────────────────────────────────────

/** 便捷构造判断包（默认安全字段，按需覆盖）。 */
function makePacket(overrides: Partial<BuildPacketInput> = {}): DomainJudgementPacket {
  return buildDomainJudgementPacket({
    domain: "D9_COGNITION",
    targetObjectType: "belief",
    targetObjectId: "t1",
    targetSummary: "摘要",
    judgementType: "signal",
    score: 0.5,
    confidence: 0.5,
    severity: "medium",
    verdict: "observe",
    reason: "理由",
    freshness: "fresh",
    constraintLevel: "ADVISORY",
    suggestedNextStep: null,
    recoveryRequired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("getActiveRiverbedNodes — 过滤 / 排序 / 上限 / 无副作用", () => {
  it("排除 freshness=stale 且 recoveryRequired=false 的节点", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "stale-drop", freshness: "stale", recoveryRequired: false }),
      0,
    );
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "stale-keep", freshness: "stale", recoveryRequired: true }),
      0,
    );
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "fresh-keep", freshness: "fresh", recoveryRequired: false }),
      0,
    );

    const active = getActiveRiverbedNodes(rb, new Date());
    const ids = active.map((n) => n.packet.targetObjectId);
    expect(ids).toContain("stale-keep");
    expect(ids).toContain("fresh-keep");
    expect(ids).not.toContain("stale-drop");
  });

  it("按 severity × interruptAuthority × confidence 降序排列", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "low", severity: "low", confidence: 0.3 }),
      0,
    );
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "high", severity: "critical", confidence: 0.9 }),
      0,
    );
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "mid", severity: "high", confidence: 0.6 }),
      0,
    );

    const active = getActiveRiverbedNodes(rb, new Date());
    expect(active[0].packet.targetObjectId).toBe("high");
    expect(active[active.length - 1].packet.targetObjectId).toBe("low");
  });

  it("截断为前 maxN 个", () => {
    const rb = emptyRiverbedState();
    for (let i = 0; i < 10; i += 1) {
      upsertRiverbedNode(rb, makePacket({ targetObjectId: `t-${i}`, score: i / 10 }), 0);
    }
    expect(getActiveRiverbedNodes(rb, new Date(), 3).length).toBe(3);
    expect(getActiveRiverbedNodes(rb, new Date(), 0).length).toBe(0);
  });

  it("不修改输入 rb.nodes（引用与内容不变）", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(rb, makePacket({ targetObjectId: "a", severity: "low" }), 0);
    upsertRiverbedNode(rb, makePacket({ targetObjectId: "b", severity: "critical" }), 0);

    const nodesRef = rb.nodes;
    const snapshot = rb.nodes.map((n) => n.nodeId);

    getActiveRiverbedNodes(rb, new Date());

    expect(rb.nodes).toBe(nodesRef);
    expect(rb.nodes.map((n) => n.nodeId)).toEqual(snapshot);
  });
});

describe("pruneRiverbedNodes — 上限淘汰 / 保护 / 返回淘汰数", () => {
  it("未超上限返回 0 且不改动节点", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(rb, makePacket({ targetObjectId: "a" }), 0);
    upsertRiverbedNode(rb, makePacket({ targetObjectId: "b" }), 0);
    expect(pruneRiverbedNodes(rb, 5)).toBe(0);
    expect(rb.nodes.length).toBe(2);
  });

  it("超上限按价值分淘汰最低者并返回淘汰数", () => {
    const rb = emptyRiverbedState();
    // 高价值节点（critical + fresh）应保留
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "keep", severity: "high", freshness: "fresh", confidence: 0.9 }),
      0,
    );
    // 低价值节点（none + stale）应被淘汰
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "drop", severity: "none", freshness: "stale", recoveryRequired: false, confidence: 0.1 }),
      0,
    );

    const removed = pruneRiverbedNodes(rb, 1);
    expect(removed).toBe(1);
    expect(rb.nodes.length).toBe(1);
    expect(rb.nodes[0].packet.targetObjectId).toBe("keep");
  });

  it("保护 severity=critical 与 recoveryRequired=true 的节点不被淘汰", () => {
    const rb = emptyRiverbedState();
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "critical", severity: "critical" }),
      0,
    );
    upsertRiverbedNode(
      rb,
      makePacket({ targetObjectId: "recovery", severity: "low", recoveryRequired: true }),
      0,
    );

    // 上限为 0：两节点都超限，但都受保护，故无人被淘汰。
    const removed = pruneRiverbedNodes(rb, 0);
    expect(removed).toBe(0);
    const ids = rb.nodes.map((n) => n.packet.targetObjectId);
    expect(ids).toContain("critical");
    expect(ids).toContain("recovery");
  });
});
