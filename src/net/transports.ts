/**
 * 出网传输实现（Egress Transports）· 基于 Python urllib
 * ------------------------------------------------------------------
 * 第一性原理映射（均经实测验证）：
 *   - direct：Python urllib 直连，靠系统 DNS。国内站（Bing/百度/国内 API）实测可达。
 *   - doh-direct：先用国内可达且不投毒的 DoH（doh.pub，实测 218ms 返真 IP）解析真 IP，
 *     再以真 IP 直连 + SNI=原域名。破"系统 DNS 投毒但 IP 本身可达"的站。
 *     （实测：DDG/OpenAI 即便拿到真 IP 仍被 SNI 阻断 → 这类只能靠 proxy；doh-direct 是低成本先试。）
 *   - proxy：走 WENLU_EGRESS_PROXY 指定的境外出口（http/https/socks5 代理）。破 SNI/IP 阻断。
 *     仅对被授权用户启用（NetEgress 按 entitlement 裁剪，本层只负责"能走通"）。
 *
 * 为什么用 Python urllib 而非 Node：弟弟历史实测 Node fetch 的 DNS / 代理在本机不稳，
 * Python urllib 出网稳定且原生支持 IP+SNI 覆盖与 ProxyHandler。本层把出网细节收敛到一处。
 *
 * 解耦：本模块不 import node:child_process，而是接收注入的 `PythonExec`（来自 riverMain 的 safeExec），
 * 既复用既有硬超时/PATH 治理，又便于单测替身。沿用弟弟 ESM 约定（相对导入带 `.js`）。
 */

import type { EgressTransports } from "./egress.js";

/** 注入的 Python 执行器（复用 riverMain.safeExec 的语义：stdout 即结果）。 */
export type PythonExec = (
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/** 注入的通用命令执行器（用于 proxy 出口走 curl：file=命令名，args=参数）。 */
export type CmdExec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/** 失败约定前缀（与 NetEgress.isErr 对齐）。 */
const ERR = "__ERR__";

/** 直连：系统 DNS + urllib。国内站走这条最快。 */
const DIRECT_PY = `import sys,urllib.request
req=urllib.request.Request(sys.argv[1],headers={'User-Agent':'Mozilla/5.0 (Macintosh) Wenlu/1.0','Accept':'text/html,application/json,*/*'})
try:
    with urllib.request.urlopen(req,timeout=int(sys.argv[2])) as r:
        sys.stdout.buffer.write(r.read(2000000))
except Exception as e:
    sys.stdout.write('__ERR__'+repr(e))`;

/**
 * DoH 直连：用 doh.pub 解析真 IP，以真 IP 建连但 SNI/Host 仍用原域名（破纯 DNS 投毒）。
 * 失败（含 DoH 拿不到 IP、IP 直连被 SNI 阻断）一律回 __ERR__，交由 NetEgress 降级到下一出口。
 */
export const DOH_RESOLVE_PY = `import sys,json,ssl,socket,urllib.request,urllib.parse
url=sys.argv[1]; timeout=int(sys.argv[2])
p=urllib.parse.urlparse(url); host=p.hostname; port=p.port or (443 if p.scheme=='https' else 80)
path=p.path or '/'
if p.query: path+='?'+p.query
def doh(name):
    u='https://doh.pub/dns-query?name=%s&type=A'%name
    try:
        r=urllib.request.urlopen(urllib.request.Request(u,headers={'accept':'application/dns-json'}),timeout=timeout)
        d=json.load(r); return [a['data'] for a in d.get('Answer',[]) if a.get('type')==1]
    except Exception as e:
        return []
try:
    ips=doh(host)
    if not ips:
        sys.stdout.write('__ERR__doh-no-ip'); sys.exit(0)
    ip=ips[0]
    if p.scheme=='https':
        ctx=ssl.create_default_context()
        raw=socket.create_connection((ip,port),timeout=timeout)
        s=ctx.wrap_socket(raw,server_hostname=host)
    else:
        s=socket.create_connection((ip,port),timeout=timeout)
    req=('GET %s HTTP/1.1\\r\\nHost: %s\\r\\nUser-Agent: Wenlu/1.0\\r\\nAccept: */*\\r\\nConnection: close\\r\\n\\r\\n'%(path,host)).encode()
    s.sendall(req)
    chunks=[]; total=0
    s.settimeout(timeout)
    while total<2000000:
        try:
            b=s.recv(65536)
        except Exception:
            break
        if not b: break
        chunks.append(b); total+=len(b)
    s.close()
    data=b''.join(chunks)
    # 去掉 HTTP 头，只留 body
    sep=data.find(b'\\r\\n\\r\\n')
    body=data[sep+4:] if sep>=0 else data
    sys.stdout.buffer.write(body)
except Exception as e:
    sys.stdout.write('__ERR__'+repr(e))`;

/**
 * 代理出网：走 WENLU_EGRESS_PROXY（socks5/http/https）。破 SNI/IP 阻断。
 * 第一性选型：用 curl 而非 Python——(1) macOS 必带，无需额外依赖（PySocks 常缺）；
 * (2) curl 原生支持 socks5h（远端 DNS 解析，避免本地 DNS 再被投毒）；(3) 已在本机实测可达
 * DuckDuckGo/Google/OpenAI。proxy 地址由参数传入（不硬编码）。
 *
 * @param cmdExec 注入的通用命令执行器（riverMain 用 safeExec 封装）
 * @param proxyUrl 代理地址（socks5://127.0.0.1:10808 等）
 * @returns 取正文函数；失败回 __ERR__ 串
 */
function buildCurlProxyGet(cmdExec: CmdExec, proxyUrl: string) {
  return async (url: string, timeoutMs: number): Promise<string> => {
    // socks5:// 统一升级为 socks5h://（远端解析 DNS，绕开本地 DNS 投毒）。
    const normalizedProxy = proxyUrl.startsWith("socks5://")
      ? proxyUrl.replace(/^socks5:\/\//, "socks5h://")
      : proxyUrl;
    const secs = Math.max(1, Math.floor(timeoutMs / 1000));
    try {
      const { stdout } = await cmdExec(
        "curl",
        [
          "-s", "-L",
          "--proxy", normalizedProxy,
          "--max-time", String(secs),
          "-A", "Mozilla/5.0 (Macintosh) Wenlu/1.0",
          "--max-filesize", "2000000",
          url,
        ],
        timeoutMs,
      );
      if (!stdout || stdout.trim().length === 0) return `${ERR}proxy-empty`;
      return stdout;
    } catch (e) {
      return `${ERR}${e instanceof Error ? e.message : String(e)}`;
    }
  };
}

/**
 * 装配三出口传输。
 *
 * direct / doh-direct 走注入的 Python 执行器；proxy 走注入的通用命令执行器（curl）。
 *
 * @param pyExec 注入的 Python 执行器（riverMain 用 safeExec 封装 python3 -c）
 * @param cmdExec 注入的通用命令执行器（proxy 走 curl）；缺省则无 proxy 出口
 * @param proxyUrl 境外出口地址（来自 WENLU_EGRESS_PROXY）；为空则不提供 proxyGet
 * @returns EgressTransports（direct / doh-direct 恒有；proxy 视配置而定）
 */
export function buildPythonTransports(
  pyExec: PythonExec,
  cmdExec?: CmdExec,
  proxyUrl?: string,
): EgressTransports {
  const secs = (ms: number) => String(Math.max(1, Math.floor(ms / 1000)));

  const run = async (py: string, extraArgs: string[], timeoutMs: number): Promise<string> => {
    try {
      const { stdout } = await pyExec(["-c", py, ...extraArgs], timeoutMs);
      return stdout;
    } catch (e) {
      return `${ERR}${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const transports: EgressTransports = {
    directGet: (url, timeoutMs) => run(DIRECT_PY, [url, secs(timeoutMs)], timeoutMs),
    dohDirectGet: (url, timeoutMs) => run(DOH_RESOLVE_PY, [url, secs(timeoutMs)], timeoutMs),
  };

  const proxy = (proxyUrl ?? "").trim();
  if (proxy.length > 0 && typeof cmdExec === "function") {
    transports.proxyGet = buildCurlProxyGet(cmdExec, proxy);
  }

  return transports;
}
