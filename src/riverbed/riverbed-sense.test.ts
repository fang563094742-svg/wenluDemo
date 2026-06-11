import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mapToRiverbedDomain, senseRiverbedFromMind } from "./riverbed-sense.js";
import { RIVERBED_DOMAIN_IDS } from "./riverbed-domain.js";
import type {
  MindLike,
  MindBeliefLike,
  MindUserInsightLike,
} from "./riverbed-util.js";

const DOMAIN_ID_SET = new Set<string>(RIVERBED_DOMAIN_IDS as readonly string[]);

describe("mapToRiverbedDomain — Property 6: 映射全域闭合", () => {
  // **Validates: Requirements 10.1, 10.3**
  it("任意 belief.dimension / userModel.aspect（含未知值）返回值 ∈ RIVERBED_DOMAIN_IDS 且确定性", () => {
    const sourceArb = fc.oneof(
      fc.record({ kind: fc.constant("belief" as const), dimension: fc.string() }),
      fc.record({ kind: fc.constant("userModel" as const), aspect: fc.string() }),
    );
    fc.assert(
      fc.property(sourceArb, (source) => {
        const result = mapToRiverbedDomain(source);
        // 全域闭合：返回值必为 14 域之一
        expect(DOMAIN_ID_SET.has(result)).toBe(true);
        // 确定性：同输入两次结果相同
        expect(mapToRiverbedDomain(source)).toBe(result);
      }),
    );
  });
});

describe("senseRiverbedFromMind — 兜底汇聚单元测试", () => {
  // _Requirements: 10.4_
  function emptyMind(overrides: Partial<MindLike> = {}): MindLike {
    return {
      beliefs: [],
      userModel: [],
      conversation: [],
      cycles: 0,
      metrics: {},
      ...overrides,
    };
  }

  function belief(overrides: Partial<MindBeliefLike> = {}): MindBeliefLike {
    return {
      id: "belief-1",
      dimension: "direction",
      content: "用户想转向独立开发",
      confidence: 0.7,
      ...overrides,
    };
  }

  function insight(overrides: Partial<MindUserInsightLike> = {}): MindUserInsightLike {
    return {
      id: "um-1",
      aspect: "goal",
      content: "目标是上线产品",
      confidence: 0.8,
      ...overrides,
    };
  }

  it("空 mind（beliefs/userModel 空）返回空数组", () => {
    expect(senseRiverbedFromMind(emptyMind(), 0)).toEqual([]);
  });

  it("含若干 belief/userModel 产出对应数量判断包，evidenceRefs 反向引用源 id", () => {
    const mind = emptyMind({
      beliefs: [
        belief({ id: "b1", dimension: "direction" }),
        belief({ id: "b2", dimension: "value" }),
      ],
      userModel: [insight({ id: "u1", aspect: "goal" })],
    });

    const packets = senseRiverbedFromMind(mind, 3);
    expect(packets).toHaveLength(3);

    // 先 belief 后 userModel，保留原始顺序
    expect(packets[0].targetObjectType).toBe("belief");
    expect(packets[0].targetObjectId).toBe("b1");
    expect(packets[0].evidenceRefs).toEqual([
      { kind: "belief", refId: "b1", refRole: "supporting" },
    ]);

    expect(packets[1].targetObjectId).toBe("b2");
    expect(packets[1].evidenceRefs[0].refId).toBe("b2");

    expect(packets[2].targetObjectType).toBe("userModel");
    expect(packets[2].targetObjectId).toBe("u1");
    expect(packets[2].evidenceRefs).toEqual([
      { kind: "userModel", refId: "u1", refRole: "supporting" },
    ]);
  });

  it("确定性：同 mind + 同 cycle 调两次，产出 packetId 完全相同", () => {
    const mind = emptyMind({
      beliefs: [belief({ id: "b1" }), belief({ id: "b2", dimension: "state" })],
      userModel: [insight({ id: "u1" }), insight({ id: "u2", aspect: "boundary" })],
    });

    const first = senseRiverbedFromMind(mind, 8);
    const second = senseRiverbedFromMind(mind, 8);

    expect(first.map((p) => p.packetId)).toEqual(second.map((p) => p.packetId));
  });

  it("不同 cycle 推导出的判断包 packetId 不同（cycle 稳定参与哈希）", () => {
    const mind = emptyMind({ beliefs: [belief({ id: "b1" })] });
    const c8 = senseRiverbedFromMind(mind, 8);
    const c16 = senseRiverbedFromMind(mind, 16);
    expect(c8[0].packetId).not.toBe(c16[0].packetId);
  });

  it("纯函数：不修改入参 mind，且仅消费 mind（无 LLM 依赖入参）", () => {
    const mind = emptyMind({ beliefs: [belief({ id: "b1" })] });
    const beliefsRef = mind.beliefs;
    senseRiverbedFromMind(mind, 1);
    // 入参未被改动
    expect(mind.beliefs).toBe(beliefsRef);
    expect(mind.beliefs).toHaveLength(1);
    // senseRiverbedFromMind 仅接受 (mind, cycle) —— 无任何 LLM 客户端入参
    expect(senseRiverbedFromMind.length).toBe(2);
  });
});
