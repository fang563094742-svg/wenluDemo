/**
 * 时空校准层 · 置信度校准器测试（chronotopic-calibrator.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 3.2（Property 1：校准值域）、3.3（Property 2：只降权不抬升）、
 * 3.4（Property 3：对 raw 单调非减）、3.5（Property 4：基准时空恒等）。
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ./chronotopic-*.js。
 * 构造合法 ChronotopicSignature 一律走 buildChronotopicSignature 保证真实性。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  calibrateConfidence,
  clamp01,
  DEFAULT_CHRONOTOPIC_CONFIG,
} from "./chronotopic-calibrator.js";
import {
  buildChronotopicSignature,
  type ChronotopicSignature,
  type ChronotopicSensorInput,
  type ChronotopicInteractionInput,
} from "./chronotopic-signature.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const emptySensors: ChronotopicSensorInput = {
  frontWindow: null,
  calendarEvents: [],
  clipboard: null,
};

/**
 * 生成任意合法的真实签名：覆盖各 timeOfDay（由 hourOfDay 决定）与各 presence
 * （由 awayMinutes 决定）。统一用 tz=0，使 nowMs 直接决定本地小时。
 */
const signatureArb: fc.Arbitrary<ChronotopicSignature> = fc
  .record({
    dayIndex: fc.integer({ min: 0, max: 3000 }),
    hour: fc.integer({ min: 0, max: 23 }),
    awayMinutes: fc.integer({ min: 0, max: 600 }),
  })
  .map(({ dayIndex, hour, awayMinutes }) => {
    const nowMs = dayIndex * MS_PER_DAY + hour * MS_PER_HOUR;
    const interaction: ChronotopicInteractionInput = {
      nowMs,
      userLastActiveAtMs: nowMs - awayMinutes * 60_000,
    };
    return buildChronotopicSignature({ kind: "event", id: "calib" }, emptySensors, interaction, 0);
  });

/** 任意原始置信度，含 NaN / Infinity / 越界值。 */
const rawConfidenceArb = fc.oneof(
  fc.double({ noNaN: false }),
  fc.double({ min: -100, max: 100, noNaN: true }),
  fc.constantFrom(NaN, Infinity, -Infinity, 0, 1, -0.5, 1.5),
);

describe("calibrateConfidence（Property 1：校准值恒在 [0,1] 内）", () => {
  // **Validates: Requirements 3.1**
  it("任意 rawConfidence（含 NaN/越界）+ 任意合法 signature，结果 ∈ [0,1]", () => {
    fc.assert(
      fc.property(rawConfidenceArb, signatureArb, (raw, sig) => {
        const out = calibrateConfidence(raw, sig);
        expect(Number.isNaN(out)).toBe(false);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("calibrateConfidence（Property 2：只降权不抬升）", () => {
  // **Validates: Requirements 3.3**
  it("DEFAULT 配置（乘子∈(0,1]）下 calibrate(raw,sig) ≤ clamp01(raw)", () => {
    fc.assert(
      fc.property(rawConfidenceArb, signatureArb, (raw, sig) => {
        const out = calibrateConfidence(raw, sig, DEFAULT_CHRONOTOPIC_CONFIG);
        // 容差吸收浮点误差
        expect(out).toBeLessThanOrEqual(clamp01(raw) + 1e-9);
      }),
    );
  });
});

describe("calibrateConfidence（Property 3：对 rawConfidence 单调非减）", () => {
  // **Validates: Requirements 3.4**
  it("固定 signature，a ≤ b ⇒ calibrate(a) ≤ calibrate(b)", () => {
    fc.assert(
      fc.property(
        signatureArb,
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (sig, x, y) => {
          const a = Math.min(x, y);
          const b = Math.max(x, y);
          const ca = calibrateConfidence(a, sig);
          const cb = calibrateConfidence(b, sig);
          expect(ca).toBeLessThanOrEqual(cb + 1e-9);
        },
      ),
    );
  });
});

describe("calibrateConfidence（Property 4：基准时空恒等）", () => {
  /**
   * 构造 timeOfDay∈{morning,afternoon}（hourOfDay 6–17）且 presence=present
   * （userLastActiveAtMs=nowMs）的签名 —— 此时时段乘子与在场乘子均为 1.0。
   */
  const baselineSignatureArb: fc.Arbitrary<ChronotopicSignature> = fc
    .record({
      dayIndex: fc.integer({ min: 0, max: 3000 }),
      hour: fc.integer({ min: 6, max: 17 }),
    })
    .map(({ dayIndex, hour }) => {
      const nowMs = dayIndex * MS_PER_DAY + hour * MS_PER_HOUR;
      const interaction: ChronotopicInteractionInput = { nowMs, userLastActiveAtMs: nowMs };
      return buildChronotopicSignature({ kind: "event", id: "baseline" }, emptySensors, interaction, 0);
    });

  // **Validates: Requirements 3.5**
  it("基准时空（乘子均 1.0）下 calibrate(raw,sig) === clamp01(raw)", () => {
    fc.assert(
      fc.property(rawConfidenceArb, baselineSignatureArb, (raw, sig) => {
        // 前置确认签名确实落在基准档
        expect(["morning", "afternoon"]).toContain(sig.temporal.timeOfDay);
        expect(sig.presence).toBe("present");
        expect(DEFAULT_CHRONOTOPIC_CONFIG.timeOfDayFactor[sig.temporal.timeOfDay]).toBe(1.0);
        expect(DEFAULT_CHRONOTOPIC_CONFIG.presenceFactor[sig.presence]).toBe(1.0);

        expect(calibrateConfidence(raw, sig)).toBe(clamp01(raw));
      }),
    );
  });
});
