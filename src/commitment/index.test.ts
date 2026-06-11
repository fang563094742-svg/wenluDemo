import { describe, it, expect } from "vitest";
import {
  detectCommitment,
  toAnchor,
  dueAnchors,
  computeFulfillmentRate,
  type CommitmentAnchor,
} from "./index.js";

const NOW = Date.parse("2026-06-11T00:00:00.000Z");

describe("detectCommitment", () => {
  it("第一人称未来时 + 时间锚 → 命中", () => {
    const r = detectCommitment("我明天要把方案写完", NOW);
    expect(r.matched).toBe(true);
    expect(r.horizonMs).toBeGreaterThan(NOW);
    expect(r.strength).toBe("loose"); // "我明天要"非连续"我要"，按原逻辑为 loose
  });

  it("连续'我要' → firm", () => {
    const r = detectCommitment("我要在明天完成提交", NOW);
    expect(r.matched).toBe(true);
    expect(r.strength).toBe("firm");
  });

  it("无时间锚 → 不命中", () => {
    expect(detectCommitment("我觉得这个不错", NOW).matched).toBe(false);
  });

  it("强承诺主题 + 强 hedge → inviolable", () => {
    const r = detectCommitment("我下个月一定要辞职", NOW);
    expect(r.matched).toBe(true);
    expect(r.strength).toBe("inviolable");
  });

  it("空串/非法 nowMs → 不命中", () => {
    expect(detectCommitment("", NOW).matched).toBe(false);
    expect(detectCommitment("我明天要写完", NaN).matched).toBe(false);
  });
});

describe("toAnchor / dueAnchors", () => {
  it("命中结果可转锚点；到期后进入 due", () => {
    const r = detectCommitment("我今晚要跑步", NOW);
    const anchor = toAnchor(r, NOW, 0);
    expect(anchor).not.toBeNull();
    // 到期前不在 due
    expect(dueAnchors([anchor!], NOW).length).toBe(0);
    // 到期后在 due
    expect(dueAnchors([anchor!], anchor!.horizonMs + 1).length).toBe(1);
    // 已回访不在 due
    expect(dueAnchors([{ ...anchor!, lookedBack: true }], anchor!.horizonMs + 1).length).toBe(0);
  });
});

describe("computeFulfillmentRate", () => {
  it("(fulfilled + 0.5×half) / 已回报总数", () => {
    const anchors: CommitmentAnchor[] = [
      mk("fulfilled"), mk("fulfilled"), mk("half"), mk("unfulfilled"), mk(null),
    ];
    const r = computeFulfillmentRate(anchors);
    expect(r.total).toBe(4); // null 未回报不计
    expect(r.rate).toBe(Number(((2 + 0.5) / 4).toFixed(4)));
  });
  it("无回报 → rate 0", () => {
    expect(computeFulfillmentRate([mk(null)]).rate).toBe(0);
  });
});

function mk(report: CommitmentAnchor["report"]): CommitmentAnchor {
  return {
    anchorId: `a-${Math.random()}`,
    commitText: "x",
    createdAtMs: NOW,
    horizonMs: NOW + 1000,
    strength: "firm",
    sincerityScore: 0.5,
    lookedBack: report !== null,
    report,
  };
}
