// Feature: proactive-awareness-demo, Bug 6 流式聚合: 拆分不变性。
// 把任意已知文本拆成若干 delta.content 分片、再包成 SSE 行，parseSseStream 聚合出的
// content 必须恒等于原文本（无论分片如何切分）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseSseStream } from "../../src/llm/gpt54Provider.js";

/**
 * Bug 6 — 流式 content 聚合的拆分不变性
 *
 * Validates: Requirements 6.4
 *
 * 对任意文本与任意切分点，把文本切成若干分片，每片包成一个
 * `data: {choices:[{delta:{content: <片>}}]}` 行，parseSseStream 聚合出的
 * content 恒等于原文本（拼接 == 原文，切分方式无关）。
 */

/** 把一个文本切成若干分片（切分点由 indices 给出，去重排序后切割）。 */
function splitAt(text: string, cuts: number[]): string[] {
  const chars = [...text];
  const points = [...new Set(cuts.map((c) => ((c % (chars.length + 1)) + chars.length + 1) % (chars.length + 1)))]
    .filter((p) => p > 0 && p < chars.length)
    .sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = 0;
  for (const p of points) {
    parts.push(chars.slice(prev, p).join(""));
    prev = p;
  }
  parts.push(chars.slice(prev).join(""));
  return parts;
}

/** 把分片包成 SSE 流（含起始角色块、结束块、空 choices 块与 [DONE]）。 */
function toSse(parts: string[]): string {
  const lines: string[] = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}`,
  ];
  for (const part of parts) {
    lines.push(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}`,
    );
  }
  lines.push(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}`,
  );
  lines.push(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 1 } })}`);
  lines.push("data: [DONE]");
  return lines.join("\n");
}

describe("Bug 6: parseSseStream content 拆分不变性", () => {
  it("聚合 content 恒等于原文本（任意文本 × 任意切分）", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 20 }),
        (text, cuts) => {
          const parts = splitAt(text, cuts);
          // 切分必须无损：拼回原文
          expect(parts.join("")).toBe(text);
          const result = parseSseStream(toSse(parts));
          expect(result.content).toBe(text);
        },
      ),
      { numRuns: 200 },
    );
  });
});
