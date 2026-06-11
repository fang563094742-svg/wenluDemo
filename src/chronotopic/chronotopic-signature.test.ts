/**
 * 时空校准层 · 时空签名构建测试（chronotopic-signature.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 2.2（Property 5：签名构建幂等）、任务 2.3（Property 6：presence
 * 分档单调）与相关单元测试（targetRef.id 空白抛错、传感器全空降级）。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-signature.js。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildChronotopicSignature,
  type ChronotopicTargetRef,
  type ChronotopicSensorInput,
  type ChronotopicInteractionInput,
  type ChronotopicPresence,
} from "./chronotopic-signature.js";

// ── fast-check 生成器：合法 targetRef / sensors / interaction / tz ──────────

const targetKindArb = fc.constantFrom<ChronotopicTargetRef["kind"]>(
  "riverbed-node",
  "episode",
  "concept",
  "belief",
  "event",
);

const targetRefArb: fc.Arbitrary<ChronotopicTargetRef> = fc.record({
  kind: targetKindArb,
  // 非空白 id（至少含一个非空白字符）
  id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== ""),
});

const isoFromMsArb = (msArb: fc.Arbitrary<number>) =>
  msArb.map((ms) => new Date(ms).toISOString());

const frontWindowArb = fc.record({
  appName: fc.string({ maxLength: 20 }),
  windowTitle: fc.string({ maxLength: 20 }),
  capturedAt: isoFromMsArb(fc.integer({ min: 0, max: 1e13 })),
});

const calendarEventArb = fc.record({
  title: fc.string({ maxLength: 20 }),
  startDate: isoFromMsArb(fc.integer({ min: 0, max: 1e13 })),
  endDate: isoFromMsArb(fc.integer({ min: 0, max: 1e13 })),
  calendarName: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
});

const clipboardArb = fc.record({
  preview: fc.string({ maxLength: 30 }),
  fullLength: fc.nat({ max: 10000 }),
  capturedAt: isoFromMsArb(fc.integer({ min: 0, max: 1e13 })),
});

const sensorsArb: fc.Arbitrary<ChronotopicSensorInput> = fc.record({
  frontWindow: fc.option(frontWindowArb, { nil: null }),
  calendarEvents: fc.array(calendarEventArb, { maxLength: 4 }),
  clipboard: fc.option(clipboardArb, { nil: null }),
});

const interactionArb: fc.Arbitrary<ChronotopicInteractionInput> = fc
  .record({
    nowMs: fc.integer({ min: 0, max: 1e13 }),
    awayMs: fc.integer({ min: 0, max: 1e11 }),
  })
  .map(({ nowMs, awayMs }) => ({
    nowMs,
    userLastActiveAtMs: Math.max(0, nowMs - awayMs),
  }));

const tzArb = fc.integer({ min: -720, max: 840 });

describe("buildChronotopicSignature（Property 5：签名构建幂等）", () => {
  // **Validates: Requirements 2.5**
  it("相同 (targetRef, sensors, interaction, tz) 两次调用 signatureId 相等且签名深度相等", () => {
    fc.assert(
      fc.property(targetRefArb, sensorsArb, interactionArb, tzArb, (targetRef, sensors, interaction, tz) => {
        const a = buildChronotopicSignature(targetRef, sensors, interaction, tz);
        const b = buildChronotopicSignature(targetRef, sensors, interaction, tz);
        expect(a.signatureId).toBe(b.signatureId);
        expect(a).toEqual(b);
      }),
    );
  });
});

describe("buildChronotopicSignature（Property 6：presence 分档单调）", () => {
  const RANK: Record<ChronotopicPresence, number> = {
    present: 0,
    recently_active: 1,
    away: 2,
  };

  // **Validates: Requirements 2.3, 2.4**
  it("固定 nowMs，userLastActiveAtMs 越早 → away 分钟越大 → presence 档位序号非降", () => {
    fc.assert(
      fc.property(
        targetRefArb,
        sensorsArb,
        tzArb,
        fc.integer({ min: 0, max: 1e13 }),
        // 一组距上次活跃的分钟数（非负），排序后逐档断言
        fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 2, maxLength: 12 }),
        (targetRef, sensors, tz, nowMs, awayMinutesList) => {
          const sorted = [...awayMinutesList].sort((x, y) => x - y);
          let prevRank = -1;
          for (const minutes of sorted) {
            const interaction: ChronotopicInteractionInput = {
              nowMs,
              userLastActiveAtMs: nowMs - minutes * 60_000,
            };
            const sig = buildChronotopicSignature(targetRef, sensors, interaction, tz);
            const rank = RANK[sig.presence];
            expect(rank).toBeGreaterThanOrEqual(prevRank);
            prevRank = rank;
          }
        },
      ),
    );
  });

  it("分档边界：0/2 分钟为 present、3/30 分钟为 recently_active、>30 为 away", () => {
    const targetRef: ChronotopicTargetRef = { kind: "event", id: "boundary" };
    const sensors: ChronotopicSensorInput = { frontWindow: null, calendarEvents: [], clipboard: null };
    const nowMs = 1_000_000_000;
    const at = (minutes: number) =>
      buildChronotopicSignature(targetRef, sensors, { nowMs, userLastActiveAtMs: nowMs - minutes * 60_000 }, 480)
        .presence;

    expect(at(0)).toBe("present");
    expect(at(2)).toBe("present");
    expect(at(3)).toBe("recently_active");
    expect(at(30)).toBe("recently_active");
    expect(at(31)).toBe("away");
    expect(at(120)).toBe("away");
  });
});

describe("buildChronotopicSignature（单元测试）", () => {
  // _Requirements: 2.7_
  it("targetRef.id 为空白时抛 CHRONOTOPIC_TARGET_REQUIRED", () => {
    const sensors: ChronotopicSensorInput = { frontWindow: null, calendarEvents: [], clipboard: null };
    const interaction: ChronotopicInteractionInput = { nowMs: 1_000, userLastActiveAtMs: 1_000 };
    for (const blank of ["", "   ", "\t", "\n"]) {
      expect(() =>
        buildChronotopicSignature({ kind: "event", id: blank }, sensors, interaction, 480),
      ).toThrow("CHRONOTOPIC_TARGET_REQUIRED");
    }
  });

  // _Requirements: 15.4_
  it("传感器全空 → scene=idle、frontAppName=null，仍产出合法签名", () => {
    const sensors: ChronotopicSensorInput = { frontWindow: null, calendarEvents: [], clipboard: null };
    const interaction: ChronotopicInteractionInput = { nowMs: 1_000_000, userLastActiveAtMs: 1_000_000 };
    const sig = buildChronotopicSignature({ kind: "event", id: "empty-sensors" }, sensors, interaction, 480);

    expect(sig.scene).toBe("idle");
    expect(sig.frontAppName).toBeNull();
    expect(sig.signatureId).toMatch(/^[0-9a-f]{16}$/);
    expect(sig.presence).toBe("present");
  });
});
