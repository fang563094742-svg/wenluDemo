/** 临时探针：用大请求体（模拟真实扫描摘要）跑 complete，复现 fetch failed。 */
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
  timeoutMs: 120000,
});

// 构造一个含大量文件名的大 prompt（模拟真实扫描摘要规模）。
const files: string[] = [];
for (let i = 0; i < 3000; i++) files.push(`file_${i}_SKILL.md openai.yaml plugin.json app-icon.png`);
const bigContent = "以下是扫描到的文件清单，请分析：\n" + files.join("\n");
console.log("[probeBig] prompt 字节数 ≈", Buffer.byteLength(bigContent));

async function main() {
  try {
    const res = await provider.complete({
      system: "你是助手，只回复两个字：收到",
      messages: [{ role: "user", content: bigContent }],
    });
    console.log("[probeBig] OK text=", JSON.stringify(res.text.slice(0, 100)));
  } catch (err) {
    console.log("[probeBig] FAILED:", err instanceof Error ? err.message : String(err));
    const cause = (err as { cause?: unknown }).cause;
    if (cause) {
      console.log("[probeBig] cause:", cause instanceof Error ? cause.message : String(cause));
      const deep = (cause as { cause?: unknown }).cause;
      if (deep) console.log("[probeBig] cause.cause:", deep instanceof Error ? deep.message : String(deep));
    }
  }
}
void main();
