/**
 * 统一出网层（Net Egress）· 三出口 + 健康表自适应 + 多用户授权门控
 * ------------------------------------------------------------------
 * 第一性原理：出网 = 把意图安全送达正确的服务器。墙有两层形态，出口一一对应：
 *   ① direct      Node fetch 直连 —— 国内可达站（Bing/百度/国内 API），最快。
 *   ② doh-direct  DoH 拿真 IP + 直连 —— 破"纯 DNS 投毒"的站（系统 DNS 给假 IP 但 IP 本身可达）。
 *   ③ proxy       境外出口（代理 / relay）—— 破"SNI/IP 阻断"的站（DDG/Google/OpenAI）；
 *                 稀缺敏感资源，仅对 entitlement.allowOverseas 的用户开放（多用户门控）。
 *
 * 出口选择 = 候选出口集（按用户授权裁剪）→ 健康表 EWMA 重排 → 逐个尝试，首个成功即返回。
 * 这一层是所有联网工具（web_search / browse_url / auto_learn / 未来 LLM provider）的唯一出网通道，
 * 取代散落的 httpGetViaPython / 各自 fetch，统一治理、统一学习最优源。
 *
 * 解耦设计：底层传输（Node fetch / Python urllib / DoH / 代理执行）由调用方注入 `EgressTransports`，
 * 本模块不直接 import node:child_process，杜绝与 riverMain 的循环依赖，且便于单测注入替身。
 *
 * 沿用弟弟 ESM 约定：相对导入带 `.js` 扩展。
 */

import { EgressHealthTable } from "./healthTable.js";
import type { EgressEntitlement } from "./entitlement.js";

/** 出口类型。 */
export type EgressExitKind = "direct" | "doh-direct" | "proxy";

/** 一次出网请求选项。 */
export interface NetFetchOptions {
  /** 逐用户出网授权；缺省视为不放行境外出口（最安全默认）。 */
  entitlement?: EgressEntitlement;
  /** 超时（毫秒），默认 15000。 */
  timeoutMs?: number;
  /** 限定只用某些出口（诊断 / 测试用）；缺省按授权 + 健康表自动选。 */
  onlyExits?: EgressExitKind[];
}

/** 一次出网结果。 */
export interface NetFetchResult {
  /** 是否成功拿到正文。 */
  ok: boolean;
  /** 响应正文（成功时）；失败为空串。 */
  body: string;
  /** 实际命中的出口；全失败为 null。 */
  exit: EgressExitKind | null;
  /** 每个出口的尝试留痕（诊断 / 渲染回意识）。 */
  attempts: Array<{ exit: EgressExitKind; ok: boolean; latencyMs: number; note: string }>;
}

/**
 * 底层传输能力（由调用方注入；本模块不绑定具体实现，杜绝循环依赖）。
 * 每个传输返回正文字符串；失败约定返回以 "__ERR__" 开头的串（沿用弟弟既有约定）。
 */
export interface EgressTransports {
  /** Node fetch 直连。 */
  directGet(url: string, timeoutMs: number): Promise<string>;
  /** DoH 解析真 IP 后直连（破纯 DNS 投毒）。 */
  dohDirectGet(url: string, timeoutMs: number): Promise<string>;
  /** 境外出口（代理 / relay）；未配置出口时可不提供。 */
  proxyGet?(url: string, timeoutMs: number): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 各出口的超时系数：国内直连出口对被墙站会挂到超时才失败，给它们较短超时快速失败，
 * 把时间预算留给真正能成的 proxy 出口。proxy 用全额超时。
 * 第一性：被墙站的 direct/doh 注定失败，没必要等满 15s——快速失败 + 健康表学习 = 快速收敛到 proxy。
 */
const EXIT_TIMEOUT_FACTOR: Record<EgressExitKind, number> = {
  direct: 0.4,      // 15s → 6s：国内站通常 <1s，6s 足够；被墙站 6s 即放弃
  "doh-direct": 0.4,
  proxy: 1.0,       // 境外出口给足时间
};

/** 判定传输返回是否为失败串。 */
function isErr(body: string): boolean {
  return typeof body !== "string" || body.startsWith("__ERR__");
}

/** 判定是否为有效正文：非失败串且非空白（0 字节/纯空白不算成功，避免"连上但没内容"被误判）。 */
function isValidBody(body: string): boolean {
  return !isErr(body) && body.trim().length > 0;
}

/**
 * 统一出网器：按用户授权裁剪出口集、健康表重排、逐个尝试。
 *
 * - 健康表跨调用学习每个出口的成功率 / 延迟，rank() 动态择优（自主判断最优源）。
 * - proxy 出口仅当 entitlement.allowOverseas === true 且注入了 proxyGet 才进入候选。
 * - 任一出口成功即返回；全失败返回 ok:false + 完整 attempts 留痕（绝不编造正文）。
 */
export class NetEgress {
  private health = new EgressHealthTable();
  private transports: EgressTransports;

  constructor(transports: EgressTransports) {
    this.transports = transports;
  }

  /** 暴露健康表用于 snapshot/restore（跨重启留存学习）。 */
  get healthTable(): EgressHealthTable {
    return this.health;
  }

  /** 列出当前请求可用的出口集（按授权裁剪）。 */
  private candidateExits(opts: NetFetchOptions): EgressExitKind[] {
    const all: EgressExitKind[] = ["direct", "doh-direct"];
    const allowOverseas = opts.entitlement?.allowOverseas === true;
    if (allowOverseas && typeof this.transports.proxyGet === "function") {
      all.push("proxy");
    }
    if (opts.onlyExits && opts.onlyExits.length > 0) {
      return all.filter((e) => opts.onlyExits!.includes(e));
    }
    return all;
  }

  /** 取某出口的传输函数。 */
  private transportFor(exit: EgressExitKind): ((url: string, t: number) => Promise<string>) | undefined {
    switch (exit) {
      case "direct": return this.transports.directGet.bind(this.transports);
      case "doh-direct": return this.transports.dohDirectGet.bind(this.transports);
      case "proxy": return this.transports.proxyGet?.bind(this.transports);
    }
  }

  /**
   * 出网取正文。
   * @param url 目标 URL
   * @param opts 授权 / 超时 / 出口限定
   */
  async fetch(url: string, opts: NetFetchOptions = {}): Promise<NetFetchResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const candidates = this.candidateExits(opts);
    const ordered = this.health.rank(candidates) as EgressExitKind[];
    const attempts: NetFetchResult["attempts"] = [];

    for (const exit of ordered) {
      const transport = this.transportFor(exit);
      if (!transport) continue;
      const exitTimeout = Math.max(2000, Math.floor(timeoutMs * EXIT_TIMEOUT_FACTOR[exit]));
      const t0 = Date.now();
      try {
        const body = await transport(url, exitTimeout);
        const latencyMs = Date.now() - t0;
        if (!isValidBody(body)) {
          this.health.record(exit, false, latencyMs);
          const note = isErr(body) ? body.slice(7, 60) : "empty-body";
          attempts.push({ exit, ok: false, latencyMs, note });
          continue;
        }
        this.health.record(exit, true, latencyMs);
        attempts.push({ exit, ok: true, latencyMs, note: `ok ${body.length}B` });
        return { ok: true, body, exit, attempts };
      } catch (e) {
        const latencyMs = Date.now() - t0;
        this.health.record(exit, false, latencyMs);
        attempts.push({ exit, ok: false, latencyMs, note: (e instanceof Error ? e.message : String(e)).slice(0, 60) });
      }
    }

    return { ok: false, body: "", exit: null, attempts };
  }
}
