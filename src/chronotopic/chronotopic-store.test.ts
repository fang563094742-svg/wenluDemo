/**
 * 时空校准层 · 持久化层测试（chronotopic-store.test.ts）
 * ------------------------------------------------------------------
 * 覆盖：
 *   - 任务 4.2（Property 12：upsert 幂等去重，fast-check）
 *   - 任务 4.3（Property 13：getActiveSignatures 无副作用，fast-check）
 *   - 任务 4.4（Property 18：prune 后不超上限，fast-check）
 *   - 补充单元测试：emptyChronotopicState 初值、getSignatures 容错。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./*.js（store + signature），
 * 不 import 3.1/3.2、不 node:sqlite。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  emptyChronotopicState,
  getSignatures,
  upsertSignature,
  getActiveSignatures,
  pruneSignatures,
  type ChronotopicState,
} from "./chronotopic-store.js";
import {
  buildChronotopicSignature,
  type ChronotopicSignature,
  type ChronotopicTargetRef,
} from "./chronotopic-signature.js";

// ──────────────────────────────────────────────────────────────────
// 共享生成器：用 buildChronotopicSignature 构造真实合法签名。
// 同 (targetRef.kind, targetRef.id, 时间桶, scene) 必得相同 signatureId，
// 因此固定 nowMs / sensors / tz、仅变化 targetRef.id 即可得到「不同 id」的签名；
// 复用同一 id 即可得到「同 signatureId」的签名用于幂等测试。
// ──────────────────────────────────────────────────────────────────

const TARGET_KINDS = [
  "riverbed-node",
  "episode",
  "concept",
  "belief",
  "event",
] as const;

/** 固定时区偏移（东八区）。 */
const TZ = 480;

/**
 * 构造一枚确定性时空签名。
 *
 * 同样的 (kind, id, nowMs 所落时间桶, scene) 会产出相同 signatureId——
 * 这里 sensors 全空 → scene 恒为 "idle"，故 signatureId 仅由 (kind, id, 时间桶) 决定。
 */
function makeSignature(
  id: string,
  nowMs: number,
  kind: ChronotopicTargetRef["kind"] = "event",
): ChronotopicSignature {
  return buildChronotopicSignature(
    { kind, id },
    { frontWindow: null, calendarEvents: [], clipboard: null },
    { nowMs, userLastActiveAtMs: nowMs },
    TZ,
  );
}

/** 任意签名生成器：变化 id / kind / nowMs。 */
const signatureArb: fc.Arbitrary<ChronotopicSignature> = fc
  .record({
    id: fc.constantFrom("a", "b", "c", "node-1", "node-2", "evt-x"),
    kind: fc.constantFrom(...TARGET_KINDS),
    // 固定一周内的几个不同绝对时刻，落入不同时间桶
    nowMs: fc.integer({ min: 0, max: 7 * 86_400_000 }),
  })
  .map(({ id, kind, nowMs }) => makeSignature(id, nowMs, kind));

/** 任意 ChronotopicState 生成器。 */
const stateArb: fc.Arbitrary<ChronotopicState> = fc
  .array(signatureArb, { maxLength: 30 })
  .map((signatures) => {
    const state = emptyChronotopicState();
    // 经 upsert 写入以保证 signatureId 唯一（与运行期不变量一致）。
    for (const sig of signatures) upsertSignature(state, sig);
    return state;
  });

// ──────────────────────────────────────────────────────────────────
// 任务 4.2 — Property 12: upsert 幂等去重
// ──────────────────────────────────────────────────────────────────

describe("upsertSignature — Property 12: upsert 幂等去重", () => {
  // **Validates: Requirements 4.2, 4.3**
  it("反复 upsert 同 signatureId 后该 id 恰出现一次", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("a", "b", "c", "dup-id"),
        fc.integer({ min: 0, max: 7 * 86_400_000 }),
        fc.integer({ min: 1, max: 25 }),
        (id, nowMs, n) => {
          const state = emptyChronotopicState();
          const sig = makeSignature(id, nowMs);
          let createdCount = 0;
          for (let i = 0; i < n; i += 1) {
            const { created } = upsertSignature(state, sig);
            if (created) createdCount += 1;
          }
          const matches = getSignatures(state).filter(
            (s) => s.signatureId === sig.signatureId,
          );
          // 同 id 恰出现一次，且只有首次为新建。
          expect(matches.length).toBe(1);
          expect(createdCount).toBe(1);
        },
      ),
    );
  });

  // **Validates: Requirements 4.2, 4.3**
  it("任意签名序列 upsert 后，signatures 长度 = 不同 signatureId 个数", () => {
    fc.assert(
      fc.property(fc.array(signatureArb, { maxLength: 40 }), (signatures) => {
        const state = emptyChronotopicState();
        for (const sig of signatures) upsertSignature(state, sig);

        const distinctIds = new Set(signatures.map((s) => s.signatureId));
        expect(state.signatures.length).toBe(distinctIds.size);
        // 每个不同 id 恰出现一次。
        const idsInState = state.signatures.map((s) => s.signatureId);
        expect(new Set(idsInState).size).toBe(idsInState.length);
        expect(new Set(idsInState)).toEqual(distinctIds);
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 任务 4.3 — Property 13: getActiveSignatures 无副作用
// ──────────────────────────────────────────────────────────────────

describe("getActiveSignatures — Property 13: 无副作用", () => {
  // **Validates: Requirements 4.4**
  it("调用前后 state.signatures 深度不变，返回长度 ≤ maxN", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.integer({ min: 0, max: 1e13 }),
        fc.integer({ min: 0, max: 50 }),
        (state, nowMs, maxN) => {
          const before = structuredClone(state.signatures);

          const active = getActiveSignatures(state, nowMs, maxN);

          // 深度不变（无副作用）。
          expect(state.signatures).toEqual(before);
          // 返回长度受 maxN 约束。
          expect(active.length).toBeLessThanOrEqual(maxN);
          expect(active.length).toBeLessThanOrEqual(state.signatures.length);
        },
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 任务 4.4 — Property 18: prune 后不超上限
// ──────────────────────────────────────────────────────────────────

describe("pruneSignatures — Property 18: prune 后不超上限", () => {
  // **Validates: Requirements 4.5**
  it("prune 后 length ≤ maxN，返回淘汰数 = 调用前长度 − 调用后长度", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.integer({ min: 0, max: 1e13 }),
        fc.integer({ min: 0, max: 40 }),
        (state, nowMs, maxN) => {
          const before = state.signatures.length;

          const removed = pruneSignatures(state, nowMs, maxN);
          const after = state.signatures.length;

          expect(after).toBeLessThanOrEqual(maxN);
          expect(removed).toBe(before - after);
          expect(removed).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 补充单元测试：emptyChronotopicState 初值 / getSignatures 容错
// ──────────────────────────────────────────────────────────────────

describe("emptyChronotopicState — 初值", () => {
  it("返回 { signatures: [], version: 1 }", () => {
    const state = emptyChronotopicState();
    expect(state).toEqual({ signatures: [], version: 1 });
    expect(Array.isArray(state.signatures)).toBe(true);
    expect(state.signatures.length).toBe(0);
  });
});

describe("getSignatures — 损坏 state 容错", () => {
  it("state 为 null / undefined 时返回空数组", () => {
    expect(getSignatures(null as unknown as ChronotopicState)).toEqual([]);
    expect(getSignatures(undefined as unknown as ChronotopicState)).toEqual([]);
  });

  it("state 缺 signatures 字段时返回空数组", () => {
    expect(getSignatures({} as unknown as ChronotopicState)).toEqual([]);
    expect(
      getSignatures({ version: 1 } as unknown as ChronotopicState),
    ).toEqual([]);
  });

  it("合法 state 原样返回其 signatures", () => {
    const state = emptyChronotopicState();
    const sig = makeSignature("only", 1_700_000_000_000);
    upsertSignature(state, sig);
    expect(getSignatures(state)).toBe(state.signatures);
    expect(getSignatures(state).length).toBe(1);
  });
});
