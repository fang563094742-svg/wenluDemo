/** 临时探针（非交付物）：用真实 Gpt54Provider 直连端点跑一次 complete，打印完整错误链。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Gpt54Provider } from "../src/llm/gpt54Provider.js";

const envText = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.trim();
}

const provider = new Gpt54Provider({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.WENLU_LLM_BASE_URL,
  model: env.WENLU_LLM_MODEL,
  timeoutMs: 60000,
});

async function main() {
  console.log("[probe] baseURL=", env.WENLU_LLM_BASE_URL, "model=", env.WENLU_LLM_MODEL);
  try {
    const res = await provider.complete({
      system: "你是助手。",
      messages: [{ role: "user", content: "只回复两个字：连通" }],
    });
    console.log("[probe] OK text=", JSON.stringify(res.text));
  } catch (err) {
    console.log("[probe] FAILED:", err instanceof Error ? err.message : String(err));
    const cause = (err as { cause?: unknown }).cause;
    if (cause) {
      console.log("[probe] cause:", cause instanceof Error ? cause.message : String(cause));
      const deep = (cause as { cause?: unknown }).cause;
      if (deep) console.log("[probe] cause.cause:", deep instanceof Error ? deep.message : String(deep));
    }
  }
}
void main();
