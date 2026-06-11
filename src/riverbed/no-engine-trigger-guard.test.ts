import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  evaluateNoEngineTriggerGuard,
  assertNoEngineTrigger,
} from "./no-engine-trigger-guard.js";

// ============================================================================
// 任务 4.2 — 属性测试
// Property 1（守卫侧）: 守卫不变量（不触发引擎）
// Validates: Requirements 3.1, 3.5
// ----------------------------------------------------------------------------
// fast-check 生成任意嵌套对象 / 数组，随机往某个节点注入或不注入引擎触发字段
// （enginePacket / selectedEngine / executionAllowed:true）：
//   - 注入时：evaluateNoEngineTriggerGuard(v).allowed === false
//   - 未注入时：allowed === true
// 同时验证 assertNoEngineTrigger 在 blocked 时 throw、allowed 时不 throw。
// 并覆盖循环引用对象不导致无限递归（不死循环）。
// ============================================================================

const ENGINE_TRIGGER_KEYS = ["enginePacket", "selectedEngine"] as const;

/**
 * 生成"安全"叶子值：绝不携带任何引擎触发语义。
 * 注意排除 executionAllowed===true 不是问题——这是任意基本值，不是对象 key。
 */
const safeLeaf = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constantFrom("enginePacket", "selectedEngine", "executionAllowed"), // 作为值而非 key，不应触发
);

/**
 * 生成"安全"的任意嵌套对象 / 数组：
 * 用受限 key（排除三个触发 key）构造 record，避免误注入。
 */
const safeKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter(
    (k) =>
      k !== "enginePacket" &&
      k !== "selectedEngine" &&
      k !== "executionAllowed",
  );

const safeNested = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    safeLeaf,
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(safeKey, tie("node"), { maxKeys: 4 }),
  ),
})).node;

/** 把一个引擎触发字段注入到给定对象的顶层。 */
function inject(
  base: Record<string, unknown>,
  trigger: { key: string; value: unknown },
): Record<string, unknown> {
  return { ...base, [trigger.key]: trigger.value };
}

describe("Property 1（守卫侧）: 守卫不变量 (Validates: Requirements 3.1, 3.5)", () => {
  it("未注入任何引擎触发字段时 allowed === true", () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKey, safeNested, { maxKeys: 5 }),
        (obj) => {
          const result = evaluateNoEngineTriggerGuard(obj);
          return result.allowed === true && result.blocked === false;
        },
      ),
    );
  });

  it("注入 enginePacket / selectedEngine（非空）或 executionAllowed:true 时 allowed === false", () => {
    const triggerArb = fc.oneof(
      fc.record({
        key: fc.constantFrom(...ENGINE_TRIGGER_KEYS),
        // 非 null/undefined 才算"存在"
        value: fc.oneof(
          fc.string({ minLength: 1 }),
          fc.integer(),
          fc.record({ any: fc.string() }),
          fc.constant(true),
        ),
      }),
      fc.record({
        key: fc.constant("executionAllowed"),
        value: fc.constant(true),
      }),
    );

    fc.assert(
      fc.property(
        fc.dictionary(safeKey, safeNested, { maxKeys: 5 }),
        triggerArb,
        (base, trigger) => {
          const injected = inject(base, trigger);
          const result = evaluateNoEngineTriggerGuard(injected);
          return result.allowed === false && result.blocked === true;
        },
      ),
    );
  });

  it("把触发字段注入到深层嵌套对象同样被检出 (allowed === false)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKey, safeNested, { maxKeys: 3 }),
        fc.constantFrom(...ENGINE_TRIGGER_KEYS),
        (base, key) => {
          const nested = { level1: { level2: { [key]: { real: 1 } } }, ...base };
          const result = evaluateNoEngineTriggerGuard(nested);
          return result.allowed === false;
        },
      ),
    );
  });
});

describe("assertNoEngineTrigger throw 行为 (Validates: Requirements 3.1, 3.5)", () => {
  it("blocked 时抛出 DOMAIN_ENGINE_TRIGGER_BLOCKED", () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKey, safeNested, { maxKeys: 3 }),
        fc.constantFrom(...ENGINE_TRIGGER_KEYS),
        (base, key) => {
          const injected = inject(base, { key, value: { real: 1 } });
          try {
            assertNoEngineTrigger(injected);
            return false; // 应该已经抛错
          } catch (err) {
            return (
              err instanceof Error &&
              err.message.includes("DOMAIN_ENGINE_TRIGGER_BLOCKED")
            );
          }
        },
      ),
    );
  });

  it("allowed 时不抛错并返回 allowed:true", () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKey, safeNested, { maxKeys: 3 }),
        (obj) => {
          const result = assertNoEngineTrigger(obj);
          return result.allowed === true && result.blocked === false;
        },
      ),
    );
  });
});

describe("循环引用不导致无限递归 (Validates: Requirements 3.1)", () => {
  it("循环引用且无触发字段：终止且 allowed === true", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", parent: a };
    a.child = b;
    a.self = a; // 直接自环

    const result = evaluateNoEngineTriggerGuard(a);
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("循环引用且深处带触发字段：终止且 allowed === false", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", parent: a, enginePacket: { x: 1 } };
    a.child = b;
    b.back = a; // 形成环

    const result = evaluateNoEngineTriggerGuard(a);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("enginePacket_blocked");
  });

  it("数组内的循环引用同样安全终止", () => {
    const arr: unknown[] = [];
    arr.push(arr); // 数组自引用
    const result = evaluateNoEngineTriggerGuard(arr);
    expect(result.allowed).toBe(true);
  });
});
