import { chromium } from 'playwright';
import { loadLdxpQrExtractionConfig } from './qrExtractor.js';

export interface BrowserCheckoutSession {
  provider: 'ldxp_browser_server';
  available: boolean;
  status: 'ready' | 'pending' | 'error';
  qrDataUrl: string | null;
  qrUrl: string | null;
  mobilePayUrl: string | null;
  paymentUrl: string | null;
  payPageUrl: string | null;
  providerOrderNo: string | null;
  payOrderId: string | null;
  clientReference: string | null;
  localOrderId: string;
  localOrderNo: string;
  localStatus: string;
  localAmountCents: number;
  warnings: string[];
  reason: string | null;
  extractedAt: string;
}

export interface CreateBrowserCheckoutInput {
  shopUrl: string;
  amountCents: number;
  clientReference: string;
  localOrderId: string;
  localOrderNo: string;
  localStatus: string;
}

function parseAmountCentsFromText(text: string): number | null {
  const match = text.match(/(?:¥|￥)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function buildErrorSession(input: CreateBrowserCheckoutInput, reason: string): BrowserCheckoutSession {
  return {
    provider: 'ldxp_browser_server',
    available: false,
    status: 'error',
    qrDataUrl: null,
    qrUrl: null,
    mobilePayUrl: null,
    paymentUrl: null,
    payPageUrl: null,
    providerOrderNo: null,
    payOrderId: null,
    clientReference: input.clientReference,
    localOrderId: input.localOrderId,
    localOrderNo: input.localOrderNo,
    localStatus: input.localStatus,
    localAmountCents: input.amountCents,
    warnings: [],
    reason,
    extractedAt: new Date().toISOString(),
  };
}

export async function createBrowserCheckoutSession(input: CreateBrowserCheckoutInput): Promise<BrowserCheckoutSession> {
  const config = loadLdxpQrExtractionConfig();
  if (!input.shopUrl) {
    return buildErrorSession(input, '未配置支付店铺地址。');
  }

  const browser = await chromium.launch({
    channel: config.browserChannel || undefined,
    executablePath: config.executablePath || undefined,
    headless: config.headless,
  });

  try {
    const context = await browser.newContext({
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight,
      },
    });
    const page = await context.newPage();
    const warnings: string[] = [];

    await page.goto(input.shopUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
    await page.waitForTimeout(4000);

    const goods = page.locator('.goods_item');
    const goodsCount = await goods.count();
    if (!goodsCount) {
      return buildErrorSession(input, '店铺页面未找到可下单商品。');
    }

    let selectedIndex = 0;
    for (let index = 0; index < goodsCount; index += 1) {
      const text = await goods.nth(index).innerText().catch(() => '');
      const amountCents = parseAmountCentsFromText(text);
      if (amountCents === input.amountCents) {
        selectedIndex = index;
        break;
      }
    }

    const selectedText = await goods.nth(selectedIndex).innerText().catch(() => '');
    const selectedAmountCents = parseAmountCentsFromText(selectedText);
    if (selectedAmountCents !== null && selectedAmountCents !== input.amountCents) {
      warnings.push(`当前店铺自动选择的商品金额为 ${selectedAmountCents} 分，本地订单金额为 ${input.amountCents} 分，请在后台确认店铺商品配置。`);
    }

    await goods.nth(selectedIndex).click({ timeout: Math.min(config.timeoutMs, 30_000) });
    await page.waitForTimeout(1500);

    const contactInput = page.getByPlaceholder('请输入联系方式方便查询订单');
    if (await contactInput.count()) {
      await contactInput.fill(input.clientReference, { timeout: Math.min(config.timeoutMs, 30_000) });
    }

    const payButton = page.getByRole('button', { name: '去支付' });
    if (!(await payButton.count())) {
      return buildErrorSession(input, '店铺页面未找到“去支付”按钮。');
    }

    let popup = null;
    try {
      [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: Math.min(config.timeoutMs, 30_000) }),
        payButton.click({ timeout: Math.min(config.timeoutMs, 30_000) }),
      ]);
    } catch {
      await payButton.click({ timeout: Math.min(config.timeoutMs, 30_000) });
    }

    const target = popup ?? page;
    await target.waitForLoadState('domcontentloaded', {
      timeout: Math.min(config.timeoutMs, 30_000),
    }).catch(() => undefined);
    await target.waitForTimeout(config.settleMs > 0 ? config.settleMs : 8_000);

      const evaluation = await target.evaluate(() => {
        const browserWindow = globalThis as unknown as {
          location?: { href?: string };
          document?: {
            title?: string;
            body?: { innerText?: string };
            documentElement?: { outerHTML?: string };
            scripts?: ArrayLike<{ textContent?: string | null }>;
            querySelectorAll?: (
              selector: string,
            ) => ArrayLike<{ width?: number; height?: number; toDataURL?: (mimeType?: string) => string }>;
          };
        };
      const bodyText = browserWindow.document?.body?.innerText ?? '';
      const orderNoMatch = bodyText.match(/订单号[:：]\s*([A-Z0-9]+)/i);
      const canvases = Array.from(browserWindow.document?.querySelectorAll?.('canvas') ?? []);
      const qrCanvas = canvases.find((item) => (item.width ?? 0) >= 120 && (item.height ?? 0) >= 120) ?? canvases[0] ?? null;
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
      return {
        finalUrl: browserWindow.location?.href || null,
        finalTitle: browserWindow.document?.title || null,
        qrDataUrl: qrCanvas && typeof qrCanvas.toDataURL === 'function' ? qrCanvas.toDataURL('image/png') : null,
        qrUrl,
        mobilePayUrl,
        orderNo: orderNoMatch?.[1] ?? null,
      };
    });

    const finalUrl = evaluation.finalUrl || target.url() || null;
    let payOrderId: string | null = null;
    try {
      payOrderId = finalUrl ? new URL(finalUrl).searchParams.get('payOrderId') : null;
    } catch {
      payOrderId = null;
    }

    return {
      provider: 'ldxp_browser_server',
      available: Boolean(finalUrl || evaluation.qrDataUrl || evaluation.qrUrl || evaluation.mobilePayUrl),
      status: evaluation.qrDataUrl || evaluation.qrUrl || evaluation.mobilePayUrl ? 'ready' : 'pending',
      qrDataUrl: evaluation.qrDataUrl,
      qrUrl: evaluation.qrUrl,
      mobilePayUrl: evaluation.mobilePayUrl,
      paymentUrl: evaluation.mobilePayUrl || evaluation.qrUrl || finalUrl,
      payPageUrl: finalUrl,
      providerOrderNo: evaluation.orderNo,
      payOrderId,
      clientReference: input.clientReference,
      localOrderId: input.localOrderId,
      localOrderNo: input.localOrderNo,
      localStatus: input.localStatus,
      localAmountCents: input.amountCents,
      warnings,
      reason: evaluation.qrDataUrl || evaluation.qrUrl || evaluation.mobilePayUrl ? null : '后端已创建支付会话，但暂未成功提取手机支付地址。',
      extractedAt: new Date().toISOString(),
    };
  } catch (error) {
    return buildErrorSession(
      input,
      error instanceof Error ? error.message : '浏览器支付会话创建失败',
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}
