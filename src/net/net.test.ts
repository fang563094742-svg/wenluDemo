/**
 * 统一出网层（Net Egress）· 单元测试
 * ------------------------------------------------------------------
 * 覆盖三块第一性逻辑：
 *   1. entitlement：多用户判断门控——订阅 ∩ 河床 D11 资源域判断，缺一不放行境外出口。
 *   2. healthTable：EWMA 自适应——失败的源被压低排序，快且稳的源升到前面。
 *   3. NetEgress：按授权裁剪出口集 + 健康表择优 + 故障转移；全失败不编造正文。
 */

import { describe, it, expect } from "vitest";
import {
  resolveEgressEntitlement,
  localEgressEntitlement,
  type EntitlementRiverbedNodeLike,
} from "./entitlement.js";
import { EgressHealthTable } from "./healthTable.js";
import { NetEgress, type EgressTransports } from "./egress.js";

describe("EgressEntitlement · 多用户判断门控", () => {
  const goodNode: EntitlementRiverbedNodeLike = {
    domain: "D11_RESOURCE",
    verdict: "observe",
    confidence: 0.7,
  };

  it("非付费用户：直接拒绝境外出口", () => {
    const e = resolveEgressEntitlement({ userId: "u1", isPaidUser: false, riverbedNodes: [goodNode] });
    expect(e.allowOverseas).toBe(false);
    expect(e.reason).toContain("订阅未达门槛");
  });

  it("付费但河床无 D11 合格判断：拒绝（必须有判断的内容才行）", () => {
    const e = resolveEgressEntitlement({ userId: "u2", isPaidUser: true, riverbedNodes: [] });
    expect(e.allowOverseas).toBe(false);
    expect(e.reason).toContain("无合格判断内容");
  });

  it("付费 + 河床 D11 有 verdict≠block 且置信达标：放行", () => {
    const e = resolveEgressEntitlement({ userId: "u3", isPaidUser: true, riverbedNodes: [goodNode] });
    expect(e.allowOverseas).toBe(true);
    expect(e.reason).toContain("放行境外出口");
  });

  it("付费 + 河床 D11 判断被 block：拒绝（风险阻断优先）", () => {
    const blocked: EntitlementRiverbedNodeLike = { domain: "D11_RESOURCE", verdict: "block", confidence: 0.9 };
    const e = resolveEgressEntitlement({ userId: "u4", isPaidUser: true, riverbedNodes: [blocked] });
    expect(e.allowOverseas).toBe(false);
  });

  it("套餐 features.overseas_egress 显式开启可替代付费判定", () => {
    const e = resolveEgressEntitlement({ userId: "u5", isPaidUser: false, planAllowsOverseas: true, riverbedNodes: [goodNode] });
    expect(e.allowOverseas).toBe(true);
  });

  it("置信度低于门槛：拒绝", () => {
    const weak: EntitlementRiverbedNodeLike = { domain: "D11_RESOURCE", verdict: "observe", confidence: 0.3 };
    const e = resolveEgressEntitlement({ userId: "u6", isPaidUser: true, riverbedNodes: [weak], minResourceConfidence: 0.5 });
    expect(e.allowOverseas).toBe(false);
  });

  it("localEgressEntitlement：无境外出口配置时默认仅国内直连", () => {
    expect(localEgressEntitlement().allowOverseas).toBe(false);
    expect(localEgressEntitlement("local", true).allowOverseas).toBe(true);
  });
});

describe("EgressHealthTable · EWMA 自适应择优", () => {
  it("连续失败的源被压到候选末尾，稳定快速的源排前面", () => {
    const h = new EgressHealthTable();
    // bing 慢但稳；baidu 快且稳；ddg 连续失败。
    for (let i = 0; i < 5; i++) {
      h.record("bing", true, 500);
      h.record("baidu", true, 90);
      h.record("ddg", false, 3000);
    }
    const ranked = h.rank(["bing", "baidu", "ddg"]);
    expect(ranked[0]).toBe("baidu"); // 快且稳 → 最优
    expect(ranked[ranked.length - 1]).toBe("ddg"); // 连续失败 → 垫底
  });

  it("无样本源给乐观初值，保证新源会被探索", () => {
    const h = new EgressHealthTable();
    const fresh = h.get("new-source");
    expect(fresh.samples).toBe(0);
    expect(fresh.successRate).toBeGreaterThan(0.5);
  });

  it("snapshot/restore 往返保留学习", () => {
    const h = new EgressHealthTable();
    h.record("bing", true, 300);
    const snap = h.snapshot();
    const h2 = new EgressHealthTable();
    h2.restore(snap);
    expect(h2.get("bing").samples).toBe(1);
    expect(h2.get("bing").latencyMs).toBe(300);
  });
});

describe("NetEgress · 出口裁剪 + 择优 + 故障转移", () => {
  function makeTransports(behavior: Record<string, () => Promise<string>>): EgressTransports {
    return {
      directGet: behavior.direct ?? (async () => "__ERR__no-direct"),
      dohDirectGet: behavior["doh-direct"] ?? (async () => "__ERR__no-doh"),
      proxyGet: behavior.proxy,
    };
  }

  it("未授权用户：proxy 出口不进入候选，即使配置了 proxyGet", async () => {
    let proxyCalled = false;
    const net = new NetEgress(makeTransports({
      direct: async () => "__ERR__blocked",
      "doh-direct": async () => "__ERR__blocked",
      proxy: async () => { proxyCalled = true; return "PROXY_BODY"; },
    }));
    const res = await net.fetch("https://example.com", {
      entitlement: { userId: "u", allowOverseas: false, reason: "" },
    });
    expect(proxyCalled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.attempts.some((a) => a.exit === "proxy")).toBe(false);
  });

  it("授权用户：国内出口失败后降级到 proxy 并成功", async () => {
    const net = new NetEgress(makeTransports({
      direct: async () => "__ERR__blocked",
      "doh-direct": async () => "__ERR__blocked",
      proxy: async () => "PROXY_BODY",
    }));
    const res = await net.fetch("https://duckduckgo.com", {
      entitlement: { userId: "u", allowOverseas: true, reason: "" },
    });
    expect(res.ok).toBe(true);
    expect(res.exit).toBe("proxy");
    expect(res.body).toBe("PROXY_BODY");
  });

  it("direct 成功即返回，不再尝试其它出口", async () => {
    let dohCalled = false;
    const net = new NetEgress(makeTransports({
      direct: async () => "DIRECT_BODY",
      "doh-direct": async () => { dohCalled = true; return "DOH_BODY"; },
    }));
    const res = await net.fetch("https://www.baidu.com");
    expect(res.ok).toBe(true);
    expect(res.exit).toBe("direct");
    expect(dohCalled).toBe(false);
  });

  it("全部出口失败：ok=false 且不编造正文，留完整 attempts", async () => {
    const net = new NetEgress(makeTransports({
      direct: async () => "__ERR__a",
      "doh-direct": async () => "__ERR__b",
    }));
    const res = await net.fetch("https://blocked.example");
    expect(res.ok).toBe(false);
    expect(res.body).toBe("");
    expect(res.attempts.length).toBeGreaterThanOrEqual(2);
  });

  it("健康表学习后，更优出口被优先尝试", async () => {
    const order: string[] = [];
    const net = new NetEgress({
      directGet: async () => { order.push("direct"); return "__ERR__slow-fail"; },
      dohDirectGet: async () => { order.push("doh"); return "DOH_OK"; },
    });
    // 先跑几轮让 direct 累积失败、doh 累积成功。
    for (let i = 0; i < 4; i++) await net.fetch("https://x.example");
    order.length = 0;
    await net.fetch("https://x.example");
    // 学习后 doh-direct 应排在 direct 前面被先试。
    expect(order[0]).toBe("doh");
  });

  it("空/纯空白正文不算成功，降级到下一出口（修复'连上但0内容被误判'）", async () => {
    const net = new NetEgress(makeTransports({
      direct: async () => "   ",
      "doh-direct": async () => "REAL_BODY",
    }));
    const res = await net.fetch("https://x.example");
    expect(res.ok).toBe(true);
    expect(res.exit).toBe("doh-direct");
    expect(res.attempts.find((a) => a.exit === "direct")?.note).toBe("empty-body");
  });

  it("国内直连出口用更短超时（被墙站快速失败），proxy 用全额超时", async () => {
    const seen: Record<string, number> = {};
    const net = new NetEgress({
      directGet: async (_u, t) => { seen.direct = t; return "__ERR__x"; },
      dohDirectGet: async (_u, t) => { seen.doh = t; return "__ERR__x"; },
      proxyGet: async (_u, t) => { seen.proxy = t; return "PROXY_OK"; },
    });
    await net.fetch("https://blocked.example", {
      entitlement: { userId: "u", allowOverseas: true, reason: "" },
      timeoutMs: 15000,
    });
    // direct/doh 应拿到更短超时（≈6s），proxy 拿到全额（15s）。
    expect(seen.direct).toBeLessThan(15000);
    expect(seen.proxy).toBe(15000);
  });
});
