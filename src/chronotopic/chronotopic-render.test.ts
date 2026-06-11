/**
 * 时空校准层 · 意识注入模块测试（chronotopic-render.test.ts）
 * ------------------------------------------------------------------
 * 覆盖任务 5.3（renderChronotopicBlock 单元测试）：
 *   - 空签名列表返回占位串「（时空感尚在形成）」
 *   - 非空列表输出含「此刻时空态势」关键描述
 *   - 调用前后入参签名数组不变（无副作用）
 *   - maxChars=0 返回空串
 *
 * 绝对边界：仅 import vitest 与被测 ./*.js（render + signature），
 * 不 import 3.1/3.2、不 node:sqlite。
 *
 * _Requirements: 5.2, 5.4_
 */

import { describe, it, expect } from "vitest";
import { renderChronotopicBlock } from "./chronotopic-render.js";
import {
  buildChronotopicSignature,
  type ChronotopicSignature,
  type ChronotopicTargetRef,
} from "./chronotopic-signature.js";

/** 空签名列表占位串（与 chronotopic-render.ts 的 EMPTY_PLACEHOLDER 对齐）。 */
const EMPTY_PLACEHOLDER = "（时空感尚在形成）";
/** 时空态势块的关键描述（标题包含此短语）。 */
const BLOCK_KEYWORD = "此刻时空态势";
/** 固定时区偏移（东八区）。 */
const TZ = 480;

/** 构造一枚确定性时空签名（用真实 buildChronotopicSignature）。 */
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

const NOW = 1_700_000_000_000;

describe("renderChronotopicBlock — 单元测试", () => {
  // _Requirements: 5.2_
  it("空签名列表返回占位串「（时空感尚在形成）」", () => {
    expect(renderChronotopicBlock([], NOW)).toBe(EMPTY_PLACEHOLDER);
  });

  // _Requirements: 5.1_
  it("非空列表输出含「此刻时空态势」关键描述", () => {
    const sigs = [
      makeSignature("a", NOW),
      makeSignature("b", NOW - 3_600_000),
    ];
    const out = renderChronotopicBlock(sigs, NOW);
    expect(out).toContain(BLOCK_KEYWORD);
    expect(out.length).toBeGreaterThan(0);
  });

  // _Requirements: 5.4_
  it("调用前后入参签名数组不变（无副作用）", () => {
    const sigs = [
      makeSignature("a", NOW),
      makeSignature("b", NOW - 7_200_000),
      makeSignature("c", NOW - 3_600_000),
    ];
    const lengthBefore = sigs.length;
    const orderBefore = sigs.map((s) => s.signatureId);
    const snapshot = structuredClone(sigs);

    renderChronotopicBlock(sigs, NOW);

    // 数组长度、元素顺序、内容均不变。
    expect(sigs.length).toBe(lengthBefore);
    expect(sigs.map((s) => s.signatureId)).toEqual(orderBefore);
    expect(sigs).toEqual(snapshot);
  });

  // _Requirements: 5.4_
  it("maxChars=0 返回空串", () => {
    const sigs = [makeSignature("a", NOW)];
    expect(renderChronotopicBlock(sigs, NOW, 0)).toBe("");
    // 空列表 + maxChars=0 同样返回空串。
    expect(renderChronotopicBlock([], NOW, 0)).toBe("");
  });
});
