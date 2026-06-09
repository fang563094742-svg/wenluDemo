/**
 * LLM Provider —— 大语言模型调用的可插拔接口与类型（R6）。
 *
 * 设计依据：design.md「分析层（R5-R7）→ LLM_Provider 接口契约（R6）」。
 *
 * 本模块只定义接口与类型契约（业务模块仅依赖这些抽象，不依赖具体供应方实现，
 * 满足 R6.1）。GPT-5.4 的具体实现 `Gpt54Provider` 见任务 5.2 / `gpt54Provider.ts`。
 *
 * _Requirements: 6.1_
 */

/**
 * 对话消息角色。
 *
 * 注：`LlmRequest.system` 已单独承载 system 段，故常规请求的 `messages` 通常只含
 * `user`/`assistant`；`tool` 角色用于 Executor tool-calling 循环中把工具执行结果
 * 回灌给模型（配合 `LlmToolResponse.toolCalls`）。仍保留 `system` 以备灵活使用。
 */
export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

/** 单条对话消息。 */
export interface LlmMessage {
  role: LlmMessageRole;
  /**
   * 消息文本内容。允许为空串（如 assistant 仅发起 tool_calls 而无文本时，content 为 ""）。
   */
  content: string;
  /**
   * 当 `role === "tool"` 时，关联其对应 tool call 的 id（来自
   * `LlmToolResponse.toolCalls[].id`），用于把工具结果回灌给模型时建立对应关系。
   */
  toolCallId?: string;
  /**
   * 当 `role === "assistant"` 且本轮模型请求了工具调用时，承载该轮 tool calls，
   * 以便按 OpenAI 兼容协议把 assistant 的 tool_calls 回灌给模型。
   *
   * 协议约束：每条 `role:"tool"` 结果消息之前，必须有一条声明了对应 tool_call 的
   * `role:"assistant"` 消息（带 `tool_calls`），否则会出现"孤立的 tool 消息"导致端点
   * 返回 400。Executor 执行循环据此在执行工具前先回灌本轮 assistant.tool_calls。
   */
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/**
 * 供 LLM 原生 tool-calling 的工具声明（来自 ToolRegistry 中各 Executor_Tool 的 `spec`）。
 * `parameters` 为该工具入参的 JSON schema，供模型生成符合约束的调用参数。
 */
export interface ToolSpec {
  /** 工具名（注册表 key，对应 `Executor_Tool.name`，如 "read_file"）。 */
  name: string;
  /** 工具用途说明，供模型决策是否/如何调用。 */
  description: string;
  /** 工具入参的 JSON schema。 */
  parameters: object;
}

/** 通用补全请求（自由文本或受 schema 约束的结构化输出）。 */
export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  /** 非空时要求模型返回符合该 schema 的 JSON。 */
  jsonSchema?: object;
  temperature?: number;
}

/** 通用补全响应。 */
export interface LlmResponse {
  /**
   * 模型输出文本。当请求带 `jsonSchema` 时，此处为符合该 schema 的 JSON 字符串，
   * 由调用方负责 `JSON.parse` 并校验。
   */
  text: string;
  /** 供应方原始响应载荷（可选，便于调试与按需扩展）。 */
  raw?: unknown;
}

/** tool-calling 请求，在通用请求基础上携带可用工具声明。 */
export interface LlmToolRequest extends LlmRequest {
  /** 来自 ToolRegistry 的工具声明。 */
  tools: ToolSpec[];
}

/** tool-calling 响应：模型要么返回待执行的 tool calls，要么返回最终文本（任务完成信号）。 */
export interface LlmToolResponse {
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  finalText?: string;
}

/**
 * 大语言模型调用的可插拔接口（R6.1）。
 *
 * 第一版实现为 GPT-5.4（`Gpt54Provider`，任务 5.2）。新增/更换供应方只需提供新的
 * 实现并注册到 ProviderRegistry，调用方接口契约不变（R17.3）。
 */
export interface LLM_Provider {
  /** 供应方标识，用于注册表 key，如 "gpt-5.4"。 */
  readonly providerKey: string;

  /**
   * 自由文本 / JSON 输出。`jsonSchema` 非空时要求模型返回符合该 schema 的 JSON。
   * @throws 调用失败时立即返回带描述性错误信息的失败（R6.5）。
   */
  complete(req: LlmRequest): Promise<LlmResponse>;

  /**
   * 原生 tool-calling，供 Executor 执行循环使用。
   * @throws 调用失败时立即返回带描述性错误信息的失败（R6.5）。
   */
  completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse>;
}
