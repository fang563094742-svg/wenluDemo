/**
 * 问路 — 多用户网关启动入口。
 *
 *   npx tsx src/gateway/start.ts
 * 环境变量：
 *   WENLU_GATEWAY_PORT（默认 3200）、WENLU_GW_CHILD_BASE_PORT（默认 4100）、
 *   WENLU_GW_MAX_PROCS（默认 20）、WENLU_GW_IDLE_MS（默认 30min）、WENLU_GW_HEALTH_MS（默认 60s）。
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "./gateway.js";

// 自动加载 .env（与 riverMain 一致，供子进程继承 LLM key 等）。
const __dirname_s = dirname(fileURLToPath(import.meta.url));
try {
  const envContent = await readFile(resolvePath(__dirname_s, "../../.env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* 无 .env 跳过 */ }

const gw = await startGateway();
console.log(`[问路网关] 多用户入口已启动 http://0.0.0.0:${gw.port} | 健康 /gw/health`);
