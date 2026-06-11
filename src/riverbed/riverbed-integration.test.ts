/**
 * 河床系统（Riverbed System）· 全链路集成测试（Task 17.1）
 * ------------------------------------------------------------------
 * 目标：在不 import `riverMain.ts`（其入口运行会启动服务 / 读写 ~/.wenlu/mind.json，
 * 有副作用）的前提下，用河床自己的模块复刻 riverMain 的接线语义，验证一条
 * `add → 存 → 存盘往返 → 读 → 渲染` 的完整数据链路：
 *
 *   buildDomainJudgementPacket（模拟 add_riverbed_judgement 工具入参归一化）
 *     → upsertRiverbedNode（沉淀进 mind.riverbed，复刻 executeTool 的 upsert）
 *     → JSON.parse(JSON.stringify(mind))（模拟 saveMind 写盘 + loadMind 读回，
 *       弟弟 mind 是 JSON 文件，往返必须结构无损）
 *     → getActiveRiverbedNodes（复刻 buildConsciousness 的读路径）
 *     → aggregateDomainJudgementPackets（复刻聚合态势）
 *     → renderRiverbedBlock（复刻注入 system prompt 的渲染块）
 *
 * 断言：节点正确沉淀、JSON 往返后结构不变、最终渲染文本含 add 时的 domain 标签。
 * 另验证旧 mind（无 riverbed 字段）经补默认值迁移后不报错且其余字段不变。
 *
 * 绝对边界：只 import vitest 与 ./riverbed 下模块；不 import riverMain.ts；
 * 不 import 3.1/3.2、不 node:sqlite。
 *
 * _Requirements: 4.1, 4.2, 9.1, 13.1, 13.2, 13.3_
 */

import { describe, it, expect } from "vitest";
import {
  buildDomainJudgementPacket,
  type BuildPacketInput,
} from "./domain-judgement-packet.js";
import {
  emptyRiverbedState,
  upsertRiverbedNode,
  getActiveRiverbedNodes,
  type RiverbedState,
} from "./riverbed-store.js";
import { aggregateDomainJudgementPackets } from "./domain-aggregation.js";
import { renderRiverbedBlock } from "./riverbed-render.js";
import { getRiverbedDomainEntry } from "./riverbed-domain.js";

/**
 * 最小 mind 对象（mind-like）：只保留与河床链路相关的字段 + 几个既有字段，
 * 用来模拟弟弟 mind.json 的结构子集。riverbed 挂在 mind 上（接线点 1 的语义）。
 */
interface MinimalMind {
  cycles: number;
  beliefs: string[];
  userModel: { aspect: string };
  riverbed: RiverbedState;
}

/** 构造一个最小 mind 对象，riverbed 初值为空河床。 */
function makeMinimalMind(): MinimalMind {
  return {
    cycles: 7,
    beliefs: ["用户在意长期方向"],
    userModel: { aspect: "decision" },
    riverbed: emptyRiverbedState(),
  };
}

/** add_riverbed_judgement 的合法工具入参（D2_GOAL，warn/high）。 */
const ADD_INPUT: BuildPacketInput = {
  domain: "D2_GOAL",
  targetObjectType: "belief",
  targetObjectId: "goal-2026",
  targetSummary: "用户的年度目标尚未拆解到可执行粒度",
  judgementType: "risk",
  score: 0.72,
  confidence: 0.81,
  severity: "high",
  verdict: "warn",
  reason: "目标过于宏大且缺乏阶段里程碑，存在落空风险",
  freshness: "fresh",
  constraintLevel: "STRONG_DEFAULT",
  suggestedNextStep: "把年度目标拆成季度里程碑",
  suggestedCutList: ["先别同时追三个方向"],
  recoveryRequired: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("河床全链路集成（Task 17.1） — add → 存 → 存盘往返 → 读 → 渲染", () => {
  it("一条判断包经全链路后正确沉淀，且最终渲染块含其 domain 标签", () => {
    const mind = makeMinimalMind();

    // ── add：模拟 add_riverbed_judgement 工具的入参归一化 + 沉淀 ──
    const packet = buildDomainJudgementPacket(ADD_INPUT);
    const { created } = upsertRiverbedNode(mind.riverbed, packet, mind.cycles);

    expect(created).toBe(true);
    expect(mind.riverbed.nodes).toHaveLength(1);
    expect(mind.riverbed.nodes[0].nodeId).toBe(packet.packetId);
    expect(mind.riverbed.nodes[0].packet.domain).toBe("D2_GOAL");

    // ── 存盘往返：模拟 saveMind 写 JSON + loadMind 读回 ──
    const reloaded: MinimalMind = JSON.parse(JSON.stringify(mind));

    // 既有字段往返后不变。
    expect(reloaded.cycles).toBe(mind.cycles);
    expect(reloaded.beliefs).toEqual(mind.beliefs);
    expect(reloaded.userModel).toEqual(mind.userModel);
    // 河床节点经 JSON 往返后结构无损（深等）。
    expect(reloaded.riverbed).toEqual(mind.riverbed);
    expect(reloaded.riverbed.version).toBe(1);
    expect(reloaded.riverbed.nodes[0].nodeId).toBe(packet.packetId);

    // ── 读路径：getActiveRiverbedNodes → aggregate → render ──
    const activeNodes = getActiveRiverbedNodes(reloaded.riverbed, new Date(), 15);
    expect(activeNodes).toHaveLength(1);
    expect(activeNodes[0].packet.domain).toBe("D2_GOAL");

    const agg = aggregateDomainJudgementPackets(activeNodes.map((n) => n.packet));
    expect(agg.packetCount).toBe(1);
    expect(agg.domains).toContain("D2_GOAL");
    expect(agg.highestSeverity).toBe("high");

    const block = renderRiverbedBlock(activeNodes, agg);

    // ── 整链路断言：add 的 domain 标签出现在最终渲染文本里 ──
    const label = getRiverbedDomainEntry("D2_GOAL")?.label;
    expect(label).toBeTruthy();
    expect(block).toContain("D2_GOAL");
    expect(block).toContain(label as string);
    // 渲染块体现 verdict / severity（链路把 add 的态度透传到意识）。
    expect(block).toContain("warn");
    expect(block).toContain("high");
    // 渲染块绝不含引擎触发字段名（判断不驱动执行）。
    expect(block).not.toContain("enginePacket");
    expect(block).not.toContain("executionAllowed");
  });

  it("多条判断包跨域沉淀后，渲染块覆盖每个 add 过的 domain", () => {
    const mind = makeMinimalMind();

    const inputs: BuildPacketInput[] = [
      { ...ADD_INPUT, domain: "D8_EMOTION", targetObjectId: "mood-1", verdict: "observe", severity: "medium", reason: "情绪低落但可控" },
      { ...ADD_INPUT, domain: "D5_EXECUTION", targetObjectId: "exec-1", verdict: "block", severity: "critical", reason: "执行层存在硬约束" },
    ];

    for (const input of inputs) {
      const packet = buildDomainJudgementPacket(input);
      upsertRiverbedNode(mind.riverbed, packet, mind.cycles);
    }
    expect(mind.riverbed.nodes).toHaveLength(2);

    const reloaded: MinimalMind = JSON.parse(JSON.stringify(mind));
    const activeNodes = getActiveRiverbedNodes(reloaded.riverbed, new Date(), 15);
    const agg = aggregateDomainJudgementPackets(activeNodes.map((n) => n.packet));
    const block = renderRiverbedBlock(activeNodes, agg);

    expect(block).toContain("D8_EMOTION");
    expect(block).toContain("D5_EXECUTION");
    // critical/block 域应出现在聚合的被阻断领域里。
    expect(agg.blockedDomains).toContain("D5_EXECUTION");
    expect(agg.highestSeverity).toBe("critical");
  });

  it("幂等：同语义判断重复 add 不增节点，只升级 hitCount", () => {
    const mind = makeMinimalMind();
    const packet = buildDomainJudgementPacket(ADD_INPUT);

    upsertRiverbedNode(mind.riverbed, packet, mind.cycles);
    upsertRiverbedNode(mind.riverbed, packet, mind.cycles + 1);
    upsertRiverbedNode(mind.riverbed, packet, mind.cycles + 2);

    expect(mind.riverbed.nodes).toHaveLength(1);
    expect(mind.riverbed.nodes[0].hitCount).toBe(3);

    // 往返后仍单节点。
    const reloaded: MinimalMind = JSON.parse(JSON.stringify(mind));
    expect(reloaded.riverbed.nodes).toHaveLength(1);
    expect(reloaded.riverbed.nodes[0].hitCount).toBe(3);
  });

  it("旧 mind（无 riverbed 字段）补默认值迁移后不报错且既有字段不变", () => {
    // 模拟 loadMind 读到的旧 mind.json（无 riverbed 字段）。
    const oldMind = {
      cycles: 3,
      beliefs: ["历史信念"],
      userModel: { aspect: "emotion" },
    };

    // 复刻 riverMain.loadMind 的补默认值语义：riverbed: loaded.riverbed ?? emptyRiverbedState()
    const migrated = {
      ...oldMind,
      riverbed: (oldMind as { riverbed?: RiverbedState }).riverbed ?? emptyRiverbedState(),
    };

    expect(migrated.riverbed).toEqual(emptyRiverbedState());
    expect(migrated.cycles).toBe(3);
    expect(migrated.beliefs).toEqual(["历史信念"]);
    expect(migrated.userModel).toEqual({ aspect: "emotion" });

    // 迁移后的旧 mind 同样能跑读路径而不崩溃（退化为空河床渲染占位串）。
    const activeNodes = getActiveRiverbedNodes(migrated.riverbed, new Date(), 15);
    expect(activeNodes).toHaveLength(0);
    const agg = aggregateDomainJudgementPackets(activeNodes.map((n) => n.packet));
    const block = renderRiverbedBlock(activeNodes, agg);
    expect(block).toBe("（河床尚在形成）");
  });
});
