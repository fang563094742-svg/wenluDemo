/**
 * 认知核三段脊柱 · 输出类型注册表测试（cognitive-registry.ts）
 * ------------------------------------------------------------------
 * 覆盖（任务 2.3 · Property 13 输出类型可解析）：
 *  - ∀ 默认注册的 5 种蓝本类型 t ⟹ registry.resolve(t) !== undefined。
 *  - register 新类型名后随后可被 resolve（挂插件扩展不动主链）。
 *  - knownTypes() 默认含 5 种蓝本类型
 *    (content/product/relationship_action/decision/asset)。
 *  **Validates: Requirements 6.1, 6.2, 6.3**
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ../cognitive-registry.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  createDefaultOutputTypeRegistry,
  type OutputTypeDescriptor,
} from "../cognitive-registry.js";

/** 5 种默认蓝本类型。 */
const BLUEPRINT_TYPES = [
  "content",
  "product",
  "relationship_action",
  "decision",
  "asset",
] as const;

/** 生成任意合法 OutputTypeDescriptor。 */
function arbDescriptor(): fc.Arbitrary<OutputTypeDescriptor> {
  return fc.record(
    {
      label: fc.string(),
      defaultAudience: fc.constantFrom(
        "user" as const,
        "task_log" as const,
        "internal" as const,
      ),
      description: fc.string(),
    },
    { requiredKeys: ["label"] },
  );
}

/**
 * 生成不与蓝本 5 种冲突的新类型名（非空、去重于蓝本）。
 */
function arbNewTypeName(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 40 })
    .filter(
      (s) => !(BLUEPRINT_TYPES as ReadonlyArray<string>).includes(s),
    );
}

describe("cognitive-registry · Property 13 输出类型可解析 (Req 6.1, 6.2)", () => {
  it("∀ 默认注册的 5 种蓝本类型 ⟹ resolve 非 undefined", () => {
    const registry = createDefaultOutputTypeRegistry();
    fc.assert(
      fc.property(fc.constantFrom(...BLUEPRINT_TYPES), (type) => {
        expect(registry.resolve(type)).not.toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("knownTypes() 默认含全部 5 种蓝本类型 (Req 6.2)", () => {
    const registry = createDefaultOutputTypeRegistry();
    const known = registry.knownTypes();
    for (const type of BLUEPRINT_TYPES) {
      expect(known).toContain(type);
    }
  });
});

describe("cognitive-registry · Property 13 register 后可解析 (Req 6.3)", () => {
  it("∀ 新类型名 + 描述符，register 后随后可被 resolve 且进入 knownTypes", () => {
    fc.assert(
      fc.property(arbNewTypeName(), arbDescriptor(), (type, descriptor) => {
        // 每次用全新 registry，避免跨样本状态污染
        const registry = createDefaultOutputTypeRegistry();
        expect(registry.resolve(type)).toBeUndefined();

        registry.register(type, descriptor);

        const resolved = registry.resolve(type);
        expect(resolved).not.toBeUndefined();
        expect(resolved).toEqual(descriptor);
        expect(registry.knownTypes()).toContain(type);

        // 注册新类型不破坏 5 种蓝本类型
        for (const bp of BLUEPRINT_TYPES) {
          expect(registry.resolve(bp)).not.toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("cognitive-registry · 单元示例", () => {
  it("未注册类型 resolve 返回 undefined", () => {
    const registry = createDefaultOutputTypeRegistry();
    expect(registry.resolve("__does_not_exist__")).toBeUndefined();
  });

  it("register 覆盖既有蓝本类型描述符", () => {
    const registry = createDefaultOutputTypeRegistry();
    const next: OutputTypeDescriptor = { label: "改写内容" };
    registry.register("content", next);
    expect(registry.resolve("content")).toEqual(next);
  });

  it("工厂 seed 可挂插件扩展新类型", () => {
    const registry = createDefaultOutputTypeRegistry({
      reminder: { label: "提醒", defaultAudience: "user" },
    });
    expect(registry.resolve("reminder")).not.toBeUndefined();
    expect(registry.knownTypes()).toContain("reminder");
    // 蓝本仍在
    expect(registry.knownTypes()).toContain("content");
  });

  it("两个 registry 实例互不共享可变状态", () => {
    const a = createDefaultOutputTypeRegistry();
    const b = createDefaultOutputTypeRegistry();
    a.register("only_in_a", { label: "A 私有" });
    expect(b.resolve("only_in_a")).toBeUndefined();
  });
});
