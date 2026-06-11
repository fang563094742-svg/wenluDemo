/**
 * proactive-awareness-demo —— GPT-5.4 LLM Provider 实现（任务 5.2）。
 *
 * 设计依据：design.md「分析层（R5-R7）→ LLM_Provider 接口契约（R6）→ Gpt54Provider」。
 *
 * 职责：
 *  - 提供 `LLM_Provider` 的 GPT-5.4 实现 `Gpt54Provider`：
 *    - `complete`：自由文本 / 受 JSON schema 约束的结构化输出（用于 Analyzer / Clarifier）。
 *    - `completeWithTools`：原生 tool-calling（function calling），供 Executor 执行循环使用。
 *  - 调用 OpenAI 兼容的 Chat Completions 接口（`POST {baseURL}/chat/completions`），
 *    使用 Node v22 内置的全局 `fetch`，不引入任何额外 HTTP 依赖。
 *
 * 流式说明（Bug 6 修复）：
 *  - 目标端点（OpenAI 兼容中转，如 `https://code.oai1.online/v1`）在**非流式**请求
 *    （无 `stream` 或 `stream:false`）时会返回 HTTP 200，但响应体是一个 `choices: []`
 *    的空流式 chunk（仅含 usage），模型一个 token 都不产出 → 旧的非流式解析拿到空
 *    choices 直接失败。
 *  - 唯有 `stream: true` 时该端点才真正产出内容（标准 OpenAI SSE 流：逐个 `delta.content`
 *    片段 + 末尾 `data: [DONE]`）。
 *  - 故本实现一律以 `stream: true` 请求，并按 SSE 逐行解析、把所有 `delta.content`
 *    拼接成完整文本；tool-calling 路径按 `index` 累积 `delta.tool_calls`（name 取首次
 *    出现值、arguments 为分片字符串需顺序拼接）。
 *
 * 安全约束：
 *  - API key **绝不硬编码**：默认经 `config.readApiKey` 从环境变量读取
 *    （`OPENAI_API_KEY` 优先、`GPT_API_KEY` 次选），也允许由 composition root 显式注入
 *    （注入值同样来自 config，不在源码出现明文 key）。缺失时构造即抛描述性错误（R6.2/R6.3）。
 *  - 调用失败（网络错误 / 非 2xx 响应 / 响应不可解析）立即抛出带描述性信息的
 *    `Gpt54ProviderError`，由上层（Analyzer / Executor / Orchestrator）捕获后转 `error`
 *    状态并保持服务运行（R6.5）。
 *
 * _Requirements: 6.2, 6.4, 6.5_
 */

import { readApiKey, readBaseUrl, readModel } from "../config/config.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmMessage,
  ToolSpec,
} from "./llmProvider.js";

// ===========================================================================
// 合理默认值（model 名、baseURL、超时均可配置）
// ===========================================================================

/** 默认 provider key / 模型名（R6 示例为 "gpt-5.4"）。 */
export const DEFAULT_GPT54_MODEL = "gpt-5.4";

/** 默认 OpenAI 兼容 API base URL（可经 options.baseURL 或环境变量覆盖）。 */
export const DEFAULT_GPT54_BASE_URL = "https://api.openai.com/v1";

/** 默认请求超时（毫秒）。超时即中止请求并抛描述性错误，避免挂死调用方。 */
export const DEFAULT_GPT54_TIMEOUT_MS = 120_000;

// ===========================================================================
// 错误类型
// ===========================================================================

/**
 * GPT-5.4 调用阶段的描述性错误（非致命）。
 *
 * 由 `complete` / `completeWithTools` 在调用失败时抛出；上层捕获后转 `error` 状态、
 * 向用户返回描述性信息并保持服务运行（R6.5）。
 */
export class Gpt54ProviderError extends Error {
  /** 若由非 2xx HTTP 响应触发，记录其状态码（便于诊断）。 */
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "Gpt54ProviderError";
    this.status = options?.status;
  }
}

// ===========================================================================
// 构造选项
// ===========================================================================

/** `Gpt54Provider` 构造选项（均可选，带合理默认）。 */
export interface Gpt54ProviderOptions {
  /**
   * 显式注入的 API key（应来自 config，源码不得出现明文 key）。
   * 缺省时经 `readApiKey(env)` 从环境变量读取（`OPENAI_API_KEY` 优先、`GPT_API_KEY` 次选）。
   */
  apiKey?: string;
  /** 模型名，默认 {@link DEFAULT_GPT54_MODEL}（"gpt-5.4"）；缺省时回退环境变量 `WENLU_LLM_MODEL`。 */
  model?: string;
  /**
   * OpenAI 兼容 API base URL；缺省时回退环境变量 `WENLU_LLM_BASE_URL`，再回退
   * {@link DEFAULT_GPT54_BASE_URL}。末尾斜杠会被规范化。
   */
  baseURL?: string;
  /** 请求超时（毫秒），默认 {@link DEFAULT_GPT54_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 环境变量来源（注入便于测试），默认 `process.env`。仅在未显式提供 `apiKey` 时使用。 */
  env?: NodeJS.ProcessEnv;
  /** fetch 实现（注入便于测试 / 离线单测），默认全局 `fetch`（Node v22 内置）。 */
  fetchImpl?: typeof fetch;
}

// ===========================================================================
// OpenAI 兼容 Chat Completions 请求/响应的最小形状
// ===========================================================================

/** assistant 消息回灌时携带的单个 tool call 的 OpenAI 形状。 */
interface ChatToolCallPayload {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessagePayload {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  /** 当 assistant 本轮发起工具调用时，按 OpenAI 协议回灌其 tool_calls。 */
  tool_calls?: ChatToolCallPayload[];
}

interface ChatToolPayload {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessagePayload[];
  /**
   * 流式开关。本端点在非流式时返回空 choices 流帧（见文件顶部说明），故一律置 true 并解析 SSE。
   */
  stream?: boolean;
  temperature?: number;
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: object };
  };
  tools?: ChatToolPayload[];
  tool_choice?: "auto";
}

/** 归一化后的单个 tool call 形状（供 parseToolCalls 复用）。 */
interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** 流式 chunk 中单个 tool_call 增量片段的最小形状。 */
interface RawToolCallDelta {
  /** 同一 tool call 的多个片段以 index 关联累积。 */
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** 流式 chunk 中 choices[0].delta 的最小形状。 */
interface RawDelta {
  content?: unknown;
  tool_calls?: unknown;
}

/** 非流式 chunk 中 choices[0].message 的最小形状（端点若回退为非流式仍可解析）。 */
interface RawChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
}

/** SSE chunk 中单个 choice 的最小形状（兼容流式 delta 与非流式 message）。 */
interface RawChoice {
  delta?: RawDelta;
  message?: RawChoiceMessage;
  finish_reason?: unknown;
}

/** 单个 SSE chunk（`chat.completion.chunk` 或非流式 completion）的最小形状。 */
export interface SseChunk {
  choices?: RawChoice[];
  usage?: unknown;
}

/**
 * 流式聚合结果。
 *  - `content`：所有 `delta.content`（或非流式 `message.content`）拼接后的完整文本。
 *  - `toolCalls`：累积/解析后的工具调用（arguments 已由 JSON 字符串解析为对象）。
 */
export interface ParsedSseStream {
  content: string;
  toolCalls: NonNullable<LlmToolResponse["toolCalls"]>;
}

// ===========================================================================
// Gpt54Provider
// ===========================================================================

/**
 * `LLM_Provider` 的 GPT-5.4 实现，调用 OpenAI 兼容 Chat Completions 接口（流式）。
 *
 * 使用示例（composition root，任务 17.1）：
 * ```ts
 * providerRegistry.register("gpt-5.4", new Gpt54Provider());        // 从环境变量读取 key
 * providerRegistry.register("gpt-5.4", new Gpt54Provider({ apiKey })); // 或由 config 注入
 * ```
 */
export class Gpt54Provider implements LLM_Provider {
  readonly providerKey: string;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Gpt54ProviderOptions = {}) {
    // API key：优先显式注入（来自 config），否则经 readApiKey 从环境变量读取（R6.2/R6.3）。
    const injected = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    if (injected.length > 0) {
      this.apiKey = injected;
    } else {
      const result = readApiKey(options.env ?? process.env);
      if (!result.ok) {
        // 缺失则以描述性错误立即失败（供 composition root 优雅终止启动，R6.4）。
        throw new Gpt54ProviderError(result.error);
      }
      this.apiKey = result.apiKey;
    }

    // env 源：与 apiKey 一致用 options.env ?? process.env（注入便于测试）。
    const env = options.env ?? process.env;

    // model 解析优先级：显式 options.model > 环境变量 WENLU_LLM_MODEL > 默认值（R6 Bug 7）。
    this.model = options.model?.trim() || readModel(env) || DEFAULT_GPT54_MODEL;
    this.providerKey = this.model;
    // baseURL 解析优先级：显式 options.baseURL > 环境变量 WENLU_LLM_BASE_URL > 默认值（Bug 7）。
    this.baseURL = normalizeBaseUrl(
      options.baseURL ?? readBaseUrl(env) ?? DEFAULT_GPT54_BASE_URL,
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GPT54_TIMEOUT_MS;

    const resolvedFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof resolvedFetch !== "function") {
      throw new Gpt54ProviderError(
        "当前运行环境缺少全局 fetch（需要 Node v22+ 或注入 fetchImpl）。",
      );
    }
    this.fetchImpl = resolvedFetch;
  }

  /**
   * 自由文本 / 受 JSON schema 约束的结构化输出（R6 complete）。
   * `jsonSchema` 非空时通过 `response_format: { type: "json_schema" }` 约束模型输出 JSON。
   * 一律以 stream:true 请求并解析 SSE 流，把所有 `delta.content` 拼成最终文本。
   */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: ChatCompletionRequestBody = {
      model: this.model,
      messages: toChatMessages(req),
      stream: true,
    };
    if (typeof req.temperature === "number") {
      body.temperature = req.temperature;
    }
    if (req.jsonSchema && typeof req.jsonSchema === "object") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "structured_output", schema: req.jsonSchema },
      };
    }

    const acc = await this.streamChatCompletions(body);
    return { text: acc.content, raw: undefined };
  }

  /**
   * 原生 tool-calling（R6 completeWithTools）。模型要么返回待执行的 tool calls，
   * 要么返回最终文本（任务完成信号）。一律以 stream:true 请求并解析 SSE 流。
   */
  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    const body: ChatCompletionRequestBody = {
      model: this.model,
      messages: toChatMessages(req),
      tools: toChatTools(req.tools),
      tool_choice: "auto",
      stream: true,
    };
    if (typeof req.temperature === "number") {
      body.temperature = req.temperature;
    }
    // 注意：tool-calling 路径不附加 response_format（Bug 3 修复）。该 OpenAI 兼容端点不接受
    // tools 与 response_format 并存（会返回 400 Bad Request）；工具参数的结构由各
    // tool 的 parameters schema 约束，无需顶层 response_format。

    const acc = await this.streamChatCompletions(body);
    if (acc.toolCalls.length > 0) {
      return { toolCalls: acc.toolCalls };
    }
    return { finalText: acc.content };
  }

  /**
   * 向 `{baseURL}/chat/completions` 发起一次流式请求，逐块读取并解析 SSE，
   * 累积 `delta.content` 与 `delta.tool_calls`。处理超时、非 2xx 与读取/解析失败。
   * 任何失败均抛描述性 `Gpt54ProviderError`（R6.5）。
   */
  private async streamChatCompletions(
    body: ChatCompletionRequestBody,
  ): Promise<ParsedSseStream> {
    const url = `${this.baseURL}/chat/completions`;
    // DEBUG: log request shape (best-effort, never throw)
    try {
      const fs2 = await import("node:fs");
      fs2.appendFileSync("/tmp/wenlu_sse_raw.log", `\n--- REQUEST ${new Date().toISOString()} ---\nmodel=${body.model} msgs=${body.messages?.length} tools=${body.tools?.length ?? 0} stream=${body.stream}\nmsg[0].role=${body.messages?.[0]?.role} msg[0].content.len=${typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content.length : 'non-str'}\n`);
    } catch { /* best-effort debug log */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const reason =
        cause instanceof Error && cause.name === "AbortError"
          ? `请求超时（>${this.timeoutMs}ms）`
          : describeError(cause);
      throw new Gpt54ProviderError(
        `调用 GPT-5.4（${this.model}）失败：${reason}。`,
        { cause },
      );
    }

    if (!response.ok) {
      const detail = await safeReadBody(response);
      clearTimeout(timer);
      throw new Gpt54ProviderError(
        `调用 GPT-5.4（${this.model}）返回非成功状态 ${response.status} ${response.statusText}。${detail}`,
        { status: response.status },
      );
    }

    try {
      const rawSse = await readStreamToText(response);
      // DEBUG: dump raw SSE to file (best-effort, never throw)
      try {
        const fs3 = await import("node:fs");
        fs3.appendFileSync("/tmp/wenlu_sse_raw.log", `\n=== ${new Date().toISOString()} rawSse len=${rawSse.length} ===\n${rawSse.slice(0, 2000)}\n`);
      } catch { /* best-effort debug log */ }
      const parsed = parseSseStream(rawSse);
      try {
        const fs3 = await import("node:fs");
        fs3.appendFileSync("/tmp/wenlu_sse_raw.log", `parsed: content="${parsed.content.slice(0,200)}" toolCalls=${parsed.toolCalls.length}\n`);
      } catch { /* best-effort debug log */ }
      return parsed;
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === "AbortError"
          ? `请求超时（>${this.timeoutMs}ms）`
          : describeError(cause);
      throw new Gpt54ProviderError(
        `读取/解析 GPT-5.4（${this.model}）流式响应失败：${reason}。`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ===========================================================================
// 纯辅助函数（请求映射）
// ===========================================================================

/** 规范化 base URL：去除末尾斜杠（避免拼出 `//chat/completions`）。 */
function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

/**
 * 把 `LlmRequest` 映射为 OpenAI 兼容 messages。
 *  - 非空 `system` 段映射为首条 `system` 消息。
 *  - `tool` 角色消息携带 `tool_call_id`（来自工具结果回灌，配合 completeWithTools）。
 */
export function toChatMessages(req: LlmRequest): ChatMessagePayload[] {
  const messages: ChatMessagePayload[] = [];
  if (typeof req.system === "string" && req.system.trim().length > 0) {
    // 只转发上层显式提供的 system 法源；provider 不再偷偷追加统一身份锁，
    // 避免生成顺序里混入隐藏默认法源，导致回复残留通用模板味与 fallback 惯性。
    messages.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) {
    messages.push(toChatMessage(m));
  }
  return messages;
}

/** 映射单条消息；`tool` 角色保留其 `tool_call_id`；带 `toolCalls` 的 assistant 回灌 tool_calls。 */
function toChatMessage(m: LlmMessage): ChatMessagePayload {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
  }
  // assistant 本轮发起工具调用：按 OpenAI 协议把 tool_calls 一并回灌，
  // 使后续 role:"tool" 结果消息有声明该 tool_call 的 assistant 前驱（否则端点返回 400）。
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** 把 ToolSpec[] 映射为 OpenAI function-calling 的 tools 声明。 */
export function toChatTools(tools: ToolSpec[]): ChatToolPayload[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ===========================================================================
// 纯辅助函数（SSE 流解析 —— 可独立单测）
// ===========================================================================

/**
 * 读取一个流式 `Response` 的 body 为完整 SSE 文本。
 *
 * 兼容 Node v22 fetch 的 web `ReadableStream`：用 `getReader()` + `TextDecoder` 逐块解码。
 * 若运行环境提供的 Response 不带可读 body（极少数注入替身），回退用 `response.text()`。
 */
export async function readStreamToText(response: Response): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    // 退化路径：直接读全文（注入替身或非流式 body）。
    return await response.text();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/**
 * 把一段 SSE 文本解析为 chunk 对象数组。
 *
 * SSE 规则（够用子集）：
 *  - 行以 `\n` 分隔；`data:` 行携带载荷，`data:` 后可有或没有空格。
 *  - `data: [DONE]` 为结束哨兵，跳过（不产出 chunk）。
 *  - 非 `data:` 行（如 `event:`、注释 `:`、`id:`）与空行忽略。
 *  - 单个 data 行若非合法 JSON 则安全跳过（不抛错）。
 *
 * 说明：本端点每个 SSE event 的 JSON 都在单个 `data:` 行内（不跨行），故按行解析即可，
 * 同时兼容事件间的空行/注释行。
 */
export function parseSseEvents(rawSse: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  const normalized = rawSse.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const line of normalized.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value = line.slice("data:".length);
    if (value.startsWith(" ")) value = value.slice(1);
    if (value.trim() === "[DONE]") continue;
    if (value.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue; // 非 JSON data 行安全跳过
    }
    if (typeof parsed === "object" && parsed !== null) {
      chunks.push(parsed as SseChunk);
    }
  }
  return chunks;
}

/**
 * 解析并聚合一段 SSE 流文本（Bug 6 的核心纯函数，可独立单测）。
 *
 * 行为：
 *  - 拼接所有 `choices[0].delta.content`（流式）或 `choices[0].message.content`（非流式回退）。
 *  - 按 `index` 累积 `delta.tool_calls` 分片（name/id 取首次出现值、arguments 顺序拼接），
 *    或解析非流式 `message.tool_calls`。
 *  - `choices: []`（仅含 usage 的 chunk）、`[DONE]`、空行、注释行、坏 JSON 行均安全跳过。
 *  - arguments 字符串经 JSON 解析为对象（失败回退 `{ _raw }`）。
 *
 * @returns `{ content, toolCalls }`
 */
export function parseSseStream(rawSse: string): ParsedSseStream {
  const chunks = parseSseEvents(rawSse);
  let content = "";

  for (const chunk of chunks) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue; // 仅 usage 的空 choices chunk
    const choice = choices[0];
    // 流式：delta.content；非流式回退：message.content。
    const delta = choice?.delta;
    if (delta && typeof delta.content === "string") {
      content += delta.content;
    } else if (choice?.message && typeof choice.message.content === "string") {
      content += choice.message.content;
    }
  }

  const toolCalls = parseToolCalls(accumulateToolCallDeltas(chunks));
  return { content, toolCalls };
}

/**
 * 便捷封装：直接把一段 SSE 文本拼接为最终文本（供单测/调用方使用）。仅取 content。
 */
export function parseSseStreamToText(rawSse: string): string {
  return parseSseStream(rawSse).content;
}

/**
 * 按 `index` 累积流式 `delta.tool_calls` 分片为归一化的 tool calls；同时兼容非流式
 * `message.tool_calls`（整条直接采纳）。
 *  - `id` / `function.name`：取首次出现的非空值。
 *  - `function.arguments`：为分片字符串，按到达顺序拼接。
 *  - 缺省 index 时回退为出现序号（容错）。
 * 产出按 index 升序排列、且至少出现过 name 或 arguments 的项。
 */
export function accumulateToolCallDeltas(chunks: SseChunk[]): RawToolCall[] {
  // index -> 累积状态
  const acc = new Map<number, { id: string; name: string; args: string; seen: boolean }>();
  let fallbackIndex = 0;
  // 非流式 message.tool_calls（无需累积，直接收集）。
  const nonStreaming: RawToolCall[] = [];

  for (const chunk of chunks) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = choices[0];

    // 非流式回退：message.tool_calls 整条采纳。
    const messageToolCalls = choice?.message?.tool_calls;
    if (Array.isArray(messageToolCalls)) {
      for (const tc of messageToolCalls as RawToolCall[]) {
        nonStreaming.push(tc);
      }
    }

    const delta = choice?.delta;
    const rawToolCalls = delta?.tool_calls;
    if (!Array.isArray(rawToolCalls)) continue;

    for (const rawDelta of rawToolCalls as RawToolCallDelta[]) {
      const index =
        typeof rawDelta.index === "number" && Number.isInteger(rawDelta.index)
          ? rawDelta.index
          : fallbackIndex;
      let entry = acc.get(index);
      if (!entry) {
        entry = { id: "", name: "", args: "", seen: false };
        acc.set(index, entry);
        fallbackIndex = Math.max(fallbackIndex, index + 1);
      }
      if (typeof rawDelta.id === "string" && rawDelta.id.length > 0 && entry.id.length === 0) {
        entry.id = rawDelta.id;
        entry.seen = true;
      }
      const fn = rawDelta.function;
      if (fn) {
        if (typeof fn.name === "string" && fn.name.length > 0 && entry.name.length === 0) {
          entry.name = fn.name;
          entry.seen = true;
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          entry.args += fn.arguments;
          entry.seen = true;
        }
      }
    }
  }

  if (nonStreaming.length > 0) {
    return nonStreaming;
  }

  return [...acc.entries()]
    .filter(([, e]) => e.seen)
    .sort(([a], [b]) => a - b)
    .map(([, e]) => ({
      id: e.id,
      function: { name: e.name, arguments: e.args },
    }));
}

// ===========================================================================
// 纯辅助函数（tool_calls 归一化解析）
// ===========================================================================

/**
 * 解析（累积后的）`tool_calls` 数组为 `LlmToolResponse.toolCalls`。
 * 非数组 / 空数组返回空数组；逐项解析 function.name 与 function.arguments（JSON 字符串）。
 */
export function parseToolCalls(
  raw: unknown,
): NonNullable<LlmToolResponse["toolCalls"]> {
  if (!Array.isArray(raw)) return [];
  const result: NonNullable<LlmToolResponse["toolCalls"]> = [];
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i] as RawToolCall;
    const name = typeof tc.function?.name === "string" ? tc.function.name : "";
    if (name.length === 0) continue; // 无工具名的项无法执行，跳过
    const id = typeof tc.id === "string" && tc.id.length > 0 ? tc.id : `call_${i}`;
    result.push({ id, name, arguments: parseToolArguments(tc.function?.arguments) });
  }
  return result;
}

/**
 * 解析 tool call 的 arguments：OpenAI 以 JSON 字符串返回。
 * 解析失败或非对象时退化为空对象（保留原始串于 `_raw` 便于诊断），避免调用方崩溃。
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** 读取非 2xx 响应体片段用于错误信息（容错，最多截取 500 字符）。 */
async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.trim().length === 0) return "";
    return ` 响应体：${text.slice(0, 500)}`;
  } catch {
    return "";
  }
}

/** 把未知错误对象转为可读字符串（用于描述性错误信息）。 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
