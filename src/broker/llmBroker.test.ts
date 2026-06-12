/**
 * LLM 经纪 ↔ BrokerLlmProvider 端到端管道测试（Phase 2a）。
 * 用 stub LLM 注入经纪，验证：往返序列化、Bearer 鉴权、健康检查、错误透传。
 * 不依赖真实上游（与中转是否可达无关）。
 */

import { describe, it, expect, afterEach } from "vitest";

import { startLlmBroker, type LlmBrokerHandle } from "./llmBroker.js";
import { BrokerLlmProvider } from "../llm/brokerLlmProvider.js";
import type { LLM_Provider, LlmRequest, LlmToolRequest } from "../llm/llmProvider.js";

const TOKEN = "test-broker-token-123";

/** 回声式 stub：把入参回填进响应，便于断言往返正确。 */
const stubLlm: LLM_Provider = {
  providerKey: "stub",
  async complete(req: LlmRequest) {
    return { text: `echo:${req.messages.map((m) => m.content).join("|")}` };
  },
  async completeWithTools(req: LlmToolRequest) {
    if (req.tools.length > 0) {
      return { toolCalls: [{ id: "tc1", name: req.tools[0].name, arguments: { ok: true } }] };
    }
    return { finalText: "no-tools" };
  },
};

let handle: LlmBrokerHandle | null = null;
afterEach(async () => { if (handle) { await handle.close(); handle = null; } });

describe("LLM 经纪管道（Phase 2a）", () => {
  it("complete：经经纪往返，大脑侧拿到结果", async () => {
    handle = await startLlmBroker({ port: 0, token: TOKEN, llm: stubLlm });
    const provider = new BrokerLlmProvider(`http://127.0.0.1:${handle.port}`, TOKEN);
    const out = await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("echo:hi");
  });

  it("completeWithTools：tool-calling 往返", async () => {
    handle = await startLlmBroker({ port: 0, token: TOKEN, llm: stubLlm });
    const provider = new BrokerLlmProvider(`http://127.0.0.1:${handle.port}`, TOKEN);
    const out = await provider.completeWithTools({
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "read_file", description: "d", parameters: {} }],
    });
    expect(out.toolCalls?.[0]?.name).toBe("read_file");
  });

  it("鉴权：错误 token 被拒（大脑侧报错，不返回结果）", async () => {
    handle = await startLlmBroker({ port: 0, token: TOKEN, llm: stubLlm });
    const bad = new BrokerLlmProvider(`http://127.0.0.1:${handle.port}`, "wrong-token");
    await expect(bad.complete({ system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
  });

  it("健康检查不鉴权", async () => {
    handle = await startLlmBroker({ port: 0, token: TOKEN, llm: stubLlm });
    const res = await fetch(`http://127.0.0.1:${handle.port}/broker/health`);
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("无 token 启动即拒绝（不裸奔）", async () => {
    await expect(startLlmBroker({ port: 0, token: "", llm: stubLlm })).rejects.toThrow();
  });

  it("上游报错透传为可读失败", async () => {
    const failing: LLM_Provider = {
      providerKey: "fail",
      async complete() { throw new Error("upstream 502 boom"); },
      async completeWithTools() { throw new Error("upstream 502 boom"); },
    };
    handle = await startLlmBroker({ port: 0, token: TOKEN, llm: failing });
    const provider = new BrokerLlmProvider(`http://127.0.0.1:${handle.port}`, TOKEN);
    await expect(provider.complete({ system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/经纪调用失败|502/);
  });
});
