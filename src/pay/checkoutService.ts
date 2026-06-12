import {
  getMembershipOrderAggregate,
  getMembershipOrderById,
  updateMembershipOrderMetadata,
  type MembershipOrder,
  type OrderAggregate,
} from '../db/billingRepo.js';
import { loadLdxpConfig } from './ldxpClient.js';
import {
  buildServerQrDataUrl,
  extractLdxpQrByPlaywright,
  fetchLdxpPaymentPageArtifacts,
  loadLdxpQrExtractionConfig,
  type LdxpGatewayForm,
  type LdxpPaymentPageArtifacts,
  type LdxpQrExtractionResult,
} from './qrExtractor.js';
import {
  LdxpStorefrontClient,
  loadDefaultStorefrontContact,
  loadLdxpStorefrontConfig,
  type LdxpResolvedGoodsMatch,
  type LdxpStorefrontChannel,
  type LdxpStorefrontQueryResult,
} from './storefrontClient.js';
import { reconcileMembershipOrderWithLdxp, type ReconcileMembershipOrderResult } from './reconcileService.js';
import { getPlanById, getPlanPaymentGoodsKey } from '../db/subscriptionRepo.js';

interface LdxpStoredSessionMetadata {
  version: 1;
  provider: 'ldxp_storefront';
  remoteTradeNo: string;
  payUrl: string;
  payPageUrl: string | null;
  orderNoHint: string | null;
  subject: string | null;
  goodsKey: string | null;
  goodsName: string | null;
  goodsType: string | null;
  channelId: number | null;
  channelName: string | null;
  channelCode: string | null;
  channelIcon: string | null;
  remoteAmountYuan: number | null;
  clientReference: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  warnings: string[];
  lastQueryCode?: number | null;
  lastQueryMessage?: string | null;
  lastQueryAt?: string | null;
}

interface CachedQrPayload {
  storedAt: number;
  expiresAt: number;
  value: LdxpQrExtractionResult;
}

export interface EnsureCheckoutSessionOptions {
  createIfMissing?: boolean;
  refreshRemote?: boolean;
  refreshArtifacts?: boolean;
  extractQr?: boolean;
  preferredGoodsKey?: string | null;
}

export interface CheckoutSessionView {
  available: boolean;
  status: 'ready' | 'pending' | 'unavailable' | 'error';
  provider: 'ldxp_storefront';
  localOrderId: string;
  localOrderNo: string;
  localStatus: string;
  localAmountCents: number;
  clientReference: string | null;
  remoteTradeNo: string | null;
  orderNoHint: string | null;
  subject: string | null;
  goods: {
    key: string | null;
    name: string | null;
    type: string | null;
  };
  channel: {
    id: number | null;
    name: string | null;
    code: string | null;
    icon: string | null;
  };
  remoteAmountYuan: number | null;
  payUrl: string | null;
  payPageUrl: string | null;
  gatewayForm: LdxpGatewayForm | null;
  qr: {
    available: boolean;
    dataUrl: string | null;
    qrUrl: string | null;
    mobilePayUrl: string | null;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    payOrderId: string | null;
    alipayPageUrl: string | null;
    extractedAt: string | null;
    extractor: string | null;
    error: string | null;
  };
  warnings: string[];
  reason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CheckoutStatusView {
  order: MembershipOrder;
  aggregate: OrderAggregate | null;
  paymentSession: CheckoutSessionView | null;
  storefront: {
    queried: boolean;
    code: number | null;
    message: string | null;
    paid: boolean;
    raw: LdxpStorefrontQueryResult | null;
    error: string | null;
  };
  reconcile: ReconcileMembershipOrderResult | null;
}

const STORE_KEY = 'ldxp_storefront_session';
const qrCache = new Map<string, CachedQrPayload>();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWarnings(items: Array<string | null | undefined>): string[] {
  return items.map((item) => String(item || '').trim()).filter(Boolean);
}

function readStoredSession(order: MembershipOrder): LdxpStoredSessionMetadata | null {
  const raw = order.metadata?.[STORE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.provider !== 'ldxp_storefront' || typeof value.remoteTradeNo !== 'string' || typeof value.payUrl !== 'string') {
    return null;
  }
  return {
    version: 1,
    provider: 'ldxp_storefront',
    remoteTradeNo: value.remoteTradeNo,
    payUrl: value.payUrl,
    payPageUrl: typeof value.payPageUrl === 'string' ? value.payPageUrl : null,
    orderNoHint: typeof value.orderNoHint === 'string' ? value.orderNoHint : null,
    subject: typeof value.subject === 'string' ? value.subject : null,
    goodsKey: typeof value.goodsKey === 'string' ? value.goodsKey : null,
    goodsName: typeof value.goodsName === 'string' ? value.goodsName : null,
    goodsType: typeof value.goodsType === 'string' ? value.goodsType : null,
    channelId: typeof value.channelId === 'number' ? value.channelId : null,
    channelName: typeof value.channelName === 'string' ? value.channelName : null,
    channelCode: typeof value.channelCode === 'string' ? value.channelCode : null,
    channelIcon: typeof value.channelIcon === 'string' ? value.channelIcon : null,
    remoteAmountYuan: typeof value.remoteAmountYuan === 'number' ? value.remoteAmountYuan : null,
    clientReference: typeof value.clientReference === 'string' ? value.clientReference : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    warnings: Array.isArray(value.warnings) ? value.warnings.map((item) => String(item || '')).filter(Boolean) : [],
    lastQueryCode: typeof value.lastQueryCode === 'number' ? value.lastQueryCode : null,
    lastQueryMessage: typeof value.lastQueryMessage === 'string' ? value.lastQueryMessage : null,
    lastQueryAt: typeof value.lastQueryAt === 'string' ? value.lastQueryAt : null,
  };
}

function writeQrCache(orderId: string, value: LdxpQrExtractionResult) {
  const ttlMs = Math.max(5 * 60 * 1000, Number(process.env.LDXP_QR_CACHE_TTL_MS ?? 30 * 60 * 1000));
  qrCache.set(orderId, {
    storedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

function readQrCache(orderId: string): LdxpQrExtractionResult | null {
  const cached = qrCache.get(orderId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    qrCache.delete(orderId);
    return null;
  }
  return cached.value;
}

function choosePrimaryChannel(channels: LdxpStorefrontChannel[]): LdxpStorefrontChannel | null {
  return (
    channels.find((item) => (item.status ?? 1) === 1 && (item.custom_status ?? 1) === 1) ??
    channels.find((item) => (item.status ?? 1) === 1) ??
    channels[0] ??
    null
  );
}

async function buildArtifacts(payUrl: string, refreshArtifacts: boolean): Promise<LdxpPaymentPageArtifacts | null> {
  if (!refreshArtifacts) return null;
  try {
    return await fetchLdxpPaymentPageArtifacts(payUrl);
  } catch {
    return null;
  }
}

function buildStoredSessionFromRemote(input: {
  order: MembershipOrder;
  resolvedGoods: LdxpResolvedGoodsMatch;
  channel: LdxpStorefrontChannel | null;
  remoteTradeNo: string;
  remoteAmountYuan: number | null;
  payUrl: string;
  artifacts: LdxpPaymentPageArtifacts | null;
  warnings: string[];
}): LdxpStoredSessionMetadata {
  const stamp = nowIso();
  const good = input.resolvedGoods.good;
  return {
    version: 1,
    provider: 'ldxp_storefront',
    remoteTradeNo: input.remoteTradeNo,
    payUrl: input.payUrl,
    payPageUrl: input.artifacts?.payPageUrl ?? null,
    orderNoHint: input.artifacts?.outTradeNo ?? input.remoteTradeNo,
    subject: input.artifacts?.subject ?? null,
    goodsKey: good?.goods_key ?? input.resolvedGoods.goodsKey,
    goodsName: good?.name ?? null,
    goodsType: good?.goods_type ?? null,
    channelId: input.channel?.id ?? null,
    channelName: input.channel?.show_name ?? input.channel?.name ?? null,
    channelCode: input.channel?.code ?? null,
    channelIcon: input.channel?.paytype?.icon ?? null,
    remoteAmountYuan: input.remoteAmountYuan,
    clientReference: input.order.client_reference ?? null,
    createdAt: stamp,
    updatedAt: stamp,
    warnings: input.warnings,
    lastQueryCode: null,
    lastQueryMessage: null,
    lastQueryAt: null,
  };
}

async function persistStoredSession(orderId: string, session: LdxpStoredSessionMetadata): Promise<void> {
  await updateMembershipOrderMetadata(orderId, {
    [STORE_KEY]: session,
  });
}

async function refreshStoredSessionQueryState(
  orderId: string,
  session: LdxpStoredSessionMetadata,
  queryState: { code: number | null; message: string | null },
): Promise<void> {
  const updated: LdxpStoredSessionMetadata = {
    ...session,
    updatedAt: nowIso(),
    lastQueryCode: queryState.code,
    lastQueryMessage: queryState.message,
    lastQueryAt: nowIso(),
  };
  await persistStoredSession(orderId, updated);
}

function buildCheckoutSessionView(input: {
  order: MembershipOrder;
  storedSession: LdxpStoredSessionMetadata | null;
  artifacts: LdxpPaymentPageArtifacts | null;
  qr: LdxpQrExtractionResult | null;
  reason: string | null;
  warnings?: string[];
}): CheckoutSessionView {
  const warnings = normalizeWarnings([...(input.storedSession?.warnings ?? []), ...(input.warnings ?? [])]);
  const gatewayForm = input.artifacts?.gatewayForm ?? null;
  const qr = input.qr;
  const available = Boolean(input.storedSession?.payUrl);
  const status: CheckoutSessionView['status'] = input.reason
    ? 'unavailable'
    : qr?.ok
      ? 'ready'
      : available
        ? 'pending'
        : 'error';
  return {
    available,
    status,
    provider: 'ldxp_storefront',
    localOrderId: input.order.id,
    localOrderNo: input.order.order_no,
    localStatus: input.order.status,
    localAmountCents: input.order.amount_cents,
    clientReference: input.storedSession?.clientReference ?? input.order.client_reference ?? null,
    remoteTradeNo: input.storedSession?.remoteTradeNo ?? null,
    orderNoHint: input.storedSession?.orderNoHint ?? input.artifacts?.outTradeNo ?? null,
    subject: input.storedSession?.subject ?? input.artifacts?.subject ?? null,
    goods: {
      key: input.storedSession?.goodsKey ?? null,
      name: input.storedSession?.goodsName ?? null,
      type: input.storedSession?.goodsType ?? null,
    },
    channel: {
      id: input.storedSession?.channelId ?? null,
      name: input.storedSession?.channelName ?? null,
      code: input.storedSession?.channelCode ?? null,
      icon: input.storedSession?.channelIcon ?? null,
    },
    remoteAmountYuan: input.storedSession?.remoteAmountYuan ?? null,
    payUrl: input.storedSession?.payUrl ?? null,
    payPageUrl: input.storedSession?.payPageUrl ?? input.artifacts?.payPageUrl ?? null,
    gatewayForm,
    qr: {
      available: Boolean(qr?.qrDataUrl),
      dataUrl: qr?.qrDataUrl ?? null,
      qrUrl: qr?.qrUrl ?? null,
      mobilePayUrl: qr?.mobilePayUrl ?? null,
      mimeType: qr?.qrMimeType ?? null,
      width: qr?.qrWidth ?? null,
      height: qr?.qrHeight ?? null,
      payOrderId: qr?.payOrderId ?? null,
      alipayPageUrl: qr?.alipayPageUrl ?? qr?.finalUrl ?? null,
      extractedAt: qr ? nowIso() : null,
      extractor: qr?.extractor ?? null,
      error: qr?.error ?? null,
    },
    warnings,
    reason: input.reason,
    createdAt: input.storedSession?.createdAt ?? null,
    updatedAt: input.storedSession?.updatedAt ?? null,
  };
}

async function buildFallbackQrPayload(input: {
  order: MembershipOrder;
  storedSession: LdxpStoredSessionMetadata | null;
  artifacts: LdxpPaymentPageArtifacts | null;
}): Promise<LdxpQrExtractionResult | null> {
  const payTarget = input.artifacts?.payPageUrl ?? input.storedSession?.payPageUrl ?? input.storedSession?.payUrl ?? null;
  if (!payTarget) {
    return null;
  }
  const qrDataUrl = await buildServerQrDataUrl(
    payTarget,
    input.order.order_no || input.storedSession?.subject || '支付宝支付二维码',
  );
  if (!qrDataUrl) {
    return null;
  }
  return {
    ok: true,
    finalUrl: payTarget,
    finalTitle: input.storedSession?.subject ?? input.order.title ?? '支付宝支付二维码',
    alipayPageUrl: input.artifacts?.payPageUrl ?? input.storedSession?.payPageUrl ?? null,
    qrUrl: null,
    mobilePayUrl: null,
    payOrderId: input.storedSession?.remoteTradeNo ?? null,
    orderNo: input.artifacts?.outTradeNo ?? input.storedSession?.orderNoHint ?? input.storedSession?.remoteTradeNo ?? input.order.order_no,
    qrDataUrl,
    qrMimeType: qrDataUrl.startsWith('data:image/svg+xml') ? 'image/svg+xml' : 'image/png',
    qrWidth: null,
    qrHeight: null,
    bodyTextSnippet: null,
    extractor: 'server_svg_qr',
    error: null,
  };
}

async function maybeExtractQr(orderId: string, payTargetUrl: string | null, extractQr: boolean): Promise<LdxpQrExtractionResult | null> {
  const cached = readQrCache(orderId);
  if (!extractQr) {
    return cached;
  }
  if (!payTargetUrl) {
    return cached;
  }
  const extracted = await extractLdxpQrByPlaywright(payTargetUrl, loadLdxpQrExtractionConfig());
  writeQrCache(orderId, extracted);
  return extracted;
}

export async function ensureLdxpCheckoutSession(
  order: MembershipOrder,
  options: EnsureCheckoutSessionOptions = {},
): Promise<CheckoutSessionView> {
  const merchantConfig = loadLdxpConfig();
  const storefrontConfig = loadLdxpStorefrontConfig();

  if (!merchantConfig.enabled || !storefrontConfig.enabled) {
    return buildCheckoutSessionView({
      order,
      storedSession: null,
      artifacts: null,
      qr: null,
      reason: '链动小铺前台支付尚未配置完成。',
    });
  }

  let latestOrder = order;
  let storedSession = readStoredSession(order);
  const storefrontClient = new LdxpStorefrontClient(storefrontConfig);

  if (!storedSession && options.createIfMissing === false) {
    return buildCheckoutSessionView({
      order,
      storedSession: null,
      artifacts: null,
      qr: readQrCache(order.id),
      reason: '当前订单还没有生成远端支付会话。',
    });
  }

  if (!storedSession || options.refreshRemote) {
    const plan = await getPlanById(order.plan_id);
    const resolvedGoods = await storefrontClient.resolveGoodsForMembership({
      planId: order.plan_id,
      amountCents: order.amount_cents,
      preferredGoodsKey:
        options.preferredGoodsKey ??
        (typeof order.metadata?.remoteGoodsKey === 'string' ? String(order.metadata.remoteGoodsKey) : null) ??
        getPlanPaymentGoodsKey(plan),
      title: order.title,
    });

    if (!resolvedGoods.goodsKey) {
      return buildCheckoutSessionView({
        order,
        storedSession: null,
        artifacts: null,
        qr: readQrCache(order.id),
        reason: resolvedGoods.reason,
        warnings: resolvedGoods.candidates.length > 0
          ? [`已发现远端商品 ${resolvedGoods.candidates.map((item) => `${item.name}:${item.goods_key}`).join('，')}`]
          : undefined,
      });
    }

    const channels = await storefrontClient.getUserChannels();
    const channel = choosePrimaryChannel(channels);
    if (!channel) {
      return buildCheckoutSessionView({
        order,
        storedSession: null,
        artifacts: null,
        qr: readQrCache(order.id),
        reason: '远端店铺没有可用的支付渠道。',
      });
    }

    const remoteOrder = await storefrontClient.createOrder({
      goodsKey: resolvedGoods.goodsKey,
      quantity: 1,
      channelId: channel.id,
      contact: order.client_reference?.trim() || loadDefaultStorefrontContact(merchantConfig),
      extend: {
        localOrderId: order.id,
        localOrderNo: order.order_no,
        planId: order.plan_id,
        userId: order.user_id,
      },
    });
    const artifacts = await buildArtifacts(remoteOrder.payurl, Boolean(options.refreshArtifacts));
    storedSession = buildStoredSessionFromRemote({
      order,
      resolvedGoods,
      channel,
      remoteTradeNo: remoteOrder.trade_no,
      remoteAmountYuan: typeof remoteOrder.total_amount === 'number' ? remoteOrder.total_amount : null,
      payUrl: remoteOrder.payurl,
      artifacts,
      warnings: normalizeWarnings([resolvedGoods.reason]),
    });
    await persistStoredSession(order.id, storedSession);
    latestOrder = (await getMembershipOrderById(order.id)) ?? order;
  }

  const artifacts = storedSession?.payUrl
    ? await buildArtifacts(storedSession.payUrl, Boolean(options.refreshArtifacts))
    : null;
  let qr: LdxpQrExtractionResult | null = null;
  if (Boolean(options.extractQr)) {
    qr = await maybeExtractQr(order.id, storedSession?.payPageUrl ?? storedSession?.payUrl ?? null, true);
    if (!qr?.qrDataUrl) {
      const fallbackQr = await buildFallbackQrPayload({
        order: latestOrder,
        storedSession,
        artifacts,
      });
      if (fallbackQr) {
        qr = fallbackQr;
        writeQrCache(order.id, fallbackQr);
      }
    }
  } else {
    qr = await maybeExtractQr(order.id, storedSession?.payPageUrl ?? storedSession?.payUrl ?? null, false);
  }

  if (storedSession && qr?.qrDataUrl) {
    await updateMembershipOrderMetadata(order.id, {
      payment_qr_image: qr.qrDataUrl,
      payment_url: storedSession.payUrl,
      pay_url: storedSession.payUrl,
      provider_order_no: storedSession.remoteTradeNo,
      pay_order_id: qr.payOrderId ?? storedSession.orderNoHint ?? storedSession.remoteTradeNo,
    });
  }

  return buildCheckoutSessionView({
    order: latestOrder,
    storedSession,
    artifacts,
    qr,
    reason: null,
  });
}

export async function getLdxpCheckoutStatus(
  order: MembershipOrder,
  input: {
    refreshSession?: boolean;
    extractQr?: boolean;
    triggerReconcile?: boolean;
  } = {},
): Promise<CheckoutStatusView> {
  let latestOrder = order;
  let paymentSession = await ensureLdxpCheckoutSession(order, {
    createIfMissing: false,
    refreshArtifacts: Boolean(input.refreshSession),
    extractQr: Boolean(input.extractQr),
  });

  const storedSession = readStoredSession(latestOrder);
  let storefront: CheckoutStatusView['storefront'] = {
    queried: false,
    code: null,
    message: null,
    paid: false,
    raw: null,
    error: null,
  };
  let reconcile: ReconcileMembershipOrderResult | null = null;

  if (storedSession?.remoteTradeNo) {
    try {
      const storefrontClient = new LdxpStorefrontClient(loadLdxpStorefrontConfig());
      const raw = await storefrontClient.queryOrder(storedSession.remoteTradeNo);
      storefront = {
        queried: true,
        code: raw.code,
        message: raw.msg,
        paid: raw.code === 1,
        raw,
        error: null,
      };
      await refreshStoredSessionQueryState(order.id, storedSession, {
        code: raw.code,
        message: raw.msg,
      });
    } catch (error) {
      storefront = {
        queried: true,
        code: null,
        message: null,
        paid: false,
        raw: null,
        error: error instanceof Error ? error.message : 'LDXP_STOREFRONT_QUERY_FAILED',
      };
    }
  }

  if (input.triggerReconcile !== false && (storefront.paid || order.status === 'pending' || order.status === 'review_required')) {
    try {
      reconcile = await reconcileMembershipOrderWithLdxp(order);
    } catch {
      reconcile = null;
    }
  }

  latestOrder = (await getMembershipOrderById(order.id)) ?? order;
  const aggregate = await getMembershipOrderAggregate(order.id);
  paymentSession = await ensureLdxpCheckoutSession(latestOrder, {
    createIfMissing: false,
    refreshArtifacts: false,
    extractQr: Boolean(input.extractQr),
  });

  return {
    order: latestOrder,
    aggregate,
    paymentSession,
    storefront,
    reconcile,
  };
}
