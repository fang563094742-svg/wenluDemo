/**
 * 跨层集成测试：河床判断 → 出网授权 → 出口启用（复刻 riverMain 的接线语义，不 import riverMain）
 * ------------------------------------------------------------------
 * 验证"必须有判断的内容才行"这条核心约束端到端成立：
 *   河床 D11_RESOURCE 有合格判断 ⇒ entitlement.allowOverseas=true ⇒ NetEgress 启用 proxy 出口。
 *   河床无该判断 ⇒ allowOverseas=false ⇒ proxy 出口被裁剪，被墙站不可达（如实降级，不假装）。
 */

import { describe, it, expect } from "vitest";
import { emptyRiverbedState, upsertRiverbedNode } from "../riverbed/riverbed-store.js";
import { buildDomainJudgementPacket } from "../riverbed/domain-judgement-packet.js";
import { resolveEgressEntitlement } from "./entitlement.js";
import { NetEgress, type EgressTransports } from "./egress.js";

/** 复刻 riverMain.currentEgressEntitlement 的语义：从河床节点抽 D11 判断喂给 entitlement。 */
function entitlementFromRiverbed(rb: ReturnType<typeof emptyRiverbedState>, isPaid: boolean) {
  const nodes = rb.nodes.map((n) => ({
    domain: n.packet.domain as string,
    verdict: n.packet.verdict as string,
    confidence: n.packet.confidence,
  }));
  return resolveEgressEntitlement({ userId: "u", isPaidUser: isPaid, planAllowsOverseas: isPaid, riverbedNodes: nodes });
}

const blockedSiteTransports: EgressTransports = {
  directGet: async () => "__ERR__blocked",
  dohDirectGet: async () => "__ERR__blocked",
  proxyGet: async () => "OVERSEAS_BODY",
};

describe("跨层集成 · 河床判断门控境外出口", () => {
  it("河床 D11 有合格判断 → 授权 → proxy 出口启用 → 被墙站可达", async () => {
    const rb = emptyRiverbedState();
    const packet = buildDomainJudgementPacket({
      domain: "D11_RESOURCE",
      targetObjectType: "manual",
      targetObjectId: "resource-net-need",
      targetSummary: "该用户确有深度联网需求",
      judgementType: "signal",
      score: 0.8,
      confidence: 0.8,
      severity: "medium",
      verdict: "observe",
      reason: "多次任务需访问境外资料",
      freshness: "fresh",
      constraintLevel: "ADVISORY",
      suggestedNextStep: null,
      recoveryRequired: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    upsertRiverbedNode(rb, packet, 1);

    const ent = entitlementFromRiverbed(rb, true);
    expect(ent.allowOverseas).toBe(true);

    const net = new NetEgress(blockedSiteTransports);
    const res = await net.fetch("https://duckduckgo.com", { entitlement: ent });
    expect(res.ok).toBe(true);
    expect(res.exit).toBe("proxy");
  });

  it("河床无 D11 判断 → 不授权 → proxy 被裁剪 → 被墙站不可达（如实降级）", async () => {
    const rb = emptyRiverbedState(); // 空河床
    const ent = entitlementFromRiverbed(rb, true);
    expect(ent.allowOverseas).toBe(false);

    const net = new NetEgress(blockedSiteTransports);
    const res = await net.fetch("https://duckduckgo.com", { entitlement: ent });
    expect(res.ok).toBe(false);
    expect(res.attempts.some((a) => a.exit === "proxy")).toBe(false);
  });

  it("河床 D11 判断被 block → 即便付费也不授权（风险阻断优先）", async () => {
    const rb = emptyRiverbedState();
    const packet = buildDomainJudgementPacket({
      domain: "D11_RESOURCE",
      targetObjectType: "manual",
      targetObjectId: "resource-risk",
      targetSummary: "该用户联网行为存在风险",
      judgementType: "risk",
      score: 0.9,
      confidence: 0.9,
      severity: "high",
      verdict: "block",
      reason: "检测到风险，阻断境外出口",
      freshness: "fresh",
      constraintLevel: "HARD_CONSTRAINT",
      suggestedNextStep: null,
      recoveryRequired: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    upsertRiverbedNode(rb, packet, 1);

    const ent = entitlementFromRiverbed(rb, true);
    expect(ent.allowOverseas).toBe(false);
  });
});
