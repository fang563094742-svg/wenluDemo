// Feature: proactive-awareness-demo, Property 22: 可插拔注册表注册-解析往返
//
// *For any* 注册表（ScannerRegistry / ProviderRegistry / ToolRegistry）、任意 key 与
// 任意符合对应接口的实现实例，`register(key, impl)` 后 `resolve(key)` 返回同一实例，
// 且调用方接口契约不变（新增实现不破坏既有解析）。
//
// Validates: Requirements 17.3

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { DefaultRegistry } from "../../src/registry/registry.js";

/** 被注册实现的占位类型——任意对象都可作为"符合对应接口的实现实例"。 */
interface FakeImpl {
  tag: string;
  value: number;
}

/**
 * 生成一个全新的实现实例（每次生成都是独立引用），
 * 以便用 `toBe`（引用相等）验证 resolve 返回的是"同一实例"。
 */
const implArb: fc.Arbitrary<FakeImpl> = fc.record({
  tag: fc.string(),
  value: fc.integer(),
});

describe("Property 22: 可插拔注册表注册-解析往返", () => {
  it("register(key, impl) 后 resolve(key) 返回同一实例，且新增实现不破坏既有解析", () => {
    // 子属性 1：单个 (key, impl) 的注册-解析往返保持引用同一性，has 同步为真。
    fc.assert(
      fc.property(
        fc.string(), // 任意注册表标识（三大注册表共享同一实现）
        fc.string(), // 任意 key
        implArb, // 任意符合接口的实现实例
        (label, key, impl) => {
          const registry = new DefaultRegistry<FakeImpl>(label);

          expect(registry.has(key)).toBe(false);
          registry.register(key, impl);

          expect(registry.has(key)).toBe(true);
          // 往返：解析回来的必须是注册进去的同一实例（引用相等）。
          expect(registry.resolve(key)).toBe(impl);
        },
      ),
      { numRuns: 100 },
    );

    // 子属性 2：调用方接口契约不变——向同一注册表注册多个不同实现后，
    // 每个 key 仍解析回各自当初注册的同一实例（新增实现不破坏既有解析）。
    fc.assert(
      fc.property(
        fc.string(),
        // 以 key 去重，保证每个 key 唯一映射到一个实现实例。
        fc.uniqueArray(fc.tuple(fc.string(), implArb), {
          selector: ([key]) => key,
        }),
        (label, pairs) => {
          const registry = new DefaultRegistry<FakeImpl>(label);

          for (const [key, impl] of pairs) {
            registry.register(key, impl);
          }

          // 全部注册完成后，逐个 key 解析仍返回各自注册的同一实例。
          for (const [key, impl] of pairs) {
            expect(registry.has(key)).toBe(true);
            expect(registry.resolve(key)).toBe(impl);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
