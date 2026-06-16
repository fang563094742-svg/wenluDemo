import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import {
  createMembershipOrder,
  getMembershipOrderAggregate,
  getMembershipOrderById,
  listUserMembershipOrders,
  markMembershipOrderPaid,
  markMembershipOrderForManualReview,
  approveMembershipOrderReview,
} from '../db/billingRepo.js';
import { listPlans } from '../db/subscriptionRepo.js';
import {
  buildLdxpClientReference,
  loadLdxpConfig,
  LdxpMerchantClient,
} from '../pay/ldxpClient.js';
import {
  ensureLdxpCheckoutSession,
  type CheckoutSessionView,
} from '../pay/checkoutService.js';
import { buildServerQrDataUrl } from '../pay/qrExtractor.js';
import { reconcileMembershipOrderWithLdxp, runAutoReconcileSweep } from '../pay/reconcileService.js';

export const paymentRouter: Router = Router();

function normalizeRemoteAddress(address: string | null | undefined): string {
  return String(address ?? '')
    .trim()
    .toLowerCase()
    .split('%')[0]!;
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) {
    return false;
  }
  if (normalized === '::1' || normalized.startsWith('127.')) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.slice('::ffff:'.length));
  }
  return false;
}

function requireLocalAdminAccess(req: Request, res: Response, next: NextFunction): void {
  // 仅信任 socket 上的来源地址，避免客户端伪造 X-Forwarded-For 绕过限制。
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(403).json({ error: '该接口仅限本地后台访问' });
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanFlag(value: string | string[] | undefined): boolean {
  const normalized = String(firstParam(value) ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

type ExistingOrder = Awaited<ReturnType<typeof getMembershipOrderById>> extends infer T
  ? Exclude<T, null>
  : never;

interface PaymentSessionResponse {
  provider: string;
  available: boolean;
  status: CheckoutSessionView['status'] | 'error';
  qrDataUrl: string | null;
  qrUrl?: string | null;
  mobilePayUrl?: string | null;
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
  mobileBridgeUrl?: string | null;
  raw: CheckoutSessionView;
}

const PAYMENT_BRIDGE_SECRET =
  process.env.PAYMENT_BRIDGE_SECRET ||
  process.env.JWT_SECRET ||
  'wenlu-dev-secret-change-in-prod';

const PAYMENT_BRIDGE_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.PAYMENT_BRIDGE_TTL_MS ?? 30 * 60 * 1000),
);

function toPaymentSessionResponse(session: CheckoutSessionView): PaymentSessionResponse {
  return {
    provider: session.provider,
    available: session.available,
    status: session.status,
    qrDataUrl: session.qr.dataUrl,
    qrUrl: session.qr.qrUrl,
    mobilePayUrl: session.qr.mobilePayUrl,
    paymentUrl: session.payUrl,
    payPageUrl: session.payPageUrl,
    providerOrderNo: session.remoteTradeNo,
    payOrderId: session.qr.payOrderId ?? session.orderNoHint,
    clientReference: session.clientReference,
    localOrderId: session.localOrderId,
    localOrderNo: session.localOrderNo,
    localStatus: session.localStatus,
    localAmountCents: session.localAmountCents,
    warnings: session.warnings,
    reason: session.reason,
    raw: session,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.startsWith('127.')
  );
}

function getBridgeBaseUrl(req: Request): string | null {
  const configured = String(process.env.PUBLIC_APP_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (configured) return configured;

  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]!.trim();
  const host = forwardedHost || String(req.headers.host ?? '').trim();
  if (!host) return null;

  const hostname = host.split(':')[0]!.trim();
  if (isLoopbackHost(hostname)) return null;

  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http')
    .split(',')[0]!
    .trim()
    .toLowerCase();
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function buildBridgeSignature(orderId: string, expiresAtMs: number): string {
  return createHmac('sha256', PAYMENT_BRIDGE_SECRET)
    .update(`${orderId}.${expiresAtMs}`)
    .digest('hex');
}

function verifyBridgeSignature(orderId: string, expiresAtMs: number, signature: string): boolean {
  const expected = buildBridgeSignature(orderId, expiresAtMs);
  const left = Buffer.from(String(signature || ''), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function buildMobileBridgeUrl(req: Request, orderId: string): string | null {
  const baseUrl = getBridgeBaseUrl(req);
  if (!baseUrl) return null;
  const expiresAtMs = Date.now() + PAYMENT_BRIDGE_TTL_MS;
  const sig = buildBridgeSignature(orderId, expiresAtMs);
  const url = new URL('/payment-bridge.html', baseUrl);
  url.searchParams.set('orderId', orderId);
  url.searchParams.set('exp', String(expiresAtMs));
  url.searchParams.set('sig', sig);
  return url.toString();
}

async function decoratePaymentSessionForClient(
  req: Request,
  response: PaymentSessionResponse | null,
): Promise<PaymentSessionResponse | null> {
  if (!response || !response.localOrderId) return response;

  const mobileBridgeUrl = buildMobileBridgeUrl(req, response.localOrderId);
  const rawQr = response.raw?.qr ?? null;
  const rawMobilePayUrl =
    (rawQr && typeof rawQr.mobilePayUrl === 'string' && rawQr.mobilePayUrl.trim()) ||
    (rawQr && typeof rawQr.qrUrl === 'string' && rawQr.qrUrl.trim()) ||
    null;

  const hasOriginalQrDataUrl =
    typeof response.qrDataUrl === 'string' &&
    response.qrDataUrl.trim().startsWith('data:image/');

  if (hasOriginalQrDataUrl) {
    return mobileBridgeUrl
      ? {
          ...response,
          mobileBridgeUrl,
        }
      : response;
  }

  const qrPayloadValue = rawMobilePayUrl || mobileBridgeUrl;

  if (!qrPayloadValue) {
    return mobileBridgeUrl
      ? {
          ...response,
          mobileBridgeUrl,
        }
      : response;
  }

  const qrDataUrl = await buildServerQrDataUrl(
    qrPayloadValue,
    `${response.localOrderNo || response.localOrderId} 手机支付入口`,
  );
  if (!qrDataUrl) {
    return mobileBridgeUrl
      ? {
          ...response,
          mobileBridgeUrl,
        }
      : response;
  }

  return {
    ...response,
    qrDataUrl,
    mobileBridgeUrl: mobileBridgeUrl || response.mobileBridgeUrl || null,
    warnings: [...(response.warnings || []), '当前二维码已切换为手机扫码支付入口，建议直接使用手机扫码。'],
    raw: {
      ...response.raw,
      qr: {
        ...response.raw.qr,
        dataUrl: qrDataUrl,
      },
    } as CheckoutSessionView,
  };
}

async function loadPaymentSessionForOrder(
  order: ExistingOrder,
  options: {
    createIfMissing?: boolean;
    refreshRemote?: boolean;
    refreshArtifacts?: boolean;
    extractQr?: boolean;
  } = {},
): Promise<PaymentSessionResponse | null> {
  try {
    const session = await ensureLdxpCheckoutSession(order, options);
    return toPaymentSessionResponse(session);
  } catch (error) {
    if (options.extractQr) {
      try {
        const fallbackSession = await ensureLdxpCheckoutSession(order, {
          ...options,
          extractQr: false,
        });
        return toPaymentSessionResponse(fallbackSession);
      } catch {
        return null;
      }
    }
    throw error;
  }
}

function mergeAggregateOrder(
  aggregate: Awaited<ReturnType<typeof getMembershipOrderAggregate>> | null,
  fallbackOrder: ExistingOrder,
) {
  const baseOrder = aggregate?.order ?? fallbackOrder;
  return {
    ...baseOrder,
    latestPayment: aggregate?.latestPayment ?? null,
    grant: aggregate?.grant ?? null,
    subscription: aggregate?.subscription ?? null,
  };
}

paymentRouter.get('/bridge/resolve', async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.query.orderId as string | string[] | undefined);
    const expRaw = firstParam(req.query.exp as string | string[] | undefined);
    const sig = firstParam(req.query.sig as string | string[] | undefined);
    const expiresAtMs = Number(expRaw || 0);

    if (!orderId || !sig || !Number.isFinite(expiresAtMs)) {
      res.status(400).json({ error: '缺少桥接参数' });
      return;
    }
    if (expiresAtMs <= Date.now()) {
      res.status(410).json({ error: '支付桥接链接已过期，请重新生成二维码' });
      return;
    }
    if (!verifyBridgeSignature(orderId, expiresAtMs, sig)) {
      res.status(403).json({ error: '支付桥接签名无效' });
      return;
    }

    const order = await getMembershipOrderById(orderId);
    if (!order) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }

    const session = await ensureLdxpCheckoutSession(order, {
      createIfMissing: false,
      refreshArtifacts: true,
      extractQr: true,
    });
    const paymentUrl = session.qr.mobilePayUrl || session.qr.qrUrl || session.payUrl;
    const payPageUrl = session.payPageUrl;
    const gatewayForm = paymentUrl && paymentUrl !== session.payUrl
      ? null
      : session.gatewayForm;

    res.json({
      success: true,
      bridge: {
        orderId: order.id,
        orderNo: order.order_no,
        title: order.title,
        amountCents: order.amount_cents,
        clientReference: order.client_reference,
        paymentUrl,
        payPageUrl,
        gatewayForm,
        prefersMobile: Boolean(session.qr.mobilePayUrl || session.qr.qrUrl),
        providerOrderNo: session.remoteTradeNo || null,
        payOrderId: session.qr.payOrderId || session.orderNoHint || null,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '桥接支付解析失败' });
  }
});


paymentRouter.use(requireAuth);

paymentRouter.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await listPlans();
    const ldxp = new LdxpMerchantClient(loadLdxpConfig());
    res.json({ success: true, plans, checkout: ldxp.getCheckoutInfo() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '获取套餐失败' });
  }
});

paymentRouter.get('/checkout-info', async (_req: Request, res: Response) => {
  try {
    const ldxp = new LdxpMerchantClient(loadLdxpConfig());
    res.json({ success: true, checkout: ldxp.getCheckoutInfo() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '获取支付信息失败' });
  }
});

paymentRouter.get('/orders', async (req: Request, res: Response) => {
  try {
    const rawLimit = firstParam(req.query.limit as string | string[] | undefined);
    const limit = Math.min(Number(rawLimit) || 20, 100);
    const triggerReconcile = parseBooleanFlag(req.query.autoReconcile as string | string[] | undefined);
    let sweep = null;
    if (triggerReconcile) {
      sweep = await runAutoReconcileSweep({ limit: Math.min(limit, 20) });
    }
    const orders = await listUserMembershipOrders(req.user!.userId, limit);
    const aggregates = await Promise.all(orders.map(async (order) => getMembershipOrderAggregate(order.id)));
    const decoratedOrders = orders.map((order, index) => mergeAggregateOrder(aggregates[index] ?? null, order));
    res.json({ success: true, orders: decoratedOrders, autoReconcile: sweep });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '获取订单失败' });
  }
});

paymentRouter.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: '缺少订单 ID' });
      return;
    }
    const order = await getMembershipOrderById(orderId);
    if (!order || order.user_id !== req.user!.userId) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }
    const aggregate = await getMembershipOrderAggregate(order.id);
    const paymentSession = await decoratePaymentSessionForClient(req, await loadPaymentSessionForOrder(order, {
      createIfMissing: false,
      refreshArtifacts: parseBooleanFlag(req.query.refresh as string | string[] | undefined),
      extractQr: parseBooleanFlag(req.query.extractQr as string | string[] | undefined),
    }));
    res.json({
      success: true,
      order: {
        ...(aggregate ?? { order, latestPayment: null, grant: null, subscription: null }),
        paymentSession,
      },
      paymentSession,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '获取订单详情失败' });
  }
});

paymentRouter.post('/orders', async (req: Request, res: Response) => {
  try {
    const { planId, paymentChannel, title, metadata, clientReference, idempotencyKey } = req.body as {
      planId?: string;
      paymentChannel?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      clientReference?: string;
      idempotencyKey?: string;
    };
    if (!planId) {
      res.status(400).json({ error: '缺少 planId' });
      return;
    }
    const checkout = loadLdxpConfig();
    const normalizedClientReference =
      (typeof clientReference === 'string' && clientReference.trim()) ||
      buildLdxpClientReference(checkout.supportContact || '17865770178');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const order = await createMembershipOrder({
      userId: req.user!.userId,
      planId,
      paymentChannel: paymentChannel || 'ldxp_alipay_qr',
      title,
      metadata,
      clientReference: normalizedClientReference,
      idempotencyKey,
      expiresAt,
    });
    const ldxp = new LdxpMerchantClient(checkout);
    const session = await ensureLdxpCheckoutSession(order, {
      createIfMissing: true,
      refreshRemote: true,
      refreshArtifacts: true,
      extractQr: true,
    });
    const paymentSession = await decoratePaymentSessionForClient(req, toPaymentSessionResponse(session));
    const latestOrder = (await getMembershipOrderById(order.id)) ?? order;

    void ensureLdxpCheckoutSession(latestOrder, {
      createIfMissing: false,
      refreshRemote: false,
      refreshArtifacts: false,
      extractQr: true,
    }).catch(() => null);

    res.status(201).json({
      success: true,
      order: latestOrder,
      paymentSession,
      checkout: {
        ...ldxp.getCheckoutInfo(),
        clientReference: normalizedClientReference,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建订单失败';
    if (message.startsWith('PLAN_INACTIVE:')) {
      res.status(400).json({ error: '当前套餐已下架，请刷新页面后重新选择可用套餐' });
      return;
    }
    if (message.startsWith('plan not found:')) {
      res.status(404).json({ error: '套餐不存在，请刷新页面后重试' });
      return;
    }
    res.status(500).json({ error: message });
  }
});

paymentRouter.post('/orders/:id/reconcile', async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: '缺少订单 ID' });
      return;
    }
    const order = await getMembershipOrderById(orderId);
    if (!order || order.user_id !== req.user!.userId) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }
    const result = await reconcileMembershipOrderWithLdxp(order);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '自动核单失败' });
  }
});

paymentRouter.post('/orders/:id/mark-paid', requireLocalAdminAccess, async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: '缺少订单 ID' });
      return;
    }
    const order = await getMembershipOrderById(orderId);
    if (!order) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }
    const result = await markMembershipOrderPaid({
      orderId: order.id,
      channel: String((req.body as any)?.channel || order.payment_channel || 'manual'),
      provider: String((req.body as any)?.provider || 'manual'),
      providerTransactionId: (req.body as any)?.providerTransactionId ? String((req.body as any).providerTransactionId) : undefined,
      amountCents: Number((req.body as any)?.amountCents || order.amount_cents),
      callbackPayload: (req.body as any)?.callbackPayload || req.body,
      operator: req.user!.userId,
      skipAmountCheck: Boolean((req.body as any)?.skipAmountCheck),
      reviewNote: (req.body as any)?.reviewNote ? String((req.body as any).reviewNote) : undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '标记支付成功失败' });
  }
});

paymentRouter.post('/orders/:id/manual-review', requireLocalAdminAccess, async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: '缺少订单 ID' });
      return;
    }
    const result = await markMembershipOrderForManualReview({
      orderId,
      reviewer: req.user!.userId,
      reason: String((req.body as any)?.reason || '需要人工复核'),
      paymentId: (req.body as any)?.paymentId ? String((req.body as any).paymentId) : undefined,
      note: (req.body as any)?.note ? String((req.body as any).note) : undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '提交人工复核失败' });
  }
});

paymentRouter.post('/orders/:id/approve-review', requireLocalAdminAccess, async (req: Request, res: Response) => {
  try {
    const orderId = firstParam(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: '缺少订单 ID' });
      return;
    }
    const result = await approveMembershipOrderReview(
      orderId,
      req.user!.userId,
      (req.body as any)?.note ? String((req.body as any).note) : undefined,
    );
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '复核通过失败' });
  }
});
