/**
 * 时空校准层 · 回光降权属性测试（chronotopic-decay-reflux.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 14.2（Property 17：回光降权只减不增且确定）。被测：
 * `decayChronotopic(state, nowMs, config)`（chronotopic-decay.ts）。
 *
 * 任意 ChronotopicState 用真实 API 构造：`emptyChronotopicState` + 多次
 * `upsertSignature`，签名由 `buildChronotopicSignature` 造，createdAt 由不同
 * nowMs 决定新旧。验证：
 *   1) 只减不增：调用后长度 ≤ 调用前；
 *   2) 保留集合 ⊆ 原集合（不新增、不改写）；
 *   3) 确定性：同 (state, nowMs, config) 两次独立构造结果一致；
 *   4) 返回裁剪数 === 调用前长度 − 调用后长度。
 *
 * 绝对边界：仅 import vitest / fast-check 与同目录 ./chronotopic-*.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decayChronotopic,
  FRESHNESS_FLOOR,
  type DecayConfig,
} from "./chronotopic-decay.js";
import {
  emptyChronotopicState,
  upsertSignature,
  type ChronotopicState,
} from "./chronotopic-store.js";
import {
  buildChronotopicSignature,
  type ChronotopicSignature,
  type ChronotopicTargetRef,
} from "./chronotopic-signature.js";

/** 基准参考时刻：2024-01-01T00:00:00Z。 */
const BASE_NOW_MS = Date.parse("2024-01-01T00:00:00Z");

/** 任意目标引用（who/what）：kind 取自合法枚举，id 非空白。 */
const targetRefArb: fc.Arbitrary<ChronotopicTargetRef> = fc.record({
  kind: fc.constantFrom<ChronotopicTargetRef["kind"]>(
    "riverbed-node",
    "episode",
    "concept",
    "belief",
    "event",
  ),
  id: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `t${s.replace(/\s/g, "_")}`),
});

/**
 * 单条签名的「构造蓝图」：用 createdOffsetMs 决定该签名相对参考时刻有多旧。
 * offset 跨越「很新」到「远超 4×halfLife（被裁）」的范围，覆盖保留 / 裁剪两侧。
 */
interface SignatureBlueprint {
  targetRef: ChronotopicTargetRef;
  /** 签名 createdAt 相对参考时刻往前推的毫秒数（≥ 0：越大越旧）。 */
  createdOffsetMs: number;
}

/** 一年的毫秒数，作为 offset 上界（足以让旧签名跨过 4×halfLife 阈值）。 */
const ONE_YEAR_MS = 365 * 86_400_000;

const blueprintArb: fc.Arbitrary<SignatureBlueprint> = fc.record({
  targetRef: targetRefArb,
  createdOffsetMs: fc.double({ min: 0, max: ONE_YEAR_MS, noNaN: true }),
});

/** 任意衰减配置：halfLifeMs > 0（覆盖 1 小时到 60 天）。 */
const configArb: fc.Arbitrary<DecayConfig> = fc
  .double({ min: 3_600_000, max: 60 * 86_400_000, noNaN: true })
  .map((halfLifeMs) => ({ halfLifeMs }));

/** 参考时刻：在基准附近浮动若干天，保证 createdAt = nowMs - offset 仍是合法时间。 */
const nowMsArb: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 30 * 86_400_000 })
  .map((delta) => BASE_NOW_MS + ONE_YEAR_MS + delta);

/**
 * 由一组蓝图 + 参考时刻确定性地构造一个 ChronotopicState。
 * 每条签名用 buildChronotopicSignature（其 createdAt 由 interaction.nowMs 决定），
 * 再经 upsertSignature 幂等写入空容器——与生产路径完全一致。
 */
function buildState(blueprints: SignatureBlueprint[], nowMs: number): ChronotopicState {
  const state = emptyChronotopicState();
  for (const bp of blueprints) {
    const createdNowMs = nowMs - bp.createdOffsetMs;
    const signature = buildChronotopicSignature(
      bp.targetRef,
      { frontWindow: null, calendarEvents: [], clipboard: null },
      { nowMs: createdNowMs, userLastActiveAtMs: createdNowMs },
      480, // 东八区
    );
    upsertSignature(state, signature);
  }
  return state;
}

/** 取一个 state 当前的 signatureId 集合（用于子集 / 一致性比对）。 */
function idSet(state: ChronotopicState): Set<string> {
  return new Set(state.signatures.map((s) => s.signatureId));
}

const blueprintsArb = fc.array(blueprintArb, { maxLength: 40 });

describe("decayChronotopic（Property 17：回光降权只减不增且确定）", () => {
  // **Validates: Requirements 11.1, 11.2**
  it("调用后 signatures 长度 ≤ 调用前（只减不增），且保留集合 ⊆ 原集合", () => {
    fc.assert(
      fc.property(blueprintsArb, nowMsArb, configArb, (blueprints, nowMs, config) => {
        const state = buildState(blueprints, nowMs);
        const beforeIds = idSet(state);
        const beforeLen = state.signatures.length;

        decayChronotopic(state, nowMs, config);

        // 1) 只减不增。
        expect(state.signatures.length).toBeLessThanOrEqual(beforeLen);
        // 2) 保留集合 ⊆ 原集合：每个保留 id 都在原集合里（不新增、不改写）。
        for (const sig of state.signatures) {
          expect(beforeIds.has(sig.signatureId)).toBe(true);
        }
      }),
    );
  });

  // **Validates: Requirements 11.1**
  it("返回的裁剪数 === 调用前长度 − 调用后长度", () => {
    fc.assert(
      fc.property(blueprintsArb, nowMsArb, configArb, (blueprints, nowMs, config) => {
        const state = buildState(blueprints, nowMs);
        const beforeLen = state.signatures.length;

        const pruned = decayChronotopic(state, nowMs, config);

        expect(pruned).toBe(beforeLen - state.signatures.length);
        expect(pruned).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  // **Validates: Requirements 11.2**
  it("保留的签名对象与原签名逐字段一致（不改写内容，只过滤）", () => {
    fc.assert(
      fc.property(blueprintsArb, nowMsArb, configArb, (blueprints, nowMs, config) => {
        const state = buildState(blueprints, nowMs);
        // 记录原签名按 signatureId 的快照（深拷贝避免被原地修改污染）。
        const originalById = new Map<string, ChronotopicSignature>();
        for (const s of state.signatures) {
          originalById.set(s.signatureId, JSON.parse(JSON.stringify(s)));
        }

        decayChronotopic(state, nowMs, config);

        for (const sig of state.signatures) {
          const original = originalById.get(sig.signatureId);
          expect(original).toBeDefined();
          expect(sig).toEqual(original);
        }
      }),
    );
  });

  // **Validates: Requirements 11.3**
  it("确定性：两个独立构造的相同 state 用相同 (nowMs,config) 调用，剩余 id 集合一致", () => {
    fc.assert(
      fc.property(blueprintsArb, nowMsArb, configArb, (blueprints, nowMs, config) => {
        const stateA = buildState(blueprints, nowMs);
        const stateB = buildState(blueprints, nowMs);

        const prunedA = decayChronotopic(stateA, nowMs, config);
        const prunedB = decayChronotopic(stateB, nowMs, config);

        expect(prunedA).toBe(prunedB);
        // 剩余 signatureId 集合一致（确定性）。
        const idsA = [...idSet(stateA)].sort();
        const idsB = [...idSet(stateB)].sort();
        expect(idsA).toEqual(idsB);
      }),
    );
  });

  // **Validates: Requirements 11.3**
  it("确定性：同一蓝图深拷贝两份分别调用结果一致", () => {
    fc.assert(
      fc.property(blueprintsArb, nowMsArb, configArb, (blueprints, nowMs, config) => {
        const source = buildState(blueprints, nowMs);
        // 深拷贝两份独立 state，分别裁剪。
        const clone1: ChronotopicState = JSON.parse(JSON.stringify(source));
        const clone2: ChronotopicState = JSON.parse(JSON.stringify(source));

        const p1 = decayChronotopic(clone1, nowMs, config);
        const p2 = decayChronotopic(clone2, nowMs, config);

        expect(p1).toBe(p2);
        expect([...idSet(clone1)].sort()).toEqual([...idSet(clone2)].sort());
      }),
    );
  });
});

describe("decayChronotopic（单元：新鲜度阈值边界）", () => {
  const config: DecayConfig = { halfLifeMs: 30 * 86_400_000 }; // 30 天半衰期
  const nowMs = BASE_NOW_MS + ONE_YEAR_MS;

  it("远旧签名（age > 4×halfLife）被裁剪", () => {
    const state = emptyChronotopicState();
    // age = 5×halfLife = 150 天 ⇒ 新鲜权重 = 2^-5 ≈ 0.03125 < FRESHNESS_FLOOR(0.0625)。
    const oldNowMs = nowMs - 5 * config.halfLifeMs;
    const oldSig = buildChronotopicSignature(
      { kind: "concept", id: "very-old" },
      { frontWindow: null, calendarEvents: [], clipboard: null },
      { nowMs: oldNowMs, userLastActiveAtMs: oldNowMs },
      480,
    );
    upsertSignature(state, oldSig);

    const pruned = decayChronotopic(state, nowMs, config);

    expect(pruned).toBe(1);
    expect(state.signatures.length).toBe(0);
  });

  it("很新签名（age ≈ 0）被保留", () => {
    const state = emptyChronotopicState();
    // createdAt = nowMs ⇒ age = 0 ⇒ 新鲜权重 = 1 ≥ FRESHNESS_FLOOR。
    const freshSig = buildChronotopicSignature(
      { kind: "concept", id: "fresh" },
      { frontWindow: null, calendarEvents: [], clipboard: null },
      { nowMs, userLastActiveAtMs: nowMs },
      480,
    );
    upsertSignature(state, freshSig);

    const pruned = decayChronotopic(state, nowMs, config);

    expect(pruned).toBe(0);
    expect(state.signatures.length).toBe(1);
    expect(state.signatures[0].signatureId).toBe(freshSig.signatureId);
  });

  it("边界：age 恰为 4×halfLife（权重 == FRESHNESS_FLOOR）被保留", () => {
    const state = emptyChronotopicState();
    // age = 4×halfLife ⇒ 权重 = 2^-4 = 0.0625 == FRESHNESS_FLOOR（闭区间下界，保留）。
    const boundaryNowMs = nowMs - 4 * config.halfLifeMs;
    const boundarySig = buildChronotopicSignature(
      { kind: "event", id: "boundary" },
      { frontWindow: null, calendarEvents: [], clipboard: null },
      { nowMs: boundaryNowMs, userLastActiveAtMs: boundaryNowMs },
      480,
    );
    upsertSignature(state, boundarySig);

    const pruned = decayChronotopic(state, nowMs, config);

    expect(FRESHNESS_FLOOR).toBe(0.0625);
    expect(pruned).toBe(0);
    expect(state.signatures.length).toBe(1);
  });
});
