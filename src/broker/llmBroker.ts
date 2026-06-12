/**
 * 密钥经纪 · LLM 经纪（Phase 2a）
 * ------------------------------------------------------------------
 * 第一性："拿不到就泄露不了"的进程级落地。LLM 密钥/中转端点只存在于**经纪进程**，
 * 大脑进程(riverMain)经本机 HTTP 调经纪的能力接口，自身不持有任何 LLM 密钥。
 *
 * 经纪职责：
 *  - 持有 LLM 密钥与端点（与 riverMain 同样的池构造：主中转→备用→直连→本地兜底）。
 *  - 暴露能力接口（仅本机、Bearer 鉴权）：
 *      POST /broker/llm/complete            —— 通用补全
 *      POST /broker/llm/complete-with-tools —— 原生 tool-calling
 *      GET  /broker/health                  —— 健康检查（不鉴权）
 *  - 绝不在任何响应里回传密钥；上游错误信息按需截断。
 *
 * 安全：仅绑定 127.0.0.1；无 WENLU_BROKER_TOKEN 拒绝启动（不裸奔）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { validateApiKey, readBackupEndpoint, readLocalEndpoint } from "../config/config.js";
import { Gpt54Provider } from "../llm/gpt54Provider.js";
import { ResilientLlm } from "../llm/resilientLlm.js";
import { LlmPool, type LlmPoolMember } from "../llm/llmPool.js";
import { buildProxyFetch } from "../llm/proxyFetch.js";
import type { LLM_Provider, LlmRequest, LlmToolRequest } from "../llm/llmProvider.js";

/**
 * 从环境变量构造 LLM 池（与 riverMain main() 同构）。主中转必有；备用/直连/本地按配置挂载。
 * 经纪进程合法持有这些密钥与端点。
 */
export function buildLlmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM_Provider {
  const keyCheck = validateApiKey(env);
  if (keyCheck.error) {
    throw new Error(`[broker] LLM 密钥缺失，经纪无法启动：${keyCheck.error}`);
  }

  const wrap = (p: LLM_Provider, role: string): LLM_Provider =>
    new ResilientLlm(p, {
      maxAttempts: 3,
      perAttemptTimeoutMs: 90_000,
      backoffBaseMs: 1000,
      onEvent: (ev) => {
        if (ev.kind !== "ok") console.error(`[broker LLM|${role}] ${ev.kind} 第${ev.attempt}次 ${ev.detail ?? ""}`);
      },
    });

  const members: LlmPoolMember[] = [];
  // ① 主中转。
  members.push({ provider: wrap(new Gpt54Provider({ apiKey: keyCheck.apiKey!, env }), "relay-primary"), role: "relay-primary" });
  // ② 备用中转。
  const backup = readBackupEndpoint(env);
  if (backup) {
    members.push({ provider: wrap(new Gpt54Provider({ apiKey: backup.apiKey, baseURL: backup.baseURL, model: backup.model, env }), "relay-backup"), role: "relay-backup" });
  }
  // ③ OpenAI 直连·经境外出口（配 key + WENLU_EGRESS_PROXY 才挂）。
  const proxyUrl = (env.WENLU_EGRESS_PROXY ?? "").trim();
  const openaiDirectKey = (env.WENLU_OPENAI_DIRECT_KEY ?? "").trim();
  if (proxyUrl && openaiDirectKey) {
    members.push({
      provider: wrap(new Gpt54Provider({
        apiKey: openaiDirectKey,
        baseURL: "https://api.openai.com/v1",
        model: (env.WENLU_OPENAI_DIRECT_MODEL ?? "").trim() || undefined,
        fetchImpl: buildProxyFetch(proxyUrl),
        env,
      }), "openai-direct-proxy"),
      role: "openai-direct-proxy",
    });
  }
  // ④ 本地模型兜底。
  const local = readLocalEndpoint(env);
  if (local) {
    members.push({ provider: wrap(new Gpt54Provider({ apiKey: local.apiKey, baseURL: local.baseURL, model: local.model, env }), "local"), role: "local", isLocal: true });
  }

  return members.length === 1
    ? members[0].provider
    : new LlmPool(members, {
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        onEvent: (ev) => console.error(`[broker LLM池] ${ev.kind} ${ev.role} ${ev.detail ?? ""}`),
      });
}

/** 经纪句柄。 */
export interface LlmBrokerHandle {
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const b = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(b);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > maxBytes) { req.destroy(); reject(new Error("请求体过大")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("非法 JSON")); }
    });
    req.on("error", reject);
  });
}

/**
 * 启动 LLM 经纪。仅绑定 127.0.0.1；要求 WENLU_BROKER_TOKEN。
 * @param opts.llm 注入的 LLM（默认从 env 构造，便于测试用替身）。
 */
export async function startLlmBroker(opts?: {
  port?: number;
  token?: string;
  llm?: LLM_Provider;
  env?: NodeJS.ProcessEnv;
}): Promise<LlmBrokerHandle> {
  const env = opts?.env ?? process.env;
  const token = (opts?.token ?? env.WENLU_BROKER_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("WENLU_BROKER_TOKEN 未配置：经纪拒绝无鉴权启动。");
  }
  const port = opts?.port ?? parseInt(env.WENLU_BROKER_PORT ?? "3260", 10);
  const llm = opts?.llm ?? buildLlmFromEnv(env);

  const authOk = (req: IncomingMessage): boolean => {
    const h = req.headers["authorization"];
    return typeof h === "string" && h === `Broker ${token}`;
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url === "/broker/health") {
      sendJson(res, 200, { ok: true, service: "wenlu-llm-broker" });
      return;
    }

    // 其余一律鉴权。
    if (!authOk(req)) { sendJson(res, 401, { ok: false, error: "未授权" }); return; }

    if (method === "POST" && (url === "/broker/llm/complete" || url === "/broker/llm/complete-with-tools")) {
      void (async () => {
        try {
          const body = await readJsonBody(req);
          if (url === "/broker/llm/complete") {
            const out = await llm.complete(body as LlmRequest);
            sendJson(res, 200, { ok: true, response: out });
          } else {
            const out = await llm.completeWithTools(body as LlmToolRequest);
            sendJson(res, 200, { ok: true, response: out });
          }
        } catch (e) {
          // 上游错误回传为可读信息（截断，绝不含密钥）。
          sendJson(res, 502, { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
        }
      })();
      return;
    }

    sendJson(res, 404, { ok: false, error: `未找到 ${method} ${url}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => { server.removeAllListeners("error"); resolve(); });
    server.listen(port, "127.0.0.1");
  });

  // 取实际绑定端口（支持 port=0 由系统分配）。
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: boundPort,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
