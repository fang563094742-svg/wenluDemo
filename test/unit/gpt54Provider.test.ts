/**
 * 单元测试：Gpt54Provider（任务 5.2 + Bug 6 流式修复）。
 *
 * 全程 mock fetch，不发起任何真实网络请求。覆盖：
 *  - key 缺失时构造抛描述性错误（R6.2/R6.4）。
 *  - complete：jsonSchema 映射为 response_format、解析流式 delta.content（R6 complete）。
 *  - completeWithTools：tools 映射、流式 tool_calls 累积解析、纯文本回退（R6 completeWithTools）。
 *  - 调用失败（非 2xx / 网络错误）抛描述性 Gpt54ProviderError（R6.5）。
 *  - API key 仅经环境变量读取，不硬编码（R6.2/R6.3）。
 *  - Bug 6：端点必须 stream:true 才产出内容；请求体一律带 stream:true，并解析 SSE 流。
 */

import { describe, it, expect, vi } from "vitest";

import {
  Gpt54Provider,
  Gpt54ProviderError,
  DEFAULT_GPT54_MODEL,
  toChatMessages,
  toChatTools,
  parseToolCalls,
} from "../../src/llm/gpt54Provider.js";
import type { ToolSpec } from "../../src/llm/llmProvider.js";

/**
 * 把若干 SSE chunk（已是 JSON 对象）序列化为标准 OpenAI SSE 文本，并附 `data: [DONE]` 结束帧。
 */
function sseText(chunks: unknown[]): string {
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

/** 把一段文本包装为带可读 body（ReadableStream）的流式 Response。 */
function streamResponse(rawSse: string): Response {
  const bytes = new TextEncoder().encode(rawSse);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 拆成多块下发，模拟跨 chunk 的半行边界。
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * 构造一个返回流式响应的成功 fetch mock。
 *  - 传字符串或 { text }：把它作为单个 delta.content 片段产出。
 *  - 传 { toolCalls }：把它作为 delta.tool_calls 产出。
 * 末尾始终附一个 usage-only 的空 choices chunk（与真实端点一致）。
 */
function okFetch(
  opts: { text?: string; toolCalls?: unknown[] } | string = "",
): typeof fetch {
  const normalized = typeof opts === "string" ? { text: opts } : opts;
  const chunks: unknown[] = [];
  if (normalized.toolCalls && normalized.toolCalls.length > 0) {
    chunks.push({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: normalized.toolCalls },
          finish_reason: null,
        },
      ],
    });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else if (typeof normalized.text === "string" && normalized.text.length > 0) {
    chunks.push({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    chunks.push({ choices: [{ index: 0, delta: { content: normalized.text }, finish_reason: null }] });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  chunks.push({
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return vi.fn(async () => streamResponse(sseText(chunks))) as unknown as typeof fetch;
}

const ENV = { OPENAI_API_KEY: "sk-test-key" } as NodeJS.ProcessEnv;

describe("Gpt54Provider 构造与 key 读取", () => {
  it("缺少 API key 时构造抛描述性 Gpt54ProviderError", () => {
    expect(() => new Gpt54Provider({ env: {} as NodeJS.ProcessEnv })).toThrow(
      Gpt54ProviderError,
    );
  });

  it("从环境变量读取 key，providerKey 默认为 gpt-5.4", () => {
    const provider = new Gpt54Provider({ env: ENV, fetchImpl: okFetch() });
    expect(provider.providerKey).toBe(DEFAULT_GPT54_MODEL);
  });

  it("显式注入的 model 会作为 providerKey", () => {
    const provider = new Gpt54Provider({ env: ENV, model: "gpt-5.4-mini", fetchImpl: okFetch() });
    expect(provider.providerKey).toBe("gpt-5.4-mini");
  });
});

describe("complete", () => {
  it("拼接流式 delta.content 为 text，请求体带 stream:true，jsonSchema 非空时带 response_format", async () => {
    const fetchMock = okFetch({ text: '{"items":[]}' });
    const provider = new Gpt54Provider({ env: ENV, fetchImpl: fetchMock, apiKey: "sk-x" });

    const res = await provider.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: { type: "object" },
      temperature: 0.4,
    });

    expect(res.text).toBe('{"items":[]}');

    // 校验请求体映射
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(DEFAULT_GPT54_MODEL);
    expect(body.stream).toBe(true);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.temperature).toBe(0.4);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("sys");
    expect(body.messages[0].content).not.toContain("[IDENTITY OVERRIDE]");
  });

  it("非 2xx 响应抛描述性 Gpt54ProviderError（含状态码）", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    ) as unknown as typeof fetch;
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    await expect(
      provider.complete({ system: "", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrowError(/429/);
  });

  it("网络错误抛描述性 Gpt54ProviderError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    await expect(
      provider.complete({ system: "", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(Gpt54ProviderError);
  });

  it("仅 usage 空 choices 流（模型零输出）安全得到空串不抛错", async () => {
    const fetchMock = okFetch(); // 仅末尾 usage-only chunk
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    const res = await provider.complete({
      system: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.text).toBe("");
  });
});

describe("completeWithTools", () => {
  it("返回流式 tool_calls 时累积解析为 toolCalls（arguments 由 JSON 字符串解析）", async () => {
    const fetchMock = okFetch({
      toolCalls: [
        { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    });
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    const tools: ToolSpec[] = [
      { name: "read_file", description: "读取文件", parameters: { type: "object" } },
    ];
    const res = await provider.completeWithTools({
      system: "exec",
      messages: [{ role: "user", content: "go" }],
      tools,
    });

    expect(res.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    expect(res.finalText).toBeUndefined();
  });

  it("无 tool_calls 时回退为 finalText", async () => {
    const fetchMock = okFetch({ text: "done" });
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    const res = await provider.completeWithTools({
      system: "exec",
      messages: [{ role: "user", content: "go" }],
      tools: [],
    });

    expect(res.finalText).toBe("done");
    expect(res.toolCalls).toBeUndefined();
  });

  it("请求体带 stream:true、带 tools/tool_choice，但绝不带 response_format（端点不接受并存）", async () => {
    const fetchMock = okFetch({ text: "done" });
    const provider = new Gpt54Provider({ apiKey: "sk-x", fetchImpl: fetchMock });

    const tools: ToolSpec[] = [
      { name: "read_file", description: "读取文件", parameters: { type: "object" } },
    ];
    await provider.completeWithTools({
      system: "exec",
      messages: [{ role: "user", content: "go" }],
      tools,
      jsonSchema: { type: "object" },
      temperature: 0.2,
    });

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.response_format).toBeUndefined();
    expect("response_format" in body).toBe(false);
  });
});

describe("纯辅助函数映射", () => {
  it("toChatMessages 把非空 system 段映射为首条消息，tool 角色保留 tool_call_id", () => {
    const messages = toChatMessages({
      system: "sys",
      messages: [
        { role: "user", content: "u" },
        { role: "tool", content: "result", toolCallId: "call_9" },
      ],
    });
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("sys");
    expect(messages[0].content).not.toContain("[IDENTITY OVERRIDE]");
    expect(messages[2]).toEqual({ role: "tool", content: "result", tool_call_id: "call_9" });
  });

  it("toChatTools 映射为 function-calling 声明", () => {
    const spec: ToolSpec = { name: "write_file", description: "写文件", parameters: { type: "object" } };
    expect(toChatTools([spec])).toEqual([
      { type: "function", function: { name: "write_file", description: "写文件", parameters: { type: "object" } } },
    ]);
  });

  it("parseToolCalls 跳过无名项、为缺失 id 生成回退 id、容错非法 arguments", () => {
    const parsed = parseToolCalls([
      { function: { name: "", arguments: "{}" } }, // 无名 → 跳过
      { function: { name: "list_dir", arguments: "not-json" } }, // 非法 JSON → 回退
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("list_dir");
    expect(parsed[0].id).toBe("call_1");
    expect(parsed[0].arguments).toEqual({ _raw: "not-json" });
  });
});
