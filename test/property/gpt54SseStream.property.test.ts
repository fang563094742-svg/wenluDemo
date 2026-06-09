/**
 * Property 测试：GPT-5.4 流式 SSE 解析（Bug 6 修复）。
 *
 * 属性：SSE 解析是「分片拼接」的逆变换。
 *   对任意字符串数组作为 content 分片序列，构造成标准 SSE chunk 文本后，
 *   `parseSseStreamToText` 的结果应等于这些分片直接 `join("")`。
 *   空 choices 的 usage chunk 与 [DONE] 哨兵不得影响拼接结果。
 *
 * **Validates: Requirements 6.4**
 *
 * 不发起任何网络请求——纯函数 + 文本构造。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { parseSseStreamToText } from "../../src/llm/gpt54Provider.js";

/** 把一组 content 分片构造为标准 OpenAI SSE 文本（每片一个 chunk），末尾附 usage 空帧 + [DONE]。 */
function buildSse(fragments: string[]): string {
  const frames = fragments.map(
    (f) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: f }, finish_reason: null }] })}\n\n`,
  );
  // 末尾 usage-only 空 choices chunk（应被安全跳过）。
  frames.push(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 1 } })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

describe("parseSseStreamToText 是分片拼接的逆变换（property）", () => {
  it("任意 content 分片序列：解析结果 === 分片 join", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (fragments) => {
        const sse = buildSse(fragments);
        expect(parseSseStreamToText(sse)).toBe(fragments.join(""));
      }),
    );
  });

  it("含 unicode / 多语言分片亦成立", () => {
    fc.assert(
      fc.property(fc.array(fc.fullUnicodeString()), (fragments) => {
        const sse = buildSse(fragments);
        expect(parseSseStreamToText(sse)).toBe(fragments.join(""));
      }),
    );
  });
});
