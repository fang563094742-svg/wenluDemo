import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  RIVERBED_DOMAIN_IDS,
  RIVERBED_DOMAIN_REGISTRY,
  isRiverbedDomainId,
  getRiverbedDomainEntry,
  assertRiverbedDomainRegistryIntegrity,
} from "./riverbed-domain.js";

// ============================================================================
// 任务 2.2 — 属性测试
// Property 5: 域完整性
// Validates: Requirements 1.3
// ----------------------------------------------------------------------------
// assertRiverbedDomainRegistryIntegrity() 恒为 true（恰 14 域、id 唯一、
// index 0..13 连续）。注册表是常量，但用 fast-check 多次重复运行以确认其在
// 任意调用次序/重复调用下都是稳定纯函数（无副作用、恒等）。
// ============================================================================
describe("Property 5: 域完整性 (Validates: Requirements 1.3)", () => {
  it("多次断言 assertRiverbedDomainRegistryIntegrity() 恒为 true", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), () => {
        // 任意次重复调用都必须恒为 true，且不抛错
        return assertRiverbedDomainRegistryIntegrity() === true;
      }),
    );
  });

  it("属性侧再确认：恰 14 域、id 唯一、index 0..13 连续", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const registry = RIVERBED_DOMAIN_REGISTRY;
        if (registry.length !== 14) return false;

        const ids = registry.map((e) => e.id);
        if (new Set(ids).size !== ids.length) return false;

        const sortedIndices = registry
          .map((e) => e.index)
          .sort((a, b) => a - b);
        return sortedIndices.every((idx, i) => idx === i);
      }),
    );
  });
});

// ============================================================================
// 任务 2.3 — 单元测试
// _Requirements: 1.1, 1.2, 1.4_
// ============================================================================
describe("isRiverbedDomainId (Requirements 1.4)", () => {
  it("对全部 14 个合法 id 返回 true", () => {
    for (const id of RIVERBED_DOMAIN_IDS) {
      expect(isRiverbedDomainId(id)).toBe(true);
    }
  });

  it("对边界合法 id（D0_ASPIRATION / D13_VALUE）返回 true", () => {
    expect(isRiverbedDomainId("D0_ASPIRATION")).toBe(true);
    expect(isRiverbedDomainId("D13_VALUE")).toBe(true);
  });

  it("对非法字符串返回 false", () => {
    expect(isRiverbedDomainId("X")).toBe(false);
    expect(isRiverbedDomainId("")).toBe(false);
    expect(isRiverbedDomainId("d0")).toBe(false); // 大小写敏感
    expect(isRiverbedDomainId("D14_UNKNOWN")).toBe(false);
    expect(isRiverbedDomainId("D0")).toBe(false);
    expect(isRiverbedDomainId("ASPIRATION")).toBe(false);
  });
});

describe("getRiverbedDomainEntry (Requirements 1.1, 1.2)", () => {
  it("对未知 id 返回 null", () => {
    // 用类型断言绕过编译期约束，模拟运行期传入越界 / 未知 id
    expect(getRiverbedDomainEntry("X" as never)).toBeNull();
    expect(getRiverbedDomainEntry("" as never)).toBeNull();
    expect(getRiverbedDomainEntry("D99_UNKNOWN" as never)).toBeNull();
  });

  it("对合法 id 返回正确 entry（中文 label、canTriggerEngine===false）", () => {
    const aspiration = getRiverbedDomainEntry("D0_ASPIRATION");
    expect(aspiration).not.toBeNull();
    expect(aspiration?.id).toBe("D0_ASPIRATION");
    expect(aspiration?.index).toBe(0);
    expect(aspiration?.label).toBe("志向");
    expect(aspiration?.canTriggerEngine).toBe(false);

    const value = getRiverbedDomainEntry("D13_VALUE");
    expect(value).not.toBeNull();
    expect(value?.id).toBe("D13_VALUE");
    expect(value?.index).toBe(13);
    expect(value?.label).toBe("价值");
    expect(value?.canTriggerEngine).toBe(false);
  });

  it("每个合法 id 的 entry label 均为非空中文且 canTriggerEngine 恒为 false", () => {
    for (const id of RIVERBED_DOMAIN_IDS) {
      const entry = getRiverbedDomainEntry(id);
      expect(entry).not.toBeNull();
      expect(entry?.id).toBe(id);
      expect(typeof entry?.label).toBe("string");
      expect((entry?.label.length ?? 0) > 0).toBe(true);
      expect(entry?.canTriggerEngine).toBe(false);
    }
  });
});
