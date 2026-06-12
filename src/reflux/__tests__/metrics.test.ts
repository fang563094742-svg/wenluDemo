/**
 * 成功度量（SkillMetrics）单元测试。
 *
 * 全程依赖注入式 mock（内存 MetricsStore），独立可跑（不连真实 PG）。覆盖任务 18 / Req 13：
 *  - 单技能复用度量（Req 13.1）：use_count/success_count → success_rate；不存在返回 null；
 *    use_count=0 成功率为 0。
 *  - 整体汇总（Req 13.2）：被复用技能数 / 总复用次数 / 平均复用成功率（仅对被复用技能均值）。
 *  - 反哺前后对比（Req 13.3）：前后均有数据给出 delta；任一侧缺数据明确 N/A（null）。
 *  - 继承未使用比例（Req 13.4）：超 T_silent 且未使用 / 已过观察窗 的比例；分母为 0 时比例 0。
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 12.4
 */

import { describe, expect, it } from "vitest";

import {
  createSkillMetrics,
  createInMemoryMetricsStore,
  type InMemoryMetricsStoreInit,
} from "../metrics.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2024-06-01T00:00:00.000Z");

/** 便捷构造 metrics（注入内存 store + 默认配置）。 */
function mkMetrics(init: InMemoryMetricsStoreInit = {}) {
  const store = createInMemoryMetricsStore(init);
  return createSkillMetrics({ store, config: DEFAULT_REFLUX_CONFIG });
}

// ─────────────────────────────────────────────────────────────────
// Req 13.1 单技能复用度量
// ─────────────────────────────────────────────────────────────────

describe("skillReuseMetric（Req 13.1 单技能复用次数/成功率）", () => {
  it("依 use_count/success_count 现算成功率", async () => {
    const m = mkMetrics({
      skills: [{ id: "s1", use_count: 10, success_count: 7 }],
    });
    const r = await m.skillReuseMetric("s1");
    expect(r).not.toBeNull();
    expect(r!.use_count).toBe(10);
    expect(r!.success_count).toBe(7);
    expect(r!.success_rate).toBeCloseTo(0.7, 6);
  });

  it("从未被复用（use_count=0）成功率定义为 0", async () => {
    const m = mkMetrics({ skills: [{ id: "s0", use_count: 0, success_count: 0 }] });
    const r = await m.skillReuseMetric("s0");
    expect(r!.success_rate).toBe(0);
  });

  it("技能不存在返回 null", async () => {
    const m = mkMetrics({ skills: [] });
    expect(await m.skillReuseMetric("nope")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Req 13.2 整体汇总
// ─────────────────────────────────────────────────────────────────

describe("overallSummary（Req 13.2 反哺整体汇总）", () => {
  it("被复用技能数 / 总复用次数 / 平均复用成功率", async () => {
    const m = mkMetrics({
      skills: [
        { id: "s1", use_count: 10, success_count: 8 }, // rate 0.8
        { id: "s2", use_count: 4, success_count: 2 }, //  rate 0.5
        { id: "s3", use_count: 0, success_count: 0 }, //  从未复用，不计入均值
      ],
    });
    const s = await m.overallSummary();
    expect(s.reused_skill_count).toBe(2); // 仅 s1/s2
    expect(s.total_reuse_count).toBe(14); // 10+4+0
    // 平均 = (0.8 + 0.5) / 2 = 0.65（仅对被复用技能取均值）
    expect(s.average_success_rate).toBeCloseTo(0.65, 6);
  });

  it("无任何被复用技能时平均成功率为 0", async () => {
    const m = mkMetrics({ skills: [{ id: "s0", use_count: 0, success_count: 0 }] });
    const s = await m.overallSummary();
    expect(s.reused_skill_count).toBe(0);
    expect(s.total_reuse_count).toBe(0);
    expect(s.average_success_rate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Req 13.3 反哺前后对比
// ─────────────────────────────────────────────────────────────────

describe("beforeAfterComparison（Req 13.3 反哺前后成功率对比）", () => {
  it("前后均有数据：给出两侧成功率与 delta", async () => {
    const m = mkMetrics({
      candidates: [{ id: "c1", merged_into: "s1" }],
      invocations: [
        // 反哺前（贡献方候选自身使用）：2/4 = 0.5
        { candidate_id: "c1", outcome: "success" },
        { candidate_id: "c1", outcome: "success" },
        { candidate_id: "c1", outcome: "fail" },
        { candidate_id: "c1", outcome: "fail" },
        { candidate_id: "c1", outcome: "pending" }, // pending 不计入总数
        // 反哺后（公共继承方复用）：3/4 = 0.75
        { skill_id: "s1", outcome: "success" },
        { skill_id: "s1", outcome: "success" },
        { skill_id: "s1", outcome: "success" },
        { skill_id: "s1", outcome: "fail" },
      ],
    });
    const r = await m.beforeAfterComparison("s1");
    expect(r.before_total).toBe(4);
    expect(r.before_success_rate).toBeCloseTo(0.5, 6);
    expect(r.after_total).toBe(4);
    expect(r.after_success_rate).toBeCloseTo(0.75, 6);
    expect(r.available).toBe(true);
    expect(r.delta).toBeCloseTo(0.25, 6);
  });

  it("反哺前无数据：前侧成功率与 delta 明确 N/A（null）", async () => {
    const m = mkMetrics({
      candidates: [{ id: "c1", merged_into: "s1" }],
      invocations: [{ skill_id: "s1", outcome: "success" }],
    });
    const r = await m.beforeAfterComparison("s1");
    expect(r.before_total).toBe(0);
    expect(r.before_success_rate).toBeNull();
    expect(r.after_success_rate).toBeCloseTo(1, 6);
    expect(r.available).toBe(false);
    expect(r.delta).toBeNull();
  });

  it("两侧均无数据：均为 N/A", async () => {
    const m = mkMetrics({ invocations: [] });
    const r = await m.beforeAfterComparison("s1");
    expect(r.before_success_rate).toBeNull();
    expect(r.after_success_rate).toBeNull();
    expect(r.delta).toBeNull();
    expect(r.available).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Req 13.4 继承未使用比例
// ─────────────────────────────────────────────────────────────────

describe("silentInheritanceRatio（Req 13.4 继承未使用比例）", () => {
  it("超 T_silent 且未使用 / 已过观察窗 的比例", async () => {
    const old = new Date(NOW - 10 * DAY_MS).toISOString(); // 已过 T_silent(7 天)
    const recent = new Date(NOW - 1 * DAY_MS).toISOString(); // 未过观察窗
    const m = mkMetrics({
      inheritances: [
        { user_id: "u1", skill_id: "s1", acquired_at: old, last_used_at: null }, // 静默
        { user_id: "u2", skill_id: "s1", acquired_at: old, last_used_at: null }, // 静默
        {
          user_id: "u3",
          skill_id: "s2",
          acquired_at: old,
          last_used_at: new Date(NOW).toISOString(),
        }, // 已用，eligible 但非静默
        { user_id: "u4", skill_id: "s3", acquired_at: recent, last_used_at: null }, // 未过观察窗，不计 eligible
      ],
    });
    const r = await m.silentInheritanceRatio(NOW);
    expect(r.eligible_count).toBe(3); // 三条已过 T_silent
    expect(r.silent_count).toBe(2); // 其中两条从未使用
    expect(r.ratio).toBeCloseTo(2 / 3, 6);
  });

  it("无已过观察窗的继承时比例为 0", async () => {
    const recent = new Date(NOW - 1 * DAY_MS).toISOString();
    const m = mkMetrics({
      inheritances: [{ user_id: "u1", skill_id: "s1", acquired_at: recent, last_used_at: null }],
    });
    const r = await m.silentInheritanceRatio(NOW);
    expect(r.eligible_count).toBe(0);
    expect(r.silent_count).toBe(0);
    expect(r.ratio).toBe(0);
  });
});
