/**
 * BrokerLlmProvider —— 大脑侧的 LLM 经纪客户端（Phase 2a）。
 *
 * 实现 {@link LLM_Provider} 接口，把 complete / completeWithTools 转发到本机经纪
 * (WENLU_BROKER_URL)。大脑进程因此**不持有任何 LLM 密钥/端点**——密钥只在经纪进程里。
 * 对上层 ResilientLlm / LlmPool / Executor 完全透明（同一接口）。
 *
 * 安全：仅以 `Authorization: Broker <token>` 调用本机经纪；token 为进程级令牌（非长期密钥）。
 */

import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "./llmProvider.js";

export class BrokerLlmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerLlmProviderError";
  }
}

export class BrokerLlmProvider implements LLM_Provider {
  readonly providerKey = "broker";
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(brokerUrl: string, token: string, timeoutMs = 120_000) {
    this.base = brokerUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return this.post<LlmResponse>("/broker/llm/complete", req);
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    return this.post<LlmToolResponse>("/broker/llm/complete-with-tools", req);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Broker ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; response?: T; error?: string }
        | null;
      if (!res.ok || !data || data.ok !== true) {
        const reason = data?.error ?? `HTTP ${res.status}`;
        throw new BrokerLlmProviderError(`经纪调用失败：${reason}`);
      }
      return data.response as T;
    } catch (e) {
      if (e instanceof BrokerLlmProviderError) throw e;
      throw new BrokerLlmProviderError(
        `无法连接 LLM 经纪：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
