import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { query, transaction } from "./pool.js";
import type { Plan, Subscription } from "./subscriptionRepo.js";

export type MembershipOrderStatus =
  | "pending"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "review_required"
  | "expired";

export type PaymentRecordStatus =
  | "pending"
  | "success"
  | "failed"
  | "review_required"
  | "refunded";

export type ReviewStatus = "not_required" | "pending_review" | "approved" | "rejected";

export interface MembershipOrder {
  id: string;
  order_no: string;
  user_id: string;
  plan_id: string;
  order_type: string;
  amount_cents: number;
  currency: string;
  status: MembershipOrderStatus;
  payment_channel: string | null;
  idempotency_key: string | null;
  client_reference: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  review_status: ReviewStatus;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  expires_at: Date | null;
  paid_at: Date | null;
  fulfilled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderPaymentRecord {
  id: string;
  order_id: string;
  user_id: string;
  channel: string;
  provider: string;
  provider_transaction_id: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentRecordStatus;
  callback_payload: Record<string, unknown>;
  paid_at: Date | null;
  confirmed_at: Date | null;
  review_status: ReviewStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MembershipGrant {
  id: string;
  order_id: string;
  payment_id: string | null;
  user_id: string;
  plan_id: string;
  subscription_id: string;
  source: string;
  grant_status: string;
  starts_at: Date;
  expires_at: Date | null;
  granted_by: string | null;
  note: string | null;
  created_at: Date;
}

export interface CreateMembershipOrderInput {
  userId: string;
  planId: string;
  amountCents?: number;
  paymentChannel?: string;
  currency?: string;
  idempotencyKey?: string;
  clientReference?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export interface PaymentSuccessInput {
  orderId?: string;
  orderNo?: string;
  channel: string;
  provider?: string;
  providerTransactionId?: string;
  amountCents: number;
  currency?: string;
  paidAt?: Date;
  callbackPayload?: Record<string, unknown>;
  operator?: string;
  skipAmountCheck?: boolean;
  reviewNote?: string;
}

export interface ManualReviewInput {
  orderId?: string;
  orderNo?: string;
  reviewer: string;
  reason: string;
  paymentId?: string;
  note?: string;
}

export interface OrderAggregate {
  order: MembershipOrder;
  latestPayment: OrderPaymentRecord | null;
  grant: MembershipGrant | null;
  subscription: Subscription | null;
}

interface OrderPlanSnapshot {
  planId: string;
  planName: string | null;
  priceCents: number;
  durationDays: number;
}

function buildOrderNo(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `wl_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function buildOrderPlanSnapshot(plan: Plan): OrderPlanSnapshot {
  return {
    planId: plan.id,
    planName: plan.name ?? null,
    priceCents: plan.price_cents,
    durationDays: Math.max(0, Math.trunc(plan.duration_days ?? 0)),
  };
}

function readOrderPlanDurationDays(order: MembershipOrder, fallbackPlan: Plan): number {
  const metadata = order.metadata && typeof order.metadata === "object" ? order.metadata : {};
  const rawSnapshot = metadata.planSnapshot;
  if (rawSnapshot && typeof rawSnapshot === "object" && !Array.isArray(rawSnapshot)) {
    const durationDays = Number((rawSnapshot as Record<string, unknown>).durationDays);
    if (Number.isFinite(durationDays)) {
      return Math.max(0, Math.trunc(durationDays));
    }
  }
  return Math.max(0, Math.trunc(fallbackPlan.duration_days ?? 0));
}

async function q<T extends QueryResultRow>(client: PoolClient, text: string, params?: unknown[]) {
  return client.query<T>(text, params);
}

async function getPlanForUpdate(client: PoolClient, planId: string): Promise<Plan | null> {
  const result = await q<Plan>(client, "SELECT * FROM plans WHERE id = $1", [planId]);
  return result.rows[0] ?? null;
}

async function getOrderLocked(client: PoolClient, input: { orderId?: string; orderNo?: string }): Promise<MembershipOrder | null> {
  if (input.orderId) {
    const result = await q<MembershipOrder>(client, "SELECT * FROM membership_orders WHERE id = $1 FOR UPDATE", [input.orderId]);
    return result.rows[0] ?? null;
  }
  if (input.orderNo) {
    const result = await q<MembershipOrder>(client, "SELECT * FROM membership_orders WHERE order_no = $1 FOR UPDATE", [input.orderNo]);
    return result.rows[0] ?? null;
  }
  throw new Error("orderId or orderNo is required");
}

async function getExistingGrantAggregate(client: PoolClient, orderId: string): Promise<OrderAggregate | null> {
  const result = await q<{
    order_json: MembershipOrder;
    payment_json: OrderPaymentRecord | null;
    grant_json: MembershipGrant | null;
    subscription_json: Subscription | null;
  }>(
    client,
    `SELECT
       to_jsonb(o.*) AS order_json,
       to_jsonb(p.*) AS payment_json,
       to_jsonb(g.*) AS grant_json,
       to_jsonb(s.*) AS subscription_json
     FROM membership_orders o
     LEFT JOIN LATERAL (
       SELECT * FROM order_payments op
       WHERE op.order_id = o.id
       ORDER BY op.created_at DESC
       LIMIT 1
     ) p ON TRUE
     LEFT JOIN membership_grants g ON g.order_id = o.id
     LEFT JOIN subscriptions s ON s.id = g.subscription_id
     WHERE o.id = $1`,
    [orderId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    order: row.order_json,
    latestPayment: row.payment_json,
    grant: row.grant_json,
    subscription: row.subscription_json,
  };
}

async function insertSubscriptionGrant(
  client: PoolClient,
  order: MembershipOrder,
  payment: OrderPaymentRecord,
  plan: Plan,
  source: string,
  grantedBy: string | undefined,
  note: string | undefined,
): Promise<{ grant: MembershipGrant; subscription: Subscription }> {
  const activeSubscriptionResult = await q<Subscription>(
    client,
    `SELECT *
       FROM subscriptions
      WHERE user_id = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [order.user_id],
  );
  const activeSubscription = activeSubscriptionResult.rows[0] ?? null;

  await q(
    client,
    `UPDATE subscriptions
     SET is_active = FALSE
     WHERE user_id = $1 AND is_active = TRUE`,
    [order.user_id],
  );

  const startsAt = new Date();
  let expiresAt: Date | null = null;
  const durationDays = readOrderPlanDurationDays(order, plan);
  if (durationDays > 0) {
    const anchor =
      activeSubscription?.expires_at && activeSubscription.expires_at.getTime() > Date.now()
        ? activeSubscription.expires_at
        : startsAt;
    expiresAt = new Date(anchor.getTime() + durationDays * 24 * 60 * 60 * 1000);
  } else if (activeSubscription?.expires_at === null) {
    expiresAt = null;
  }

  const subscriptionResult = await q<Subscription>(
    client,
    `INSERT INTO subscriptions (user_id, plan_id, starts_at, expires_at, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     RETURNING *`,
    [order.user_id, order.plan_id, startsAt, expiresAt],
  );
  const subscription = subscriptionResult.rows[0];

  const grantResult = await q<MembershipGrant>(
    client,
    `INSERT INTO membership_grants (
       order_id, payment_id, user_id, plan_id, subscription_id, source,
       grant_status, starts_at, expires_at, granted_by, note
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10)
     RETURNING *`,
    [
      order.id,
      payment.id,
      order.user_id,
      order.plan_id,
      subscription.id,
      source,
      subscription.starts_at,
      subscription.expires_at,
      grantedBy ?? null,
      note ?? null,
    ],
  );

  const grant = grantResult.rows[0];

  await q(
    client,
    `UPDATE membership_orders
     SET status = 'fulfilled', review_status = CASE WHEN review_status = 'approved' THEN review_status ELSE 'not_required' END,
         fulfilled_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [order.id],
  );

  return { grant, subscription };
}

/** 创建充值/会员订单；如提供幂等键则重复调用返回已有订单。 */
export async function createMembershipOrder(input: CreateMembershipOrderInput): Promise<MembershipOrder> {
  return transaction(async (client) => {
    if (input.idempotencyKey) {
      const existing = await q<MembershipOrder>(
        client,
        "SELECT * FROM membership_orders WHERE idempotency_key = $1 LIMIT 1",
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    const plan = await getPlanForUpdate(client, input.planId);
    if (!plan) {
      throw new Error(`plan not found: ${input.planId}`);
    }
    if (!plan.is_active) {
      throw new Error(`PLAN_INACTIVE:${input.planId}`);
    }

    const amountCents = input.amountCents ?? plan.price_cents;
    const metadata = {
      ...(input.metadata ?? {}),
      planSnapshot: buildOrderPlanSnapshot(plan),
    };
    const result = await q<MembershipOrder>(
      client,
      `INSERT INTO membership_orders (
         order_no, user_id, plan_id, order_type, amount_cents, currency,
         status, payment_channel, idempotency_key, client_reference,
         title, metadata, expires_at
       )
       VALUES ($1, $2, $3, 'recharge', $4, $5, 'pending', $6, $7, $8, $9, $10::jsonb, $11)
       RETURNING *`,
      [
        buildOrderNo(),
        input.userId,
        input.planId,
        amountCents,
        input.currency ?? "CNY",
        input.paymentChannel ?? null,
        input.idempotencyKey ?? null,
        input.clientReference ?? null,
        input.title ?? plan.name,
        JSON.stringify(metadata),
        input.expiresAt ?? null,
      ],
    );

    return result.rows[0];
  });
}

export async function getMembershipOrderById(orderId: string): Promise<MembershipOrder | null> {
  const result = await query<MembershipOrder>("SELECT * FROM membership_orders WHERE id = $1", [orderId]);
  return result.rows[0] ?? null;
}

export async function getMembershipOrderByOrderNo(orderNo: string): Promise<MembershipOrder | null> {
  const result = await query<MembershipOrder>("SELECT * FROM membership_orders WHERE order_no = $1", [orderNo]);
  return result.rows[0] ?? null;
}

export async function getMembershipOrderAggregate(orderId: string): Promise<OrderAggregate | null> {
  return transaction(async (client) => getExistingGrantAggregate(client, orderId));
}

export async function updateMembershipOrderMetadata(
  orderId: string,
  metadataPatch: Record<string, unknown>,
): Promise<MembershipOrder | null> {
  const result = await query<MembershipOrder>(
    `UPDATE membership_orders
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId, JSON.stringify(metadataPatch ?? {})],
  );
  return result.rows[0] ?? null;
}

export async function listUserMembershipOrders(userId: string, limit = 20): Promise<MembershipOrder[]> {
  const result = await query<MembershipOrder>(
    `SELECT * FROM membership_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

export async function listMembershipOrdersNeedingReconcile(limit = 20): Promise<MembershipOrder[]> {
  const result = await query<MembershipOrder>(
    `SELECT *
       FROM membership_orders
      WHERE status IN ('pending', 'review_required', 'paid')
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/** 支付成功回调/人工入账统一入口；自动幂等处理并在通过校验后发放会员。 */
export async function markMembershipOrderPaid(input: PaymentSuccessInput): Promise<OrderAggregate | null> {
  return transaction(async (client) => {
    const order = await getOrderLocked(client, input);
    if (!order) return null;

    const aggregateBefore = await getExistingGrantAggregate(client, order.id);
    if (aggregateBefore?.grant && aggregateBefore.subscription) {
      return aggregateBefore;
    }

    const plan = await getPlanForUpdate(client, order.plan_id);
    if (!plan) {
      throw new Error(`plan not found: ${order.plan_id}`);
    }

    const paidAt = input.paidAt ?? new Date();
    const amountMatches = input.amountCents === order.amount_cents;
    const requiresReview = !input.skipAmountCheck && !amountMatches;
    const paymentStatus: PaymentRecordStatus = requiresReview ? "review_required" : "success";
    const reviewStatus: ReviewStatus = requiresReview ? "pending_review" : "not_required";

    let payment: OrderPaymentRecord;
    if (input.providerTransactionId) {
      const upserted = await q<OrderPaymentRecord>(
        client,
        `INSERT INTO order_payments (
           order_id, user_id, channel, provider, provider_transaction_id,
           amount_cents, currency, status, callback_payload, paid_at,
           confirmed_at, review_status, review_note, reviewed_by, reviewed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW(), $11, $12, $13, $14)
         ON CONFLICT (provider, provider_transaction_id)
         DO UPDATE SET
           order_id = EXCLUDED.order_id,
           user_id = EXCLUDED.user_id,
           channel = EXCLUDED.channel,
           amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency,
           status = EXCLUDED.status,
           callback_payload = EXCLUDED.callback_payload,
           paid_at = EXCLUDED.paid_at,
           confirmed_at = NOW(),
           review_status = EXCLUDED.review_status,
           review_note = EXCLUDED.review_note,
           reviewed_by = EXCLUDED.reviewed_by,
           reviewed_at = EXCLUDED.reviewed_at,
           updated_at = NOW()
         RETURNING *`,
        [
          order.id,
          order.user_id,
          input.channel,
          input.provider ?? input.channel,
          input.providerTransactionId,
          input.amountCents,
          input.currency ?? order.currency,
          paymentStatus,
          JSON.stringify(input.callbackPayload ?? {}),
          paidAt,
          reviewStatus,
          requiresReview ? (input.reviewNote ?? `paid amount mismatch: expected ${order.amount_cents}, got ${input.amountCents}`) : null,
          requiresReview ? (input.operator ?? null) : null,
          requiresReview ? paidAt : null,
        ],
      );
      payment = upserted.rows[0];
    } else {
      const inserted = await q<OrderPaymentRecord>(
        client,
        `INSERT INTO order_payments (
           order_id, user_id, channel, provider, provider_transaction_id,
           amount_cents, currency, status, callback_payload, paid_at,
           confirmed_at, review_status, review_note, reviewed_by, reviewed_at
         )
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8::jsonb, $9, NOW(), $10, $11, $12, $13)
         RETURNING *`,
        [
          order.id,
          order.user_id,
          input.channel,
          input.provider ?? input.channel,
          input.amountCents,
          input.currency ?? order.currency,
          paymentStatus,
          JSON.stringify(input.callbackPayload ?? {}),
          paidAt,
          reviewStatus,
          requiresReview ? (input.reviewNote ?? `paid amount mismatch: expected ${order.amount_cents}, got ${input.amountCents}`) : null,
          requiresReview ? (input.operator ?? null) : null,
          requiresReview ? paidAt : null,
        ],
      );
      payment = inserted.rows[0];
    }

    if (requiresReview) {
      const orderResult = await q<MembershipOrder>(
        client,
        `UPDATE membership_orders
         SET status = 'review_required', review_status = 'pending_review',
             review_reason = $2, paid_at = COALESCE(paid_at, $3), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [order.id, payment.review_note, paidAt],
      );
      return {
        order: orderResult.rows[0],
        latestPayment: payment,
        grant: null,
        subscription: null,
      };
    }

    const paidOrderResult = await q<MembershipOrder>(
      client,
      `UPDATE membership_orders
       SET status = 'paid', payment_channel = $2, paid_at = COALESCE(paid_at, $3), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [order.id, input.channel, paidAt],
    );
    const paidOrder = paidOrderResult.rows[0];

    const granted = await insertSubscriptionGrant(
      client,
      paidOrder,
      payment,
      plan,
      input.skipAmountCheck ? "manual_review" : "payment",
      input.operator,
      input.reviewNote,
    );

    const finalAggregate = await getExistingGrantAggregate(client, paidOrder.id);
    if (finalAggregate) return finalAggregate;

    return {
      order: paidOrder,
      latestPayment: payment,
      grant: granted.grant,
      subscription: granted.subscription,
    };
  });
}

/** 人工复核：把订单/支付挂到待审核状态，供后台二次确认。 */
export async function markMembershipOrderForManualReview(input: ManualReviewInput): Promise<OrderAggregate | null> {
  return transaction(async (client) => {
    const order = await getOrderLocked(client, input);
    if (!order) return null;

    const orderResult = await q<MembershipOrder>(
      client,
      `UPDATE membership_orders
       SET status = 'review_required', review_status = 'pending_review', review_reason = $2,
           reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [order.id, input.reason, input.reviewer],
    );
    const updatedOrder = orderResult.rows[0];

    let payment: OrderPaymentRecord | null = null;
    if (input.paymentId) {
      const paymentResult = await q<OrderPaymentRecord>(
        client,
        `UPDATE order_payments
         SET status = 'review_required', review_status = 'pending_review',
             review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [input.paymentId, input.note ?? input.reason, input.reviewer],
      );
      payment = paymentResult.rows[0] ?? null;
    } else {
      const latest = await q<OrderPaymentRecord>(
        client,
        `SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [order.id],
      );
      payment = latest.rows[0] ?? null;
    }

    return {
      order: updatedOrder,
      latestPayment: payment,
      grant: null,
      subscription: null,
    };
  });
}

/** 人工复核通过后补发会员；同一订单只会发放一次。 */
export async function approveMembershipOrderReview(
  orderId: string,
  reviewer: string,
  note?: string,
): Promise<OrderAggregate | null> {
  return transaction(async (client) => {
    const order = await getOrderLocked(client, { orderId });
    if (!order) return null;

    const aggregateBefore = await getExistingGrantAggregate(client, order.id);
    if (aggregateBefore?.grant && aggregateBefore.subscription) {
      return aggregateBefore;
    }

    const plan = await getPlanForUpdate(client, order.plan_id);
    if (!plan) {
      throw new Error(`plan not found: ${order.plan_id}`);
    }

    const paymentResult = await q<OrderPaymentRecord>(
      client,
      `SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [order.id],
    );
    const latestPayment = paymentResult.rows[0];
    if (!latestPayment) {
      throw new Error(`payment record not found for order ${order.id}`);
    }

    const approvedPaymentResult = await q<OrderPaymentRecord>(
      client,
      `UPDATE order_payments
       SET status = 'success', review_status = 'approved', review_note = $2,
           reviewed_by = $3, reviewed_at = NOW(), confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [latestPayment.id, note ?? latestPayment.review_note, reviewer],
    );
    const approvedPayment = approvedPaymentResult.rows[0];

    const approvedOrderResult = await q<MembershipOrder>(
      client,
      `UPDATE membership_orders
       SET status = 'paid', review_status = 'approved', review_reason = COALESCE(review_reason, $2),
           reviewed_by = $3, reviewed_at = NOW(), paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [order.id, note ?? order.review_reason, reviewer],
    );
    const approvedOrder = approvedOrderResult.rows[0];

    const granted = await insertSubscriptionGrant(
      client,
      approvedOrder,
      approvedPayment,
      plan,
      "manual_review",
      reviewer,
      note,
    );

    const finalAggregate = await getExistingGrantAggregate(client, approvedOrder.id);
    if (finalAggregate) return finalAggregate;

    return {
      order: approvedOrder,
      latestPayment: approvedPayment,
      grant: granted.grant,
      subscription: granted.subscription,
    };
  });
}
