import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { getPlanById, getPlanPaymentGoodsKey } from '../db/subscriptionRepo.js';
import { loadLdxpConfig, toLdxpAmountCents, type LdxpApiResponse, type LdxpConfig } from './ldxpClient.js';

export interface LdxpStorefrontConfig {
  enabled: boolean;
  shopUrl: string;
  shopToken: string;
  categoryKey: string;
  goodsKeyMap: Record<string, string>;
  defaultGoodsKey: string;
  preferredGoodsTypes: string[];
  fallbackContact: string;
}

export interface LdxpStorefrontShopInfo {
  link?: string;
  nickname?: string;
  token?: string;
  goods_type_sort?: string[];
  js?: string[];
  goods_count?: number;
}

export interface LdxpStorefrontGood {
  link?: string;
  goods_type?: string;
  goods_key: string;
  name: string;
  price: number;
  market_price?: number;
  description?: string;
  image?: string;
  coupon_status?: number;
  contact_format?: string;
  category?: {
    id?: number;
    name?: string;
  };
  user?: {
    token?: string;
    nickname?: string;
  };
  extend?: {
    stock_count?: number;
    limit_count?: number;
    query_password_status?: number;
  };
}

export interface LdxpStorefrontChannel {
  id: number;
  name?: string;
  code?: string;
  show_name?: string;
  status?: number;
  custom_status?: number;
  rate?: number;
  paytype?: {
    name?: string;
    icon?: string;
  };
}

export interface LdxpStorefrontPriceQuote {
  original_amount: number;
  total_amount: number;
  fee?: number;
  fee_payer?: number;
  sales_style?: string[];
  coupon_available?: number;
  coupon_price?: number;
}

export interface LdxpStorefrontCreateOrderInput {
  goodsKey: string;
  quantity?: number;
  couponCode?: string;
  channelId: number;
  contact: string;
  buyerValue?: Record<string, unknown>;
  queryPassword?: string;
  selectCardIds?: string[];
  extend?: Record<string, unknown>;
}

export interface LdxpStorefrontCreateOrderResult {
  trade_no: string;
  total_amount: number;
  payurl: string;
}

export interface LdxpStorefrontQueryResult {
  code: number;
  msg: string;
  time?: number;
  data: Record<string, unknown> | null;
}

export interface LdxpResolvedGoodsMatch {
  goodsKey: string | null;
  good: LdxpStorefrontGood | null;
  reason: string | null;
  candidates: LdxpStorefrontGood[];
  source: 'metadata' | 'plan_config' | 'env_map' | 'env_default' | 'amount_match' | 'unresolved';
}

function readTextEnv(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonMap(value: string): Record<string, string> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>);
    return Object.fromEntries(
      entries
        .map(([key, item]) => [key.trim(), typeof item === 'string' ? item.trim() : ''])
        .filter(([key, item]) => Boolean(key) && Boolean(item)),
    );
  } catch {
    return {};
  }
}

function parseCsv(value: string, fallback: string[]): string[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

function parseShopPath(shopUrl: string): { shopToken: string; categoryKey: string } {
  try {
    const url = new URL(shopUrl);
    const match = url.pathname.match(/^\/shop\/([^/]+)(?:\/([^/?#]+))?/i);
    return {
      shopToken: match?.[1]?.trim() ?? '',
      categoryKey: match?.[2]?.trim() ?? '',
    };
  } catch {
    return { shopToken: '', categoryKey: '' };
  }
}

export function loadLdxpStorefrontConfig(): LdxpStorefrontConfig {
  const merchantConfig = loadLdxpConfig();
  const parsed = parseShopPath(merchantConfig.shopUrl);
  const goodsKeyMap = parseJsonMap(readTextEnv('LDXP_SHOP_GOODS_KEY_MAP'));
  const defaultGoodsKey = readTextEnv('LDXP_SHOP_DEFAULT_GOODS_KEY');
  if (!goodsKeyMap[merchantConfig.recommendedPlanId] && defaultGoodsKey) {
    goodsKeyMap[merchantConfig.recommendedPlanId] = defaultGoodsKey;
  }
  return {
    enabled: Boolean(merchantConfig.shopUrl && (parsed.shopToken || readTextEnv('LDXP_SHOP_TOKEN'))),
    shopUrl: merchantConfig.shopUrl,
    shopToken: readTextEnv('LDXP_SHOP_TOKEN', parsed.shopToken),
    categoryKey: readTextEnv('LDXP_SHOP_CATEGORY_KEY', parsed.categoryKey),
    goodsKeyMap,
    defaultGoodsKey,
    preferredGoodsTypes: parseCsv(readTextEnv('LDXP_SHOP_GOODS_TYPES'), ['card', 'equity', 'resource', 'article']),
    fallbackContact: merchantConfig.supportContact || '17865770178',
  };
}

class SimpleCookieJar {
  private readonly store = new Map<string, string>();

  ingest(setCookieHeaders: string[]) {
    for (const header of setCookieHeaders) {
      const first = header.split(';')[0]?.trim();
      if (!first) continue;
      const divider = first.indexOf('=');
      if (divider <= 0) continue;
      this.store.set(first.slice(0, divider), first.slice(divider + 1));
    }
  }

  setCookie(cookie: string) {
    const first = cookie.split(';')[0]?.trim();
    if (!first) return;
    const divider = first.indexOf('=');
    if (divider <= 0) return;
    this.store.set(first.slice(0, divider), first.slice(divider + 1));
  }

  toHeader(): string {
    return Array.from(this.store.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  return match?.[1] ?? '';
}

function looksLikeAkamaiChallenge(html: string): boolean {
  return /acw_sc__v2/.test(html) && /document\.cookie/.test(html);
}

function solveAkamaiCookie(html: string): string {
  const script = extractInlineScript(html);
  if (!script) {
    throw new Error('LDXP_STOREFRONT_CHALLENGE_SCRIPT_NOT_FOUND');
  }

  let cookieValue = '';
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
  const firstCookie = cookieValue.split(';')[0]?.trim();
  if (!firstCookie) {
    throw new Error('LDXP_STOREFRONT_CHALLENGE_COOKIE_EMPTY');
  }
  return firstCookie;
}

function buildDefaultContact(): string {
  return `${readTextEnv('LDXP_SUPPORT_CONTACT', '17865770178')}#${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export class LdxpStorefrontClient {
  private readonly cookieJar = new SimpleCookieJar();
  private shopInfoCache: LdxpStorefrontShopInfo | null = null;
  private channelCache: LdxpStorefrontChannel[] | null = null;
  private goodsCache = new Map<string, LdxpStorefrontGood[]>();

  constructor(private readonly config: LdxpStorefrontConfig = loadLdxpStorefrontConfig()) {}

  getConfig(): LdxpStorefrontConfig {
    return this.config;
  }

  async getShopInfo(): Promise<LdxpStorefrontShopInfo> {
    if (this.shopInfoCache) return this.shopInfoCache;
    const data = await this.requestJson<LdxpStorefrontShopInfo>('https://pay.ldxp.cn/shopApi/Shop/info', {
      token: this.config.shopToken,
      category_key: this.config.categoryKey,
    });
    this.shopInfoCache = data;
    return data;
  }

  async listGoods(goodsType: string): Promise<LdxpStorefrontGood[]> {
    const key = goodsType.trim() || 'default';
    const cached = this.goodsCache.get(key);
    if (cached) return cached;
    const data = await this.requestJson<{ total: number; list: LdxpStorefrontGood[] }>('https://pay.ldxp.cn/shopApi/Shop/goodsList', {
      token: this.config.shopToken,
      category_id: 0,
      keywords: '',
      goods_type: key,
      current: 1,
      pageSize: readPositiveIntEnv('LDXP_SHOP_GOODS_PAGE_SIZE', 50),
    });
    const list = Array.isArray(data.list) ? data.list : [];
    this.goodsCache.set(key, list);
    return list;
  }

  async listAllGoods(goodsTypes?: string[]): Promise<LdxpStorefrontGood[]> {
    const shopInfo = await this.getShopInfo();
    const preferredTypes = goodsTypes && goodsTypes.length > 0
      ? goodsTypes
      : (Array.isArray(shopInfo.goods_type_sort) && shopInfo.goods_type_sort.length > 0
          ? shopInfo.goods_type_sort
          : this.config.preferredGoodsTypes);

    const merged = new Map<string, LdxpStorefrontGood>();
    for (const goodsType of preferredTypes) {
      const goods = await this.listGoods(goodsType);
      for (const item of goods) {
        merged.set(item.goods_key, item);
      }
    }
    return Array.from(merged.values());
  }

  async getUserChannels(): Promise<LdxpStorefrontChannel[]> {
    if (this.channelCache) return this.channelCache;
    const data = await this.requestJson<LdxpStorefrontChannel[]>('https://pay.ldxp.cn/shopApi/Shop/getUserChannel', {
      token: this.config.shopToken,
    });
    this.channelCache = Array.isArray(data) ? data : [];
    return this.channelCache;
  }

  async getGoodsPrice(input: { goodsKey: string; quantity?: number; couponCode?: string; channelId: number }): Promise<LdxpStorefrontPriceQuote> {
    return this.requestJson<LdxpStorefrontPriceQuote>('https://pay.ldxp.cn/shopApi/Shop/getGoodsPrice', {
      goods_key: input.goodsKey,
      quantity: input.quantity ?? 1,
      coupon_code: input.couponCode ?? '',
      channel_id: input.channelId,
    });
  }

  async createOrder(input: LdxpStorefrontCreateOrderInput): Promise<LdxpStorefrontCreateOrderResult> {
    return this.requestJson<LdxpStorefrontCreateOrderResult>('https://pay.ldxp.cn/shopApi/Pay/order', {
      goods_key: input.goodsKey,
      quantity: input.quantity ?? 1,
      coupon_code: input.couponCode ?? '',
      channel_id: input.channelId,
      contact: input.contact || buildDefaultContact(),
      buyer_value: input.buyerValue ?? {},
      query_password: input.queryPassword ?? '',
      select_cards_ids: input.selectCardIds ?? [],
      extend: input.extend ?? {},
    });
  }

  async queryOrder(tradeNo: string): Promise<LdxpStorefrontQueryResult> {
    const parsed = await this.requestApi<Record<string, unknown> | null>('https://pay.ldxp.cn/shopApi/Pay/query', {
      trade_no: tradeNo,
    }, true);
    return {
      code: parsed.code,
      msg: parsed.msg,
      time: parsed.time,
      data: parsed.data,
    };
  }

  async resolveGoodsForMembership(input: {
    planId: string;
    amountCents: number;
    preferredGoodsKey?: string | null;
    title?: string | null;
  }): Promise<LdxpResolvedGoodsMatch> {
    const allGoods = await this.listAllGoods();
    const findByKey = (goodsKey: string | undefined): LdxpStorefrontGood | null => {
      if (!goodsKey) return null;
      return allGoods.find((item) => item.goods_key === goodsKey) ?? null;
    };

    const metadataKey = (input.preferredGoodsKey ?? '').trim();
    const metadataGood = findByKey(metadataKey);
    if (metadataGood) {
      return { goodsKey: metadataGood.goods_key, good: metadataGood, reason: null, candidates: [metadataGood], source: 'metadata' };
    }

    const plan = input.planId ? await getPlanById(input.planId) : null;
    const planConfiguredKey = getPlanPaymentGoodsKey(plan);
    const planConfiguredGood = findByKey(planConfiguredKey ?? undefined);
    if (planConfiguredGood) {
      return { goodsKey: planConfiguredGood.goods_key, good: planConfiguredGood, reason: null, candidates: [planConfiguredGood], source: 'plan_config' };
    }

    const envMappedKey = this.config.goodsKeyMap[input.planId]?.trim();
    const envMappedGood = findByKey(envMappedKey);
    if (envMappedGood) {
      return { goodsKey: envMappedGood.goods_key, good: envMappedGood, reason: null, candidates: [envMappedGood], source: 'env_map' };
    }

    const defaultGood = findByKey(this.config.defaultGoodsKey);
    if (defaultGood && toLdxpAmountCents(defaultGood.price) === input.amountCents) {
      return { goodsKey: defaultGood.goods_key, good: defaultGood, reason: null, candidates: [defaultGood], source: 'env_default' };
    }

    const amountMatched = allGoods.filter((item) => toLdxpAmountCents(item.price) === input.amountCents);
    if (amountMatched.length === 1) {
      return { goodsKey: amountMatched[0].goods_key, good: amountMatched[0], reason: null, candidates: amountMatched, source: 'amount_match' };
    }
    if (amountMatched.length > 1) {
      const normalizedTitle = (input.title ?? '').trim();
      const titleMatch = normalizedTitle
        ? amountMatched.find((item) => item.name.includes(normalizedTitle) || normalizedTitle.includes(item.name)) ?? null
        : null;
      if (titleMatch) {
        return { goodsKey: titleMatch.goods_key, good: titleMatch, reason: null, candidates: amountMatched, source: 'amount_match' };
      }
      return {
        goodsKey: amountMatched[0]?.goods_key ?? null,
        good: amountMatched[0] ?? null,
        reason: amountMatched.length > 1 ? '匹配到多条同价商品，已默认使用第一条，请尽快在环境变量 LDXP_SHOP_GOODS_KEY_MAP 中显式绑定。' : null,
        candidates: amountMatched,
        source: 'amount_match',
      };
    }

    return {
      goodsKey: null,
      good: null,
      reason: '当前远端店铺中没有找到与本地套餐金额一致的商品，请在链动小铺补齐商品，或通过 LDXP_SHOP_GOODS_KEY_MAP 显式绑定。',
      candidates: allGoods,
      source: 'unresolved',
    };
  }

  private async requestJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const parsed = await this.requestApi<T>(url, body, false);
    return parsed.data;
  }

  private async requestApi<T>(url: string, body: Record<string, unknown>, allowNonSuccessCode: boolean): Promise<LdxpApiResponse<T>> {
    if (!this.config.enabled || !this.config.shopToken) {
      throw new Error('LDXP_STOREFRONT_NOT_CONFIGURED');
    }

    const responseText = await this.performProtectedRequest(url, JSON.stringify(body), true);
    if (!responseText.trim().startsWith('{')) {
      throw new Error(`LDXP_STOREFRONT_NON_JSON_RESPONSE:${responseText.slice(0, 180)}`);
    }

    const parsed = JSON.parse(responseText) as LdxpApiResponse<T>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('LDXP_STOREFRONT_RESPONSE_INVALID');
    }
    if (!allowNonSuccessCode && parsed.code !== 1) {
      throw new Error(parsed.msg || 'LDXP_STOREFRONT_REQUEST_FAILED');
    }
    return parsed;
  }

  private async performProtectedRequest(url: string, bodyText: string, allowRetry: boolean): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://pay.ldxp.cn',
      Referer: this.config.shopUrl,
      'Content-Type': 'application/json;charset=UTF-8',
    };

    const cookieHeader = this.cookieJar.toHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await fetch(url, {
      method: 'POST',
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
        throw new Error('LDXP_STOREFRONT_CHALLENGE_LOOP');
      }
      this.cookieJar.setCookie(solveAkamaiCookie(responseText));
      return this.performProtectedRequest(url, bodyText, false);
    }

    if (/<html/i.test(responseText) && /acw_sc__v2|http_custom|http_bot_simple/i.test(responseText)) {
      if (!allowRetry) {
        throw new Error(`LDXP_STOREFRONT_HTML_BLOCK:${responseText.slice(0, 180)}`);
      }
      this.cookieJar.setCookie(solveAkamaiCookie(responseText));
      return this.performProtectedRequest(url, bodyText, false);
    }

    return responseText;
  }
}

export function loadDefaultStorefrontContact(baseConfig?: LdxpConfig): string {
  return `${(baseConfig?.supportContact || readTextEnv('LDXP_SUPPORT_CONTACT', '17865770178')).trim() || '17865770178'}#${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}
