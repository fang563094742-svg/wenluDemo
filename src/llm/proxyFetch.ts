/**
 * 代理感知 fetch（Proxy-aware fetch）· 让大脑（LLM 调用）也能走境外出口
 * ------------------------------------------------------------------
 * 第一性原理：OpenAI 等端点在国内被墙，而大脑靠 LLM 调用驱动。若 provider 用裸 Node fetch，
 * 它走不通代理 → 大脑连不上。出网层（netEgress）解决搜索/抓页，但 LLM 走 provider 自己的
 * fetch，必须单独代理化，否则"接了 proxy 出口却没接大脑"是逻辑缺口。
 *
 * 按代理协议各用其正道（不依赖任何端口巧合）：
 *   - socks5:// / socks5h:// → 用 `socks` 建 SOCKS 隧道，作 undici Agent 的 connect 钩子，
 *     再由 undici 在隧道之上做 TLS。任意纯 SOCKS 代理（Clash/Xray/sing-box…）原生可用。
 *   - http:// / https:// → undici ProxyAgent（HTTP CONNECT）。
 *   - 空 → 全局 fetch（零行为改变）。
 *
 * SSE 流式响应原样透传（undici fetch 与全局 fetch 行为一致，Provider 的流式解析无需改动）。
 * 任何代理构建失败都安全回退全局 fetch，绝不让大脑因代理配置错误而瘫痪。
 * 沿用弟弟 ESM 约定：相对导入带 `.js`。
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { SocksClient, type SocksProxy } from "socks";
import tls from "node:tls";

/** 解析 socks5(h)://host:port → SocksProxy。失败返回 null。 */
function parseSocksProxy(url: string): SocksProxy | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const port = Number(u.port) || 1080;
    if (!host) return null;
    return { host, port, type: 5 };
  } catch {
    return null;
  }
}

/**
 * 构建一个经 SOCKS 隧道连接的 undici Agent：
 * 每次连接先用 socks 建到目标的隧道，https 在隧道上再做 TLS（servername 用真实域名，
 * 远端解析 DNS——socks5h 语义，绕开本地 DNS 投毒）。
 */
function buildSocksAgent(proxy: SocksProxy): Agent {
  return new Agent({
    connect: (opts: any, cb: (err: Error | null, socket: any) => void) => {
      const hostname: string = opts.hostname;
      const isTls = opts.protocol !== "http:";
      const port = Number(opts.port) || (isTls ? 443 : 80);
      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host: hostname, port },
      })
        .then(({ socket }) => {
          if (!isTls) {
            cb(null, socket);
            return;
          }
          const secure = tls.connect({
            socket,
            servername: hostname,
            ALPNProtocols: ["http/1.1"],
          });
          secure.once("secureConnect", () => cb(null, secure));
          secure.once("error", (e) => cb(e, null));
        })
        .catch((e) => cb(e instanceof Error ? e : new Error(String(e)), null));
    },
  });
}

/**
 * 构建代理感知 fetch。
 *
 * @param proxyUrl 代理地址（socks5(h):// 或 http(s)://）；空则不代理
 * @returns 与 global fetch 签名兼容的函数
 */
export function buildProxyFetch(proxyUrl?: string): typeof fetch {
  const url = (proxyUrl ?? "").trim();
  if (!url) return globalThis.fetch;

  try {
    if (url.startsWith("socks5://") || url.startsWith("socks5h://") || url.startsWith("socks://")) {
      const proxy = parseSocksProxy(url);
      if (!proxy) return globalThis.fetch;
      const agent = buildSocksAgent(proxy);
      return ((input: any, init?: any) =>
        undiciFetch(input, { ...(init ?? {}), dispatcher: agent } as any)) as unknown as typeof fetch;
    }
    // http(s) 代理：undici ProxyAgent（HTTP CONNECT）。
    const agent = new ProxyAgent(url);
    return ((input: any, init?: any) =>
      undiciFetch(input, { ...(init ?? {}), dispatcher: agent } as any)) as unknown as typeof fetch;
  } catch {
    // 代理构建失败 → 安全回退全局 fetch，绝不让大脑因配置错误瘫痪。
    return globalThis.fetch;
  }
}
