/**
 * BrainRepo 纯逻辑单测：Mind ↔ 6 板块 的拆/合往返保真（不连 DB）。
 * _Requirements: 2.4, 3.2_
 */
import { describe, it, expect } from "vitest";
import { splitMind, mergeMind, BRAIN_SECTIONS, type BrainSection } from "../brainRepo.js";

const sampleMind: Record<string, unknown> = {
  cycles: 7,
  lastAction: "做了点事",
  metrics: { sayCount: 1 },
  goal: { mission: "变强" },
  beliefs: [{ id: "b1", content: "x" }],
  knowledge: [{ content: "k" }],
  userModel: [{ id: "u1" }],
  reflections: [],
  predictions: [{ id: "p1", status: "open" }],
  masteredTools: [{ name: "t" }],
  rules: [{ rule: "r" }],
  scripts: [],
  skillKB: { skills: [] },
  capabilityDebts: [],
  tasks: [{ id: "t1", goal: "g" }],
  taskChains: [],
  verifiableTasks: [{ id: "vt1", status: "open" }],
  attentionLedger: [],
  riverbed: { nodes: [] },
  commitments: [],
  channels: [{ id: "chat_default", messages: [] }],
  pendingDecisions: [],
  conversation: [{ role: "user", text: "hi" }],
  // 未知/新增字段：应兜底进 core，不丢失
  brandNewField: { keep: true, n: 42 },
};

describe("brainRepo split/merge", () => {
  it("split→merge 往返保真：字段集合与值完全一致", () => {
    const sections = splitMind(sampleMind);
    const merged = mergeMind(sections as Record<BrainSection, Record<string, unknown>>);
    expect(merged).toEqual(sampleMind);
  });

  it("已知字段落到约定板块", () => {
    const s = splitMind(sampleMind);
    expect(s.core).toHaveProperty("cycles");
    expect(s.core).toHaveProperty("goal");
    expect(s.cognition).toHaveProperty("beliefs");
    expect(s.cognition).toHaveProperty("predictions");
    expect(s.capability).toHaveProperty("masteredTools");
    expect(s.tasks).toHaveProperty("verifiableTasks");
    expect(s.riverbed).toHaveProperty("commitments");
    expect(s.channels_meta).toHaveProperty("channels");
    expect(s.channels_meta).toHaveProperty("conversation");
  });

  it("未知字段兜底进 core，不丢失", () => {
    const s = splitMind(sampleMind);
    expect(s.core).toHaveProperty("brandNewField");
    expect((s.core.brandNewField as Record<string, unknown>).n).toBe(42);
  });

  it("空对象拆分得到 6 个空板块", () => {
    const s = splitMind({});
    for (const sec of BRAIN_SECTIONS) {
      expect(s[sec]).toEqual({});
    }
  });
});
