/**
 * 韧性层（Resilience Layer）——包住所有 LLM 调用。
 *
 * 解决底层缺陷一：LLM 调用是"全有或全无"的阻塞式同步，上游一抖任务就死。
 *
 * 这一层保证业务代码永远拿到「要么成功、要么明确降级结果」，
 * 而不会被一个原始网络异常击穿：
 *  - 指数退避重试（默认 3 次：1s / 3s / 7s）
 *  - 每次调用有硬上限超时（Promise.race，防止某次调用无限期占住事件循环 —— 也兜住缺陷二）
 *  - 连续多次失败 → 抛出可识别的 LlmExhaustedError，由调用方决定挂起任务而非崩溃
 *  - 透明日志：每次重试/降级都记录，便于诊断
 */

import type { LLM_Provider, LlmToolRequest, LlmToolResponse, LlmRequest, LlmResponse } from "./llmProvider.js";

/** 重试全部用尽后抛出——调用方应据此把任务挂起（blocked），而不是当致命错误崩溃。 */
export class LlmExhaustedError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "LlmExhaustedError";
    this.attempts = attempts;
  }
}

export interface ResilienceOptions {
  /** 最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 每次尝试的硬超时（毫秒），默认 90s。超过则中止该次尝试并重试。 */
  perAttemptTimeoutMs?: number;
  /** 退避基数（毫秒），第 n 次重试等待 backoffBaseMs * (2^(n-1)) + 抖动。默认 1000。 */
  backoffBaseMs?: number;
  /** 日志钩子（可选）。 */
  onEvent?: (ev: { kind: "retry" | "timeout" | "exhausted" | "ok"; attempt: number; detail?: string }) => void;
}

const DEFAULTS: Required<Omit<ResilienceOptions, "onEvent">> = {
  maxAttempts: 3,
  perAttemptTimeoutMs: 90_000,
  backoffBaseMs: 1000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 给任意 Promise 套一层硬超时围栏。超时 reject，但底层调用自身的 AbortController
 * 仍会在 provider 内部按其 timeout 触发——这里是"双保险"，确保事件循环不被无限期占住。
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 硬超时`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * 韧性包装器：包住一个底层 LLM provider，对外暴露同样的 complete / completeWithTools，
 * 但内部带重试 + 超时围栏 + 熔断。
 */
export class ResilientLlm implements LLM_Provider {
  readonly providerKey: string;
  private readonly inner: LLM_Provider;
  private readonly opts: Required<Omit<ResilienceOptions, "onEvent">>;
  private readonly onEvent?: ResilienceOptions["onEvent"];

  constructor(inner: LLM_Provider, options: ResilienceOptions = {}) {
    this.inner = inner;
    this.providerKey = inner.providerKey;
    this.opts = {
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      perAttemptTimeoutMs: options.perAttemptTimeoutMs ?? DEFAULTS.perAttemptTimeoutMs,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
    };
    this.onEvent = options.onEvent;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return this.run("complete", () => this.inner.complete(req));
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    return this.run("completeWithTools", () => this.inner.completeWithTools(req));
  }

  /** 通用执行：重试 + 超时围栏 + 熔断。 */
  private async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        const result = await withTimeout(fn(), this.opts.perAttemptTimeoutMs, `${label} 第${attempt}次`);
        if (attempt > 1) this.onEvent?.({ kind: "ok", attempt, detail: "重试后成功" });
        return result;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = /超时|timeout|abort/i.test(msg);
        this.onEvent?.({ kind: isTimeout ? "timeout" : "retry", attempt, detail: msg.slice(0, 160) });
        if (attempt < this.opts.maxAttempts) {
          // 指数退避 + 抖动
          const wait = this.opts.backoffBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
          await sleep(wait);
        }
      }
    }
    this.onEvent?.({ kind: "exhausted", attempt: this.opts.maxAttempts, detail: lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr) });
    throw new LlmExhaustedError(
      `LLM 调用连续 ${this.opts.maxAttempts} 次失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      this.opts.maxAttempts,
    );
  }
}
