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

/** 连续触发 429/配额限流后抛出——调用方据此进入降载冷却，而非简单重试。 */
export class LlmRateLimitedError extends Error {
  readonly attempts: number;
  readonly retryAfterMs: number | null;
  readonly status?: number;
  constructor(
    message: string,
    attempts: number,
    options: { retryAfterMs?: number | null; status?: number } = {},
  ) {
    super(message);
    this.name = "LlmRateLimitedError";
    this.attempts = attempts;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status;
  }
}

/** 不可重试的坏请求（400/413/422、上下文超限、参数不合法等）——立即抛出，不浪费重试。 */
export class LlmNonRetriableRequestError extends Error {
  readonly attempts: number;
  readonly status?: number;
  readonly reason: string;
  constructor(
    message: string,
    attempts: number,
    options: { status?: number; reason?: string } = {},
  ) {
    super(message);
    this.name = "LlmNonRetriableRequestError";
    this.attempts = attempts;
    this.status = options.status;
    this.reason = options.reason ?? "bad_request";
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
  onEvent?: (ev: {
    kind: "retry" | "timeout" | "exhausted" | "ok" | "rate-limit" | "bad-request";
    attempt: number;
    detail?: string;
    retryAfterMs?: number | null;
    status?: number;
  }) => void;
}

const DEFAULTS: Required<Omit<ResilienceOptions, "onEvent">> = {
  maxAttempts: 3,
  perAttemptTimeoutMs: 90_000,
  backoffBaseMs: 1000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从错误消息里提取 HTTP 状态码（如 "状态 429"、"status 503" 或裸 4xx/5xx）。 */
export function extractStatusCode(msg: string): number | null {
  const match =
    msg.match(/(?:状态|status)\s*([45]\d{2})/i) ??
    msg.match(/\b(400|408|409|413|422|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

/** 从错误消息里解析 Retry-After（支持 ms/s/min 单位），返回毫秒。 */
export function extractRetryAfterMs(msg: string): number | null {
  const match = msg.match(
    /retry[-\s]?after[:=\s]*([0-9]+)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit.startsWith("ms")) return value;
  if (unit === "m" || unit.startsWith("min")) return value * 60_000;
  return value * 1000;
}

export interface ErrorClassification {
  status: number | null;
  retryAfterMs: number | null;
  isRateLimited: boolean;
  isNonRetriableBadRequest: boolean;
  badRequestReason: string;
}

/** 错误分类：判断是限流、不可重试坏请求（上下文超限/请求过大/参数非法）还是普通可重试错误。 */
export function classifyError(msg: string): ErrorClassification {
  const status = extractStatusCode(msg);
  const retryAfterMs = extractRetryAfterMs(msg);
  const normalized = msg.toLowerCase();
  const isRateLimited =
    status === 429 ||
    /rate.?limit|too many requests|quota|requests per min|tokens per min|rpm|tpm/.test(normalized);
  const isContextTooLarge =
    /context length|maximum context|too many tokens|prompt too long|maximum tokens|上下文.*过长|上下文.*超限/.test(normalized);
  const isRequestTooLarge =
    status === 413 || /request entity too large|payload too large|请求体过大/.test(normalized);
  const isBadRequestWord =
    /bad request|invalid request|参数不合法|schema|response_format|messages.*invalid|tool.*invalid/.test(normalized);
  const isNonRetriableBadRequest =
    status === 400 ||
    status === 413 ||
    status === 422 ||
    isContextTooLarge ||
    isRequestTooLarge ||
    isBadRequestWord;
  const badRequestReason = isContextTooLarge
    ? "context_too_large"
    : isRequestTooLarge
      ? "request_too_large"
      : /invalid request|参数不合法/.test(normalized)
        ? "invalid_request"
        : "bad_request";
  return { status, retryAfterMs, isRateLimited, isNonRetriableBadRequest, badRequestReason };
}

/** 普通错误的指数退避等待：base * 2^(n-1) + 抖动。 */
export function computeRetryWaitMs(baseMs: number, attempt: number): number {
  return baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
}

/** 限流错误的退避等待：取 floor、retry-after、指数退避三者最大值 + 更大抖动。 */
export function computeRateLimitWaitMs(
  baseMs: number,
  attempt: number,
  retryAfterMs: number | null,
): number {
  const floor = Math.max(250, baseMs * 4);
  const exponential = floor * Math.pow(2, Math.max(0, attempt - 1));
  const advised = retryAfterMs ?? 0;
  return Math.max(floor, advised, exponential) + Math.floor(Math.random() * 750);
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

  /** 通用执行：重试 + 超时围栏 + 限流冷却 + 坏请求快速失败。 */
  private async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    let lastRateLimit: { retryAfterMs: number | null; status?: number; detail: string } | null = null;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        const result = await withTimeout(fn(), this.opts.perAttemptTimeoutMs, `${label} 第${attempt}次`);
        if (attempt > 1) this.onEvent?.({ kind: "ok", attempt, detail: "重试后成功" });
        return result;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const meta = classifyError(msg);
        // 不可重试的坏请求：立即抛出，不浪费后续重试
        if (meta.isNonRetriableBadRequest && !meta.isRateLimited) {
          this.onEvent?.({ kind: "bad-request", attempt, detail: msg.slice(0, 160), status: meta.status ?? 400 });
          throw new LlmNonRetriableRequestError(
            `LLM 请求不可重试（${meta.status ?? 400}）：${msg}`,
            attempt,
            { status: meta.status ?? 400, reason: meta.badRequestReason },
          );
        }
        if (meta.isRateLimited) {
          lastRateLimit = { retryAfterMs: meta.retryAfterMs, status: meta.status ?? undefined, detail: msg };
          this.onEvent?.({ kind: "rate-limit", attempt, detail: msg.slice(0, 160), retryAfterMs: meta.retryAfterMs ?? undefined, status: meta.status ?? 429 });
        } else {
          const isTimeout = /超时|timeout|abort/i.test(msg);
          this.onEvent?.({ kind: isTimeout ? "timeout" : "retry", attempt, detail: msg.slice(0, 160) });
        }
        if (attempt < this.opts.maxAttempts) {
          const wait = meta.isRateLimited
            ? computeRateLimitWaitMs(this.opts.backoffBaseMs, attempt, meta.retryAfterMs)
            : computeRetryWaitMs(this.opts.backoffBaseMs, attempt);
          await sleep(wait);
        }
      }
    }
    if (lastRateLimit) {
      throw new LlmRateLimitedError(
        `LLM 调用连续 ${this.opts.maxAttempts} 次触发限流/配额：${lastRateLimit.detail}`,
        this.opts.maxAttempts,
        { retryAfterMs: lastRateLimit.retryAfterMs, status: lastRateLimit.status ?? 429 },
      );
    }
    this.onEvent?.({ kind: "exhausted", attempt: this.opts.maxAttempts, detail: lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr) });
    throw new LlmExhaustedError(
      `LLM 调用连续 ${this.opts.maxAttempts} 次失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      this.opts.maxAttempts,
    );
  }
}
