/**
 * 密钥经纪 · 独立进程入口（Phase 2a）。
 *
 * 用法（在 wenluDemo 目录）：
 *   tsx src/broker/start.ts
 * 需要环境变量：LLM 密钥/端点（与原 .env 同）+ WENLU_BROKER_TOKEN（鉴权）。
 *
 * 进程定位：可信侧，持 LLM 密钥；大脑进程经 WENLU_BROKER_URL 调它，自身不持密钥。
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── 加载 .env（同步，确保后续读取到密钥）───
const __dirname_b = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = resolvePath(__dirname_b, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* 无 .env 则依赖系统环境 */ }

const { startLlmBroker } = await import("./llmBroker.js");

const handle = await startLlmBroker();
console.log(`[broker] LLM 经纪已就绪 http://127.0.0.1:${handle.port}（大脑经此调用，不持 LLM 密钥）`);

process.on("SIGINT", () => { void handle.close().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void handle.close().then(() => process.exit(0)); });
