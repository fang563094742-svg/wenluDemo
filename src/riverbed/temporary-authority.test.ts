import { describe, it, expect } from "vitest";
import { TemporaryAuthorityActor } from "./temporary-authority.js";

describe("TemporaryAuthorityActor", () => {
  it("applyDelta 叠加到 base 并 clamp[0,1]", () => {
    let t = 1000;
    const actor = new TemporaryAuthorityActor({ now: () => t });
    actor.applyDelta({ nodeId: "n1", delta: 0.2, appliedAt: t });
    expect(actor.computeEffectiveAuthority("n1", 0.5)).toBeCloseTo(0.7, 5);
    // clamp 上界
    actor.applyDelta({ nodeId: "n1", delta: 0.9, appliedAt: t });
    expect(actor.computeEffectiveAuthority("n1", 0.5)).toBe(1);
  });

  it("无 entry → 返回 clamp(base)", () => {
    const actor = new TemporaryAuthorityActor({ now: () => 0 });
    expect(actor.computeEffectiveAuthority("none", 0.4)).toBe(0.4);
    expect(actor.computeEffectiveAuthority("none", 1.5)).toBe(1);
  });

  it("60s 后过期 → 回落 base，并被 GC", () => {
    let t = 1000;
    const actor = new TemporaryAuthorityActor({ now: () => t });
    actor.applyDelta({ nodeId: "n1", delta: 0.3, appliedAt: t });
    expect(actor.computeEffectiveAuthority("n1", 0.5)).toBeCloseTo(0.8, 5);
    t = 1000 + 60_001; // 过 TTL
    expect(actor.computeEffectiveAuthority("n1", 0.5)).toBe(0.5);
    expect(actor.size()).toBe(0); // 读时顺手 GC
  });

  it("非法 delta / ttl 被忽略，不写入", () => {
    const actor = new TemporaryAuthorityActor({ now: () => 0 });
    actor.applyDelta({ nodeId: "n1", delta: 2, appliedAt: 0 }); // |delta|>1
    actor.applyDelta({ nodeId: "n2", delta: 0.1, appliedAt: 0, ttlMs: 999_999 }); // ttl 超 60s
    expect(actor.size()).toBe(0);
  });
});
