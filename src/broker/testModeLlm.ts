import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../llm/llmProvider.js";

function buildJsonStub(req: LlmRequest): string {
  const schema = req.jsonSchema;
  if (!schema || typeof schema !== "object") {
    return JSON.stringify({ ok: true });
  }
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const type = typeof value === "object" && value && "type" in value ? (value as { type?: string }).type : undefined;
    if (type === "array") out[key] = [];
    else if (type === "boolean") out[key] = false;
    else if (type === "number" || type === "integer") out[key] = 0;
    else if (type === "object") out[key] = {};
    else out[key] = "";
  }
  return JSON.stringify(out);
}

export class TestModeLlmProvider implements LLM_Provider {
  readonly providerKey = "test-mode";

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return {
      text: buildJsonStub(req),
      raw: { mode: "test" },
    };
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    const firstTool = req.tools[0];
    if (firstTool) {
      return {
        toolCalls: [
          {
            id: "test-call-1",
            name: firstTool.name,
            arguments: {},
          },
        ],
      };
    }
    return { finalText: "test-mode" };
  }
}
