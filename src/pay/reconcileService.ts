import {
  getMembershipOrderAggregate,
  listMembershipOrdersNeedingReconcile,
  markMembershipOrderPaid,
  markMembershipOrderForManualReview,
  type MembershipOrder,
  type OrderAggregate,
} from "../db/billingRepo.js";
import { getPool } from "../db/pool.js";
import type { PoolClient } from "pg";
import {
  isLdxpPaidOrder,
  loadLdxpConfig,
  LdxpMerchantClient,
  toLdxpAmountCents,
  type LdxpOrderDetail,
  type LdxpOrderListItem,
} from "./ldxpClient.js";

export interface ReconcileMembershipOrderResult {
  provider: "ldxp";
  ok: boolean;
  matched: boolean;
  paid: boolean;
  autoCredited: boolean;
  needsManualReview: boolean;
  reason: string;
  remoteOrder: LdxpOrderDetail | null;
  aggregate: OrderAggregate | null;
}

function mapLdxpReconcileErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.trim();
  if (!message) {
    return "自动核单暂时失败，请稍后再试。";
  }
  if (message.includes("操作频繁")) {
    return "支付平台核单过于频繁，请 10 分钟后再试。";
  }
  if (
    message.startsWith("LDXP_NON_JSON_RESPONSE:") ||
    message.startsWith("LDXP_HTML_BLOCK:") ||
    message.startsWith("LDXP_CHALLENGE") ||
    message.startsWith("LDXP_STOREFRONT_")
  ) {
    return "支付平台当前触发了风控校验，暂时无法自动核单，请稍后再试。";
  }
  if (message === "fetch failed" || message.includes("network") || message.includes("ECONN")) {
    return "支付平台网络暂时不可用，请稍后再试。";
  }
  return message;
}

function toDateFromUnixSeconds(value: number | null | undefined): Date | null {
  if (!value || value <= 0) return null;
  return new Date(value * 1000);
}

function isWithinReasonableWindow(remote: LdxpOrderListItem | LdxpOrderDetail, localOrder: MembershipOrder, hours: number): boolean {
  const createdAt = toDateFromUnixSeconds(remote.create_time);
  if (!createdAt) return false;
  const min = localOrder.created_at.getTime() - 10 * 60 * 1000;
  const max = localOrder.created_at.getTime() + hours * 60 * 60 * 1000;
  const stamp = createdAt.getTime();
  return stamp >= min && stamp <= max;
}

function buildExpectedReferences(order: MembershipOrder) {
  const exact = (order.client_reference ?? "").trim();
  const baseContact = exact.includes("#") ? exact.split("#")[0].trim() : exact;
  return {
    exact,
    baseContact,
  };
}

function readExpectedGoodsNames(order: MembershipOrder, fallbackGoodsName: string): string[] {
  const metadata = order.metadata && typeof order.metadata === "object" ? order.metadata : {};
  const storefrontSession =
    metadata.ldxp_storefront_session && typeof metadata.ldxp_storefront_session === "object"
      ? metadata.ldxp_storefront_session as Record<string, unknown>
      : {};
  const candidates = [
    typeof storefrontSession.goodsName === "string" ? storefrontSession.goodsName : "",
    typeof order.title === "string" ? order.title : "",
    fallbackGoodsName,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function filterRoughCandidates(
  rows: LdxpOrderListItem[],
  order: MembershipOrder,
  goodsNames: string[],
  hours: number,
): LdxpOrderListItem[] {
  return rows.filter((row) => {
    const amountMatches = toLdxpAmountCents(row.total_amount) === order.amount_cents;
    const remoteGoodsName = String(row.goods_name || "");
    const goodsMatches =
      goodsNames.length === 0
        || goodsNames.some((goodsName) => remoteGoodsName.includes(goodsName));
    return amountMatches && goodsMatches && isWithinReasonableWindow(row, order, hours);
  });
}

function chooseBestCandidate(
  details: LdxpOrderDetail[],
  order: MembershipOrder,
  expectedExactReference: string,
): { detail: LdxpOrderDetail | null; ambiguous: boolean } {
  const scored = details
    .map((detail) => {
      let score = 0;
      if ((detail.contact ?? "").trim() === expectedExactReference && expectedExactReference) score += 100;
      if (toLdxpAmountCents(detail.total_amount) === order.amount_cents) score += 20;
      if (isLdxpPaidOrder(detail)) score += 10;
      score += Math.max(detail.create_time, 0) / 1_000_000_000;
      return { detail, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { detail: null, ambiguous: false };
  }
  if (scored.length === 1) {
    return { detail: scored[0].detail, ambiguous: false };
  }

  const top = scored[0];
  const second = scored[1];
  const ambiguous = Math.abs(top.score - second.score) < 5;
  return { detail: top.detail, ambiguous };
}

export async function reconcileMembershipOrderWithLdxp(order: MembershipOrder): Promise<ReconcileMembershipOrderResult> {
  const config = loadLdxpConfig();
  if (!config.enabled) {
    return {
      provider: "ldxp",
      ok: false,
      matched: false,
      paid: false,
      autoCredited: false,
      needsManualReview: false,
      reason: "支付对账尚未配置，请先完成本地商户配置。",
      remoteOrder: null,
      aggregate: await getMembershipOrderAggregate(order.id),
    };
  }

  if (order.status === "fulfilled" || order.status === "paid") {
    return {
      provider: "ldxp",
      ok: true,
      matched: true,
      paid: true,
      autoCredited: true,
      needsManualReview: false,
      reason: "该订单已到账，无需重复核对。",
      remoteOrder: null,
      aggregate: await getMembershipOrderAggregate(order.id),
    };
  }

  try {
    const client = new LdxpMerchantClient(config);
    const expected = buildExpectedReferences(order);
    const expectedGoodsNames = readExpectedGoodsNames(order, config.goodsName);

    const primaryList = expected.exact
      ? await client.listOrders({ contact: expected.exact, pageSize: 20 })
      : await client.listOrders({ pageSize: 50 });

    let roughCandidates = filterRoughCandidates(primaryList.list ?? [], order, expectedGoodsNames, config.autoReconcileWindowHours);
    let usedFallbackContact = false;

    if (roughCandidates.length === 0 && expected.baseContact && expected.baseContact !== expected.exact) {
      const fallbackList = await client.listOrders({ contact: expected.baseContact, pageSize: 50 });
      roughCandidates = filterRoughCandidates(fallbackList.list ?? [], order, expectedGoodsNames, config.autoReconcileWindowHours);
      usedFallbackContact = true;
    }

    if (roughCandidates.length === 0) {
      return {
        provider: "ldxp",
        ok: true,
        matched: false,
        paid: false,
        autoCredited: false,
        needsManualReview: false,
        reason: "暂未找到与你当前订单匹配的远端支付记录，请完成付款后再点“自动核单”。",
        remoteOrder: null,
        aggregate: await getMembershipOrderAggregate(order.id),
      };
    }

    const detailPool: LdxpOrderDetail[] = [];
    for (const row of roughCandidates.slice(0, 8)) {
      detailPool.push(await client.getOrderInfo(row.trade_no));
    }

    const { detail, ambiguous } = chooseBestCandidate(detailPool, order, expected.exact);
    if (!detail) {
      return {
        provider: "ldxp",
        ok: true,
        matched: false,
        paid: false,
        autoCredited: false,
        needsManualReview: false,
        reason: "匹配到了候选订单，但暂未拿到可用详情，请稍后再试。",
        remoteOrder: null,
        aggregate: await getMembershipOrderAggregate(order.id),
      };
    }

    if (ambiguous) {
      const aggregate = await markMembershipOrderForManualReview({
        orderId: order.id,
        reviewer: "system:ldxp-reconcile",
        reason: usedFallbackContact
          ? "仅按基础联系方式匹配到多笔近似订单，需人工复核"
          : "匹配到多笔近似订单，需人工复核",
        note: `链动小铺自动核单发现歧义订单：${detail.trade_no}`,
      });
      return {
        provider: "ldxp",
        ok: true,
        matched: true,
        paid: isLdxpPaidOrder(detail),
        autoCredited: false,
        needsManualReview: true,
        reason: usedFallbackContact
          ? "仅按基础联系方式匹配到多笔近似订单，当前结果存在歧义，已自动转入人工复核。"
          : "匹配到多笔近似订单，当前结果存在歧义，已自动转入人工复核。",
        remoteOrder: detail,
        aggregate: aggregate ?? await getMembershipOrderAggregate(order.id),
      };
    }

    if (!isLdxpPaidOrder(detail)) {
      return {
        provider: "ldxp",
        ok: true,
        matched: true,
        paid: false,
        autoCredited: false,
        needsManualReview: false,
        reason: "已匹配到远端订单，但对方平台尚未显示支付成功。",
        remoteOrder: detail,
        aggregate: await getMembershipOrderAggregate(order.id),
      };
    }

    const paidAt = toDateFromUnixSeconds(detail.success_time) ?? new Date();
    const providerTransactionId = String(detail.transaction_id || detail.trade_no);
    const aggregate = await markMembershipOrderPaid({
      orderId: order.id,
      channel: "alipay_qr",
      provider: "ldxp",
      providerTransactionId,
      amountCents: toLdxpAmountCents(detail.total_amount),
      paidAt,
      callbackPayload: detail as unknown as Record<string, unknown>,
      operator: "system:ldxp-reconcile",
      reviewNote: `链动小铺自动核单：${detail.trade_no}`,
    });

    return {
      provider: "ldxp",
      ok: true,
      matched: true,
      paid: true,
      autoCredited: true,
      needsManualReview: false,
      reason: "已确认支付成功，会员已自动到账。",
      remoteOrder: detail,
      aggregate,
    };
  } catch (error) {
    return {
      provider: "ldxp",
      ok: false,
      matched: false,
      paid: false,
      autoCredited: false,
      needsManualReview: false,
      reason: mapLdxpReconcileErrorMessage(error),
      remoteOrder: null,
      aggregate: await getMembershipOrderAggregate(order.id),
    };
  }
}

export interface AutoReconcileSweepResult {
  scanned: number;
  matched: number;
  paid: number;
  autoCredited: number;
  reviewRequired: number;
  skipped: number;
  results: ReconcileMembershipOrderResult[];
}

let autoReconcileSweepInFlight = false;
let autoReconcileLastSweepAt = 0;
const AUTO_RECONCILE_ADVISORY_LOCK_KEY = "wenlu:ldxp:auto-reconcile-sweep";
let autoReconcileLoopTimer: NodeJS.Timeout | null = null;

function readAutoReconcileSweepIntervalMs(): number {
  const parsed = Number.parseInt(process.env.LDXP_AUTO_RECONCILE_SWEEP_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5000 ? parsed : 15000;
}

function isAutoReconcileLoopEnabled(): boolean {
  const raw = String(process.env.LDXP_AUTO_RECONCILE_LOOP_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

async function acquireAutoReconcileAdvisoryLock(): Promise<PoolClient | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [AUTO_RECONCILE_ADVISORY_LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseAutoReconcileAdvisoryLock(client: PoolClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [AUTO_RECONCILE_ADVISORY_LOCK_KEY]);
  } finally {
    client.release();
  }
}

export async function runAutoReconcileSweep(input: {
  limit?: number;
  force?: boolean;
} = {}): Promise<AutoReconcileSweepResult> {
  const now = Date.now();
  const intervalMs = readAutoReconcileSweepIntervalMs();
  if (!input.force && autoReconcileSweepInFlight) {
    return { scanned: 0, matched: 0, paid: 0, autoCredited: 0, reviewRequired: 0, skipped: 1, results: [] };
  }
  if (!input.force && autoReconcileLastSweepAt && now - autoReconcileLastSweepAt < intervalMs) {
    return { scanned: 0, matched: 0, paid: 0, autoCredited: 0, reviewRequired: 0, skipped: 1, results: [] };
  }

  autoReconcileSweepInFlight = true;
  autoReconcileLastSweepAt = now;
  let advisoryLockClient: PoolClient | null = null;
  try {
    advisoryLockClient = await acquireAutoReconcileAdvisoryLock();
    if (!advisoryLockClient) {
      return { scanned: 0, matched: 0, paid: 0, autoCredited: 0, reviewRequired: 0, skipped: 1, results: [] };
    }

    const orders = await listMembershipOrdersNeedingReconcile(Math.max(1, Math.min(input.limit ?? 20, 100)));
    const results: ReconcileMembershipOrderResult[] = [];
    for (const order of orders) {
      try {
        const result = await reconcileMembershipOrderWithLdxp(order);
        results.push(result);
      } catch (error) {
        results.push({
          provider: 'ldxp',
          ok: false,
          matched: false,
          paid: false,
          autoCredited: false,
          needsManualReview: false,
          reason: error instanceof Error ? error.message : 'AUTO_RECONCILE_SWEEP_FAILED',
          remoteOrder: null,
          aggregate: await getMembershipOrderAggregate(order.id),
        });
      }
    }

    return {
      scanned: orders.length,
      matched: results.filter((item) => item.matched).length,
      paid: results.filter((item) => item.paid).length,
      autoCredited: results.filter((item) => item.autoCredited).length,
      reviewRequired: results.filter((item) => item.needsManualReview).length,
      skipped: 0,
      results,
    };
  } finally {
    await releaseAutoReconcileAdvisoryLock(advisoryLockClient);
    autoReconcileSweepInFlight = false;
  }
}

export function startAutoReconcileLoop(): void {
  if (autoReconcileLoopTimer || !isAutoReconcileLoopEnabled()) {
    return;
  }

  const intervalMs = readAutoReconcileSweepIntervalMs();
  autoReconcileLoopTimer = setInterval(() => {
    void runAutoReconcileSweep({ limit: 20 }).catch((error) => {
      console.warn(
        "[payments] auto reconcile loop failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }, intervalMs);

  autoReconcileLoopTimer.unref();
  console.log(`[payments] 自动核单轮询已启动，间隔 ${intervalMs}ms`);
}

export function stopAutoReconcileLoop(): void {
  if (!autoReconcileLoopTimer) return;
  clearInterval(autoReconcileLoopTimer);
  autoReconcileLoopTimer = null;
}
