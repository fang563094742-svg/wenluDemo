import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URLSearchParams, pathToFileURL } from 'node:url';
import vm from 'node:vm';

export interface LdxpGatewayForm {
  action: string;
  method: 'POST';
  fields: Record<string, string>;
}

export interface LdxpPaymentPageArtifacts {
  payUrl: string;
  payPageUrl: string | null;
  gatewayForm: LdxpGatewayForm | null;
  outTradeNo: string | null;
  subject: string | null;
}

export interface LdxpQrExtractionConfig {
  enabled: boolean;
  headless: boolean;
  allowHeadfulRetry: boolean;
  headfulRetryBrowserChannel: string;
  browserChannel: string;
  executablePath: string | null;
  timeoutMs: number;
  settleMs: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface LdxpQrExtractionResult {
  ok: boolean;
  finalUrl: string | null;
  finalTitle: string | null;
  alipayPageUrl: string | null;
  qrUrl: string | null;
  mobilePayUrl: string | null;
  payOrderId: string | null;
  orderNo: string | null;
  qrDataUrl: string | null;
  qrMimeType: string | null;
  qrWidth: number | null;
  qrHeight: number | null;
  bodyTextSnippet: string | null;
  extractor: 'playwright_chrome_headful' | 'playwright_chrome_headless' | 'server_svg_qr';
  error: string | null;
}

type FetchRedirectMode = 'follow' | 'manual' | 'error';

type WenluQrRuntime = {
  toDataUrl?: (text: string, options?: Record<string, unknown>) => string;
};

let qrRuntimePromise: Promise<WenluQrRuntime | null> | null = null;

function readTextEnv(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = readTextEnv(name, fallback ? 'true' : 'false').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function loadLdxpQrExtractionConfig(): LdxpQrExtractionConfig {
  return {
    enabled: readBooleanEnv('LDXP_QR_EXTRACTION_ENABLED', true),
    headless: readBooleanEnv('LDXP_QR_HEADLESS', true),
    allowHeadfulRetry: readBooleanEnv('LDXP_QR_ALLOW_HEADFUL_RETRY', true),
    headfulRetryBrowserChannel: readTextEnv('LDXP_QR_HEADFUL_BROWSER_CHANNEL', 'chrome'),
    browserChannel: readTextEnv('LDXP_QR_BROWSER_CHANNEL', 'chromium'),
    executablePath: readTextEnv('LDXP_QR_EXECUTABLE_PATH') || null,
    timeoutMs: readIntEnv('LDXP_QR_TIMEOUT_MS', 60000),
    settleMs: readIntEnv('LDXP_QR_SETTLE_MS', 12000),
    viewportWidth: readIntEnv('LDXP_QR_VIEWPORT_WIDTH', 1440),
    viewportHeight: readIntEnv('LDXP_QR_VIEWPORT_HEIGHT', 1000),
  };
}

async function loadQrRuntime(): Promise<WenluQrRuntime | null> {
  if (qrRuntimePromise) {
    return qrRuntimePromise;
  }

  qrRuntimePromise = (async () => {
    try {
      const runtime = globalThis as typeof globalThis & {
        WenluQRCode?: WenluQrRuntime;
      };
      if (!runtime.WenluQRCode?.toDataUrl) {
        const moduleUrl = pathToFileURL(resolve(process.cwd(), 'public/vendor/qrcode-lite.js')).href;
        await import(moduleUrl);
      }
      return runtime.WenluQRCode?.toDataUrl ? runtime.WenluQRCode : null;
    } catch {
      return null;
    }
  })();

  return qrRuntimePromise;
}

export async function buildServerQrDataUrl(value: string, title?: string | null): Promise<string | null> {
  const payload = String(value || '').trim();
  if (!payload) {
    return null;
  }
  const runtime = await loadQrRuntime();
  if (!runtime?.toDataUrl) {
    return null;
  }
  try {
    const dataUrl = runtime.toDataUrl(payload, {
      cellSize: 8,
      margin: 4,
      darkColor: '#111827',
      lightColor: '#ffffff',
      title: title || '支付二维码',
    });
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  return match?.[1] ?? '';
}

function looksLikeAkamaiChallenge(html: string): boolean {
  return /acw_sc__v2/i.test(html);
}

function solveAkamaiCookie(html: string): string {
  const script = extractInlineScript(html);
  if (!script) {
    return '';
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

  try {
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox, { timeout: 5000 });
  } catch {
    return '';
  }

  return cookieValue.split(';')[0]?.trim() || '';
}

async function fetchHtmlWithChallenge(
  url: string,
  headers: Record<string, string>,
  redirect: FetchRedirectMode = 'manual',
): Promise<{
  response: Response;
  html: string;
  cookieHeader: string;
}> {
  let cookieHeader = headers.Cookie || '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method: 'GET',
      redirect,
      headers: cookieHeader ? { ...headers, Cookie: cookieHeader } : headers,
    });
    const html = await response.text();

    if (!looksLikeAkamaiChallenge(html)) {
      return { response, html, cookieHeader };
    }

    const solvedCookie = solveAkamaiCookie(html);
    if (!solvedCookie || solvedCookie === cookieHeader) {
      return { response, html, cookieHeader };
    }
    cookieHeader = solvedCookie;
  }

  const response = await fetch(url, {
    method: 'GET',
    redirect,
    headers: cookieHeader ? { ...headers, Cookie: cookieHeader } : headers,
  });
  const html = await response.text();
  return { response, html, cookieHeader };
}

function extractFormAttribute(html: string, name: string): string | null {
  const single = html.match(new RegExp(`<form[^>]*\\s${name}='([^']*)'`, 'i'))?.[1];
  if (single) return decodeHtmlEntities(single);
  const double = html.match(new RegExp(`<form[^>]*\\s${name}="([^"]*)"`, 'i'))?.[1];
  if (double) return decodeHtmlEntities(double);
  return null;
}

function parseHiddenInputs(html: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const tagMatch of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const name = tag.match(/\bname=(['"])([\s\S]*?)\1/i)?.[2];
    const value = tag.match(/\bvalue=(['"])([\s\S]*?)\1/i)?.[2];
    if (!name) {
      continue;
    }
    result[decodeHtmlEntities(name)] = decodeHtmlEntities(value || '');
  }
  return result;
}

function parseBizContentPayload(fields: Record<string, string>): { outTradeNo: string | null; subject: string | null } {
  const payload = fields.biz_content;
  if (!payload) {
    return { outTradeNo: null, subject: null };
  }
  try {
    const parsed = JSON.parse(payload) as { out_trade_no?: string; subject?: string };
    return {
      outTradeNo: parsed.out_trade_no?.trim() || null,
      subject: parsed.subject?.trim() || null,
    };
  } catch {
    return { outTradeNo: null, subject: null };
  }
}

export async function fetchLdxpPaymentPageArtifacts(payUrl: string): Promise<LdxpPaymentPageArtifacts> {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  const first = await fetchHtmlWithChallenge(payUrl, baseHeaders, 'manual');

  const location = first.response.headers.get('location');
  const payPageUrl = location ? new URL(location, payUrl).toString() : first.response.url || payUrl;

  let html = first.html;
  if (location) {
    const second = await fetchHtmlWithChallenge(
      payPageUrl,
      {
        ...baseHeaders,
        Referer: payUrl,
        ...(first.cookieHeader ? { Cookie: first.cookieHeader } : {}),
      },
      'follow',
    );
    html = second.html;
  }

  const action = extractFormAttribute(html, 'action');
  const method: 'POST' = 'POST';
  const fields = parseHiddenInputs(html);
  const gatewayForm = action
    ? {
        action,
        method,
        fields,
      }
    : null;
  const meta = parseBizContentPayload(fields);

  return {
    payUrl,
    payPageUrl,
    gatewayForm,
    outTradeNo: meta.outTradeNo,
    subject: meta.subject,
  };
}

export async function extractLdxpQrByPlaywright(
  payUrlOrPageUrl: string,
  config: LdxpQrExtractionConfig = loadLdxpQrExtractionConfig(),
): Promise<LdxpQrExtractionResult> {
  const makeEmptyResult = (
    extractor: LdxpQrExtractionResult['extractor'],
    error: string,
  ): LdxpQrExtractionResult => ({
    ok: false,
    finalUrl: null,
    finalTitle: null,
    alipayPageUrl: null,
    qrUrl: null,
    mobilePayUrl: null,
    payOrderId: null,
    orderNo: null,
    qrDataUrl: null,
    qrMimeType: null,
    qrWidth: null,
    qrHeight: null,
    bodyTextSnippet: null,
    extractor,
    error,
  });

  async function runExtraction(runConfig: LdxpQrExtractionConfig): Promise<LdxpQrExtractionResult> {
    const extractor = runConfig.headless ? 'playwright_chrome_headless' : 'playwright_chrome_headful';
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        channel: runConfig.browserChannel || undefined,
        executablePath: runConfig.executablePath || undefined,
        headless: runConfig.headless,
      });
      try {
        const page = await browser.newPage({
          viewport: {
            width: runConfig.viewportWidth,
            height: runConfig.viewportHeight,
          },
        });
        await page.goto(payUrlOrPageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: runConfig.timeoutMs,
        });

        try {
          await page.waitForURL(/excashier\.alipay\.com\//, {
            timeout: Math.min(runConfig.timeoutMs, 30000),
            waitUntil: 'domcontentloaded',
          });
        } catch {
          // ignore; we'll inspect current page state below
        }

        try {
          await page.locator('.qrcode-img-area canvas').waitFor({
            state: 'visible',
            timeout: Math.min(runConfig.timeoutMs, 25000),
          });
        } catch {
          // ignore; canvas extraction below may still succeed after settle delay
        }

        if (runConfig.settleMs > 0) {
          await page.waitForTimeout(runConfig.settleMs);
        }

        const evaluation = await page.evaluate(() => {
          const browserWindow = globalThis as unknown as {
            document?: {
              querySelector: (selector: string) => {
                toDataURL?: (mimeType?: string) => string;
                width?: number;
                height?: number;
              } | null;
              querySelectorAll?: (selector: string) => ArrayLike<unknown>;
              body?: {
                innerText?: string;
              };
              documentElement?: {
                outerHTML?: string;
              };
              title?: string;
              scripts?: ArrayLike<{ textContent?: string | null }>;
            };
            location?: {
              href?: string;
            };
          };
          const canvas = browserWindow.document?.querySelector('.qrcode-img-area canvas') ?? null;
          const bodyText = browserWindow.document?.body?.innerText ?? '';
          const html = browserWindow.document?.documentElement?.outerHTML ?? '';
          const scripts = Array.from(browserWindow.document?.scripts ?? [])
            .map((script) => script.textContent || '')
            .join('\n\n');
          const combined = `${html}\n${scripts}`;
          const qrUrl = combined.match(/https?:\/\/qr\.alipay\.com\/[^'"\\\s<>()]+/i)?.[0] ?? null;
          const mobilePayUrl =
            combined.match(/https?:\/\/mobilecodec\.alipay\.com\/show\.htm\?code=[^'"\\\s<>()]+/i)?.[0] ??
            (qrUrl
              ? `https://mobilecodec.alipay.com/client_download.htm?qrcode=${encodeURIComponent(
                qrUrl.replace(/^https?:\/\/qr\.alipay\.com\//i, ''),
              )}`
              : null);
          const orderNoMatch = bodyText.match(/订单号[:：]\s*([A-Z0-9]+)/i);
          const finalUrl = browserWindow.location?.href ?? '';
          const payOrderId = new URL(finalUrl || 'https://invalid.local').searchParams.get('payOrderId');
          return {
            finalUrl: finalUrl || null,
            finalTitle: browserWindow.document?.title || null,
            qrUrl,
            mobilePayUrl,
            qrDataUrl: canvas?.toDataURL?.('image/png') ?? null,
            qrWidth: canvas?.width ?? null,
            qrHeight: canvas?.height ?? null,
            bodyTextSnippet: bodyText.slice(0, 2000) || null,
            payOrderId,
            orderNo: orderNoMatch?.[1] ?? null,
          };
        });

        return {
          ok: Boolean(evaluation.qrDataUrl || evaluation.qrUrl || evaluation.mobilePayUrl),
          finalUrl: evaluation.finalUrl,
          finalTitle: evaluation.finalTitle,
          alipayPageUrl: evaluation.finalUrl,
          qrUrl: evaluation.qrUrl,
          mobilePayUrl: evaluation.mobilePayUrl,
          payOrderId: evaluation.payOrderId,
          orderNo: evaluation.orderNo,
          qrDataUrl: evaluation.qrDataUrl,
          qrMimeType: evaluation.qrDataUrl?.startsWith('data:image/png') ? 'image/png' : null,
          qrWidth: evaluation.qrWidth,
          qrHeight: evaluation.qrHeight,
          bodyTextSnippet: evaluation.bodyTextSnippet,
          extractor,
          error: evaluation.qrDataUrl || evaluation.qrUrl || evaluation.mobilePayUrl ? null : 'LDXP_QR_CANVAS_NOT_FOUND',
        };
      } finally {
        await browser.close();
      }
    } catch (error) {
      return makeEmptyResult(
        extractor,
        error instanceof Error ? error.message : 'LDXP_QR_EXTRACTION_FAILED',
      );
    }
  }

  const primaryExtractor = config.headless ? 'playwright_chrome_headless' : 'playwright_chrome_headful';
  if (!config.enabled) {
    return makeEmptyResult(primaryExtractor, 'LDXP_QR_EXTRACTION_DISABLED');
  }

  const primary = await runExtraction(config);
  const shouldRetryHeadful =
    config.headless &&
    config.allowHeadfulRetry &&
    (!primary.ok || (!primary.qrDataUrl && !primary.qrUrl && !primary.mobilePayUrl));

  if (!shouldRetryHeadful) {
    return primary;
  }

  const retried = await runExtraction({
    ...config,
    headless: false,
    browserChannel: config.headfulRetryBrowserChannel || 'chrome',
  });
  if (retried.ok || retried.qrDataUrl || retried.qrUrl || retried.mobilePayUrl) {
    return retried;
  }
  return primary;
}

export function buildGatewayFormPayload(form: LdxpGatewayForm): string {
  return new URLSearchParams(form.fields).toString();
}

export async function readDebugTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}
