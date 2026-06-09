/**
 * 单元测试：LLM baseURL / model 的环境变量读取（Bug 7 修复）。
 *
 * 背景（Bug 7）：`.env` 中的 API key 属于第三方中转端点，必须配合 `WENLU_LLM_BASE_URL`
 * 指向的中转地址才有效。此前 `Gpt54Provider` 只从环境变量读 apiKey，baseURL/model 仅能由
 * 构造参数显式传入 → 运行时缺省回退到 OpenAI 官方端点，导致分析阶段 `fetch failed`。
 *
 * 本测试覆盖：
 *  - config.readBaseUrl / readModel：env 有值返回 trim 值，空/缺失返回 undefined。
 *  - Gpt54Provider 构造优先级：显式参数 > 环境变量 > 默认值（baseURL 与 model）。
 *
 * 全程注入 fetchImpl，不发起任何真实网络请求。
 */

import { describe, it, expect, vi } from "vitest";

import {
  readBaseUrl,
  readModel,
  BASE_URL_ENV_VAR,
  MODEL_ENV_VAR,
} from "../../src/config/config.js";
import {
  Gpt54Provider,
  DEFAULT_GPT54_MODEL,
  DEFAULT_GPT54_BASE_URL,
} from "../../src/llm/gpt54Provider.js";

/** 把若干 SSE chunk 序列化为标准 OpenAI SSE 文本，并附 `data: [DONE]` 结束帧。 */
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
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 返回一个产出单段文本的成功 fetch mock（末尾附 usage-only 空 choices chunk）。 */
function okFetch(text = "ok"): typeof fetch {
  const chunks: unknown[] = [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return vi.fn(async () => streamResponse(sseText(chunks))) as unknown as typeof fetch;
}

/** 触发一次请求并取回 fetch mock 捕获到的实际请求 URL。 */
async function capturedUrl(provider: Gpt54Provider, fetchMock: typeof fetch): Promise<string> {
  await provider.complete({ system: "", messages: [{ role: "user", content: "hi" }] });
  const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  return url as string;
}

describe("config.readBaseUrl", () => {
  it("env 有值时返回 trim 后的值", () => {
    const env = { [BASE_URL_ENV_VAR]: "  https://relay.example/v1  " } as NodeJS.ProcessEnv;
    expect(readBaseUrl(env)).toBe("https://relay.example/v1");
  });

  it("缺失或空白时返回 undefined", () => {
    expect(readBaseUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readBaseUrl({ [BASE_URL_ENV_VAR]: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("config.readModel", () => {
  it("env 有值时返回 trim 后的值", () => {
    const env = { [MODEL_ENV_VAR]: "  custom-model  " } as NodeJS.ProcessEnv;
    expect(readModel(env)).toBe("custom-model");
  });

  it("缺失或空白时返回 undefined", () => {
    expect(readModel({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readModel({ [MODEL_ENV_VAR]: "" } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("Gpt54Provider baseURL/model 解析优先级（Bug 7）", () => {
  it("仅给 env：baseURL/model 取环境值", async () => {
    const env = {
      OPENAI_API_KEY: "sk-test",
      [BASE_URL_ENV_VAR]: "https://relay.example/v1",
      [MODEL_ENV_VAR]: "relay-model",
    } as NodeJS.ProcessEnv;
    const fetchMock = okFetch();
    const provider = new Gpt54Provider({ env, fetchImpl: fetchMock });

    expect(provider.providerKey).toBe("relay-model");
    const url = await capturedUrl(provider, fetchMock);
    expect(url.startsWith("https://relay.example/v1")).toBe(true);
  });

  it("显式 options 优先于 env", async () => {
    const env = {
      OPENAI_API_KEY: "sk-test",
      [BASE_URL_ENV_VAR]: "https://relay.example/v1",
      [MODEL_ENV_VAR]: "relay-model",
    } as NodeJS.ProcessEnv;
    const fetchMock = okFetch();
    const provider = new Gpt54Provider({
      env,
      baseURL: "https://explicit.example/v1",
      model: "explicit-model",
      fetchImpl: fetchMock,
    });

    expect(provider.providerKey).toBe("explicit-model");
    const url = await capturedUrl(provider, fetchMock);
    expect(url.startsWith("https://explicit.example/v1")).toBe(true);
  });

  it("env/显式都没有时回退默认值", async () => {
    const env = { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv;
    const fetchMock = okFetch();
    const provider = new Gpt54Provider({ env, fetchImpl: fetchMock });

    expect(provider.providerKey).toBe(DEFAULT_GPT54_MODEL);
    const url = await capturedUrl(provider, fetchMock);
    expect(url.startsWith(DEFAULT_GPT54_BASE_URL)).toBe(true);
  });
});
