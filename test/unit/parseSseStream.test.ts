/**
 * 单元测试：parseSseStream（Bug 6 流式聚合纯函数）。
 *
 * 覆盖：
 *  - 真实样例 SSE 流逐块聚合出 content="连通"。
 *  - tool_calls 增量（id+name 首块、arguments 分多块）聚合为正确的 tool call。
 *  - [DONE] / 空行 / 注释行 / 坏 JSON 行被正确跳过。
 *  - 非流式 message 形态也能解析（端点若回退为非流式不炸）。
 */

import { describe, it, expect } from "vitest";
import { parseSseStream } from "../../src/llm/gpt54Provider.js";

describe("parseSseStream — content 聚合", () => {
  it("从真实样例流聚合出 content=连通", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"连"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"通"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"total_tokens":5}}',
      "data: [DONE]",
    ].join("\n");

    const result = parseSseStream(raw);
    expect(result.content).toBe("连通");
    expect(result.toolCalls).toEqual([]);
  });

  it("跳过空行、注释行与坏 JSON 行，仍聚合出正确 content", () => {
    const raw = [
      ": this is an SSE comment",
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}',
      "data: {bad json here",
      "   ",
      'data: {"choices":[{"index":0,"delta":{"content":"b"}}]}',
      "event: ping",
      "data: [DONE]",
    ].join("\n");

    const result = parseSseStream(raw);
    expect(result.content).toBe("ab");
  });
});

describe("parseSseStream — tool_calls 聚合", () => {
  it("聚合 id+name 首块、arguments 分多块的 tool call", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n");

    const result = parseSseStream(raw);
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    expect(result.content).toBe("");
  });

  it("聚合多个并行 tool_calls（按 index 分组）", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"read_file","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"list_dir","arguments":"{\\"p\\":\\"x\\"}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");

    const result = parseSseStream(raw);
    expect(result.toolCalls).toEqual([
      { id: "c0", name: "read_file", arguments: {} },
      { id: "c1", name: "list_dir", arguments: { p: "x" } },
    ]);
  });
});

describe("parseSseStream — 非流式 message 回退", () => {
  it("从非流式 choices[0].message 形态解析 content", () => {
    const raw = 'data: {"choices":[{"message":{"content":"hello"}}]}\ndata: [DONE]';
    const result = parseSseStream(raw);
    expect(result.content).toBe("hello");
  });

  it("从非流式 choices[0].message.tool_calls 解析工具调用", () => {
    const raw =
      'data: {"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_9","function":{"name":"write_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}]}}]}\ndata: [DONE]';
    const result = parseSseStream(raw);
    expect(result.toolCalls).toEqual([
      { id: "call_9", name: "write_file", arguments: { path: "b.ts" } },
    ]);
  });
});
