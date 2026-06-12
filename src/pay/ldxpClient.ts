import { randomUUID } from "node:crypto";
import vm from "node:vm";

export interface LdxpConfig {
  enabled: boolean;
  username: string;
  password: string;
  shopUrl: string;
  shopTitle: string;
  goodsName: string;
  goodsAmountCents: number;
  supportContact: string;
  recommendedPlanId: string;
  autoReconcileWindowHours: number;
}

export interface LdxpApiResponse<T> {
  code: number;
  msg: string;
  time?: number;
  data: T;
}

export interface LdxpOrderListItem {
  trade_no: string;
  goods_name: string;
  quantity: number;
  total_amount: number;
  status: number;
  create_time: number;
  success_time: number | null;
  transaction_id?: string;
  goods?: {
    goods_key?: string;
    name?: string;
    description?: string;
    link?: string;
  };
}

export interface LdxpOrderDetail extends LdxpOrderListItem {
  fee?: number;
  contact?: string;
  channel?: {
    name?: string;
    paytype?: {
      id?: number;
      name?: string;
      icon?: string;
    };
  };
}

function readTextEnv(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadLdxpConfig(): LdxpConfig {
  const username = readTextEnv("LDXP_MERCHANT_USERNAME");
  const password = readTextEnv("LDXP_MERCHANT_PASSWORD");
  const shopUrl = readTextEnv("LDXP_SHOP_URL", "https://pay.ldxp.cn/shop/ZUSJM8BX/6idmbq");
  return {
    enabled: Boolean(username && password && shopUrl),
    username,
    password,
    shopUrl,
    shopTitle: readTextEnv("LDXP_SHOP_TITLE", "商家0178的小店"),
    goodsName: readTextEnv("LDXP_GOODS_NAME", "会员"),
    goodsAmountCents: readPositiveIntEnv("LDXP_GOODS_AMOUNT_CENTS", 300),
    supportContact: readTextEnv("LDXP_SUPPORT_CONTACT", "17865770178"),
    recommendedPlanId: readTextEnv("LDXP_RECOMMENDED_PLAN_ID", "member"),
    autoReconcileWindowHours: readPositiveIntEnv("LDXP_AUTO_RECONCILE_WINDOW_HOURS", 72),
  };
}

export function buildLdxpClientReference(baseContact: string, shortCode?: string): string {
  const contact = (baseContact || "17865770178").trim();
  const code = (shortCode || randomUUID().replace(/-/g, "").slice(0, 6)).toUpperCase();
  return `${contact}#${code}`;
}

export function toLdxpAmountCents(value: number | string | null | undefined): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

export function isLdxpPaidOrder(order: Pick<LdxpOrderDetail, "status" | "success_time" | "transaction_id">): boolean {
  return Number(order.status ?? 0) === 1 || Boolean(order.transaction_id) || Number(order.success_time ?? 0) > 0;
}

class SimpleCookieJar {
  private readonly store = new Map<string, string>();

  ingest(setCookieHeaders: string[]) {
    for (const header of setCookieHeaders) {
      const first = header.split(";")[0]?.trim();
      if (!first) continue;
      const divider = first.indexOf("=");
      if (divider <= 0) continue;
      this.store.set(first.slice(0, divider), first.slice(divider + 1));
    }
  }

  setCookie(cookie: string) {
    const first = cookie.split(";")[0]?.trim();
    if (!first) return;
    const divider = first.indexOf("=");
    if (divider <= 0) return;
    this.store.set(first.slice(0, divider), first.slice(divider + 1));
  }

  toHeader(): string {
    return Array.from(this.store.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  return match?.[1] ?? "";
}

function looksLikeAkamaiChallenge(html: string): boolean {
  return /acw_sc__v2/.test(html) && /document\.cookie/.test(html);
}

function solveAkamaiCookie(html: string): string {
  const script = extractInlineScript(html);
  if (!script) {
    throw new Error("LDXP_CHALLENGE_SCRIPT_NOT_FOUND");
  }

  let cookieValue = "";
  const sandbox = {
    document: {
      set cookie(value: string) {
        cookieValue = value;
      },
      get cookie() {
        return cookieValue;
      },
      location: {
        reload() {
          return undefined;
        },
      },
    },
    location: {
      reload() {
        return undefined;
      },
    },
    window: {},
    self: {},
    globalThis: {},
    console,
    Date,
    RegExp,
    String,
    Number,
    Boolean,
    Math,
    parseInt,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout() {
      return 0;
    },
    clearTimeout() {
      return undefined;
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 5000 });
  const firstCookie = cookieValue.split(";")[0]?.trim();
  if (!firstCookie) {
    throw new Error("LDXP_CHALLENGE_COOKIE_EMPTY");
  }
  return firstCookie;
}

export class LdxpMerchantClient {
  private readonly cookieJar = new SimpleCookieJar();
  private merchantToken = "";

  constructor(private readonly config: LdxpConfig) {}

  getCheckoutInfo() {
    return {
      enabled: this.config.enabled,
      shopUrl: this.config.shopUrl,
      shopTitle: this.config.shopTitle,
      goodsName: this.config.goodsName,
      goodsAmountCents: this.config.goodsAmountCents,
      supportContact: this.config.supportContact,
      recommendedPlanId: this.config.recommendedPlanId,
      autoReconcileWindowHours: this.config.autoReconcileWindowHours,
    };
  }

  async login(): Promise<string> {
    if (!this.config.enabled) {
      throw new Error("LDXP_NOT_CONFIGURED");
    }
    if (this.merchantToken) {
      return this.merchantToken;
    }

    const payload = await this.requestJson<{ merchant_token: string }>(
      "https://pay.ldxp.cn/merchantApi/user/login",
      {
        username: this.config.username,
        password: this.config.password,
      },
      {
        referer: "https://pay.ldxp.cn/merchant/login",
      },
    );

    if (!payload?.merchant_token) {
      throw new Error("LDXP_LOGIN_TOKEN_MISSING");
    }

    this.merchantToken = payload.merchant_token;
    return this.merchantToken;
  }

  async listOrders(input: {
    current?: number;
    pageSize?: number;
    status?: number;
    trade_no?: string;
    contact?: string;
    card_no?: string;
    start_time?: number;
    end_time?: number;
  } = {}): Promise<{ total: number; list: LdxpOrderListItem[] }> {
    await this.login();
    return this.requestJson<{ total: number; list: LdxpOrderListItem[] }>(
      "https://pay.ldxp.cn/merchantApi/order/list",
      {
        current: input.current ?? 1,
        pageSize: input.pageSize ?? 20,
        status: input.status ?? 999,
        trade_no: input.trade_no ?? "",
        contact: input.contact ?? "",
        card_no: input.card_no ?? "",
        start_time: input.start_time ?? 0,
        end_time: input.end_time ?? 0,
        agent_id: null,
        parent_id: null,
      },
      {
        referer: "https://pay.ldxp.cn/merchant/order/list",
        merchantToken: this.merchantToken,
      },
    );
  }

  async getOrderInfo(tradeNo: string): Promise<LdxpOrderDetail> {
    await this.login();
    return this.requestJson<LdxpOrderDetail>(
      "https://pay.ldxp.cn/merchantApi/Order/orderInfo",
      { trade_no: tradeNo },
      {
        referer: "https://pay.ldxp.cn/merchant/order/list",
        merchantToken: this.merchantToken,
      },
    );
  }

  private async requestJson<T>(
    url: string,
    body: Record<string, unknown>,
    options: {
      referer: string;
      merchantToken?: string;
    },
  ): Promise<T> {
    const responseText = await this.performProtectedRequest(url, JSON.stringify(body), options, true);
    if (!responseText.trim().startsWith("{")) {
      throw new Error(`LDXP_NON_JSON_RESPONSE:${responseText.slice(0, 180)}`);
    }
    const parsed = JSON.parse(responseText) as LdxpApiResponse<T>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("LDXP_RESPONSE_INVALID");
    }
    if (parsed.code !== 1) {
      throw new Error(parsed.msg || "LDXP_REQUEST_FAILED");
    }
    return parsed.data;
  }

  private async performProtectedRequest(
    url: string,
    bodyText: string,
    options: {
      referer: string;
      merchantToken?: string;
    },
    allowRetry: boolean,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Origin: "https://pay.ldxp.cn",
      Referer: options.referer,
      "Content-Type": "application/json;charset=UTF-8",
    };

    const cookieHeader = this.cookieJar.toHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    if (options.merchantToken) {
      headers["merchant-token"] = options.merchantToken;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyText,
    });

    const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
    if (setCookieHeaders.length > 0) {
      this.cookieJar.ingest(setCookieHeaders);
    }

    const responseText = await response.text();
    if (looksLikeAkamaiChallenge(responseText)) {
      if (!allowRetry) {
        throw new Error("LDXP_CHALLENGE_LOOP");
      }
      this.cookieJar.setCookie(solveAkamaiCookie(responseText));
      return this.performProtectedRequest(url, bodyText, options, false);
    }

    if (/<html/i.test(responseText) && /acw_sc__v2|http_custom|http_bot_simple/i.test(responseText)) {
      if (!allowRetry) {
        throw new Error(`LDXP_HTML_BLOCK:${responseText.slice(0, 180)}`);
      }
      this.cookieJar.setCookie(solveAkamaiCookie(responseText));
      return this.performProtectedRequest(url, bodyText, options, false);
    }

    return responseText;
  }
}
