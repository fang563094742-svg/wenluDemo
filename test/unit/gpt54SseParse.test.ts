/**
 * 单元测试：GPT-5.4 流式 SSE 解析纯函数（Bug 6 修复）。
 *
 * 喂入真实端点样例的 SSE 文本，断言纯函数行为：
 *  - `parseSseStreamToText`：把 content 分片（"连"/"通"）+ 空 choices 的 usage chunk + [DONE]
 *    正确拼成 "连通"；只有空 choices 的样例安全得到空串不抛错。
 *  - `accumulateToolCallDeltas`：name 在首片、arguments 分多片（`{"pa` + `th":"R` + `EADME.md"}`）
 *    时按 index 累积出正确的 tool call（name + 完整 arguments JSON）。
 *
 * 不发起任何网络请求——全部针对纯文本输入。
 */

import { describe, it, expect } from "vitest";

import {
  parseSseStreamToText,
  parseSseEvents,
  accumulateToolCallDeltas,
} from "../../src/llm/gpt54Provider.js";

describe("parseSseStreamToText —— content 分片拼接", () => {
  it("真实端点样例：拼接 delta.content 分片得到完整文本，空 choices usage chunk 安全跳过", () => {
    const rawSse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"连"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"通"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":24,"completion_tokens":6,"total_tokens":30}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    expect(parseSseStreamToText(rawSse)).toBe("连通");
  });

  it("非流式样例（只有空 choices 的 chunk）安全得到空串，不抛错", () => {
    const rawSse = [
      'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"completion_tokens":0}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    expect(parseSseStreamToText(rawSse)).toBe("");
  });

  it("`data:` 后无空格、含 CRLF、夹杂非 data 行（event:/注释）均能正确解析", () => {
    const rawSse =
      ": keep-alive comment\r\n" +
      "event: message\r\n" +
      'data:{"choices":[{"index":0,"delta":{"content":"A"}}]}\r\n' +
      "\r\n" +
      'data: {"choices":[{"index":0,"delta":{"content":"B"}}]}\r\n' +
      "\r\n" +
      "data: [DONE]\r\n\r\n";

    expect(parseSseStreamToText(rawSse)).toBe("AB");
  });

  it("非法 JSON 的 data 行被安全跳过，不影响其余分片", () => {
    const rawSse = [
      "data: this-is-not-json",
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    expect(parseSseStreamToText(rawSse)).toBe("ok");
  });
});

describe("accumulateToolCallDeltas —— tool_calls 增量累积", () => {
  it("name 在首片、arguments 分多片时按 index 累积出完整 tool call", () => {
    const rawSse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"R"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"EADME.md\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"completion_tokens":12}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    const toolCalls = accumulateToolCallDeltas(parseSseEvents(rawSse));
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_abc");
    expect(toolCalls[0].function?.name).toBe("read_file");
    expect(toolCalls[0].function?.arguments).toBe('{"path":"README.md"}');
    // 拼接出的 arguments 是合法 JSON。
    expect(JSON.parse(toolCalls[0].function?.arguments as string)).toEqual({ path: "README.md" });
  });

  it("多个 tool call（不同 index）分别累积并按 index 升序排列", () => {
    const rawSse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"b","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"a","arguments":"{}"}}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    const toolCalls = accumulateToolCallDeltas(parseSseEvents(rawSse));
    expect(toolCalls.map((t) => t.function?.name)).toEqual(["a", "b"]);
  });

  it("无 tool_calls 的流返回空数组", () => {
    const rawSse = [
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    expect(accumulateToolCallDeltas(parseSseEvents(rawSse))).toEqual([]);
  });
});
