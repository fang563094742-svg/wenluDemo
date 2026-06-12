/**
 * 问路 — 订阅/套餐 CRUD。
 */

import type pg from "pg";
import { query, type QueryResult } from "./pool.js";

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  badge_text: string | null;
  price_cents: number;
  duration_days: number;
  sort_order: number;
  is_active: boolean;
  features: Record<string, unknown>;
  created_at: Date;
}

export interface Subscription {
  id: string;
  user_id: string;
  plan_id: string;
  starts_at: Date;
  expires_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

export interface Payment {
  id: string;
  user_id: string;
  plan_id: string;
  amount_cents: number;
  channel: string;
  transaction_id: string | null;
  status: string;
  paid_at: Date | null;
  created_at: Date;
}

type QueryExecutor = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

type Queryable = {
  query: QueryExecutor;
};

function db(executor?: Queryable): Queryable {
  return executor ?? { query };
}

const DEFAULT_PAID_PLAN_ID = (process.env.INVITE_REWARD_DEFAULT_PLAN_ID ?? "member").trim() || "member";
const FREE_PLAN_ID = "free";
const PLAN_PAYMENT_GOODS_KEY_FIELDS = [
  "payment_goods_key",
  "paymentGoodsKey",
  "ldxp_goods_key",
  "ldxpGoodsKey",
  "remoteGoodsKey",
] as const;

function toPlanFeaturesObject(features: unknown): Record<string, unknown> {
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return {};
  }
  return { ...(features as Record<string, unknown>) };
}

export function getPlanPaymentGoodsKey(
  planOrFeatures: Pick<Plan, "features"> | Record<string, unknown> | null | undefined,
): string | null {
  const features = toPlanFeaturesObject(
    planOrFeatures && "features" in planOrFeatures
      ? planOrFeatures.features
      : planOrFeatures,
  );

  for (const field of PLAN_PAYMENT_GOODS_KEY_FIELDS) {
    const value = features[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function withPlanPaymentGoodsKey(
  features: Record<string, unknown> | null | undefined,
  goodsKey: string | null | undefined,
): Record<string, unknown> {
  const next = toPlanFeaturesObject(features);
  for (const field of PLAN_PAYMENT_GOODS_KEY_FIELDS) {
    delete next[field];
  }

  const normalized = typeof goodsKey === "string" ? goodsKey.trim() : "";
  if (normalized) {
    next.payment_goods_key = normalized;
  }
  return next;
}

/** 获取所有套餐。 */
export async function listPlans(executor?: Queryable): Promise<Plan[]> {
  const result = await db(executor).query<Plan>(
    `SELECT *
       FROM plans
      ORDER BY is_active DESC, sort_order ASC, price_cents ASC, created_at ASC`,
  );
  return result.rows;
}

/** 获取单个套餐。 */
export async function getPlanById(planId: string, executor?: Queryable): Promise<Plan | null> {
  const result = await db(executor).query<Plan>("SELECT * FROM plans WHERE id = $1", [planId]);
  return result.rows[0] ?? null;
}

export interface UpdatePlanInput {
  name?: string;
  description?: string | null;
  badge_text?: string | null;
  price_cents?: number;
  duration_days?: number;
  sort_order?: number;
  is_active?: boolean;
  features?: Record<string, unknown>;
}

/** 更新套餐配置。 */
export async function updatePlan(
  planId: string,
  fields: UpdatePlanInput,
): Promise<Plan | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let index = 1;

  if (fields.name !== undefined) {
    sets.push(`name = $${index++}`);
    params.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push(`description = $${index++}`);
    params.push(fields.description);
  }
  if (fields.badge_text !== undefined) {
    sets.push(`badge_text = $${index++}`);
    params.push(fields.badge_text);
  }
  if (fields.price_cents !== undefined) {
    sets.push(`price_cents = $${index++}`);
    params.push(fields.price_cents);
  }
  if (fields.duration_days !== undefined) {
    sets.push(`duration_days = $${index++}`);
    params.push(fields.duration_days);
  }
  if (fields.sort_order !== undefined) {
    sets.push(`sort_order = $${index++}`);
    params.push(fields.sort_order);
  }
  if (fields.is_active !== undefined) {
    sets.push(`is_active = $${index++}`);
    params.push(fields.is_active);
  }
  if (fields.features !== undefined) {
    sets.push(`features = $${index++}`);
    params.push(JSON.stringify(fields.features));
  }

  if (sets.length === 0) {
    return getPlanById(planId);
  }

  params.push(planId);
  const result = await query<Plan>(
    `UPDATE plans
        SET ${sets.join(", ")}
      WHERE id = $${index}
    RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/** 获取用户当前有效订阅。 */
export async function getActiveSubscription(
  userId: string,
  executor?: Queryable,
): Promise<Subscription | null> {
  const result = await db(executor).query<Subscription>(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** 创建订阅。 */
export async function createSubscription(
  userId: string,
  planId: string,
  durationDays: number,
  executor?: Queryable,
): Promise<Subscription> {
  await db(executor).query(
    `UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );

  const result = await db(executor).query<Subscription>(
    `INSERT INTO subscriptions (user_id, plan_id, starts_at, expires_at, is_active)
     VALUES (
       $1,
       $2,
       NOW(),
       CASE WHEN $3 > 0 THEN NOW() + ($3 * INTERVAL '1 day') ELSE NULL END,
       TRUE
     )
     RETURNING *`,
    [userId, planId, durationDays],
  );
  return result.rows[0]!;
}

/** 管理员延长会员：优先顺延当前有效会员；若当前是长期会员，也按当前时间起算延长；否则创建同计划新会员。 */
export async function extendSubscription(
  userId: string,
  durationDays: number,
  preferredPlanId?: string | null,
  executor?: Queryable,
): Promise<Subscription> {
  const normalizedDurationDays = Math.max(1, Math.trunc(durationDays));
  const lockedActiveResult = await db(executor).query<Subscription>(
    `SELECT *
       FROM subscriptions
      WHERE user_id = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [userId],
  );
  const activeSubscription = lockedActiveResult.rows[0] ?? null;

  if (activeSubscription && activeSubscription.plan_id !== FREE_PLAN_ID) {
    const result = await db(executor).query<Subscription>(
      `UPDATE subscriptions
          SET expires_at = COALESCE(expires_at, NOW()) + ($2 * INTERVAL '1 day')
        WHERE id = $1
      RETURNING *`,
      [activeSubscription.id, normalizedDurationDays],
    );
    return result.rows[0] ?? activeSubscription;
  }

  const planId = preferredPlanId?.trim() || DEFAULT_PAID_PLAN_ID;
  const plan = await getPlanById(planId, executor);
  if (!plan) {
    throw new Error(`plan not found: ${planId}`);
  }
  if (!plan.is_active) {
    throw new Error(`PLAN_INACTIVE:${planId}`);
  }

  return createSubscription(userId, plan.id, normalizedDurationDays, executor);
}

export interface ApplyInviteRewardSubscriptionInput {
  durationDays: number;
  preferredPlanId?: string | null;
}

/**
 * 邀请奖励专用：
 * - 若用户已有有效付费订阅，则在原有效期基础上顺延；
 * - 否则创建新的付费订阅；
 * - 不会把已有会员降级为 reward plan。
 */
export async function applyInviteRewardSubscription(
  userId: string,
  input: ApplyInviteRewardSubscriptionInput,
  executor?: Queryable,
): Promise<Subscription> {
  const durationDays = Math.max(1, Math.trunc(input.durationDays));
  const lockedActiveResult = await db(executor).query<Subscription>(
    `SELECT *
       FROM subscriptions
      WHERE user_id = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [userId],
  );
  const activeSubscription = lockedActiveResult.rows[0] ?? null;

  if (activeSubscription && activeSubscription.plan_id !== FREE_PLAN_ID) {
    if (activeSubscription.expires_at === null) {
      return activeSubscription;
    }

    const result = await db(executor).query<Subscription>(
      `UPDATE subscriptions
          SET expires_at = GREATEST(expires_at, NOW()) + ($2 * INTERVAL '1 day')
        WHERE id = $1
      RETURNING *`,
      [activeSubscription.id, durationDays],
    );
    return result.rows[0] ?? activeSubscription;
  }

  const planId = input.preferredPlanId?.trim() || DEFAULT_PAID_PLAN_ID;
  return createSubscription(userId, planId, durationDays, executor);
}

/** 创建支付记录（pending 状态）。 */
export async function createPayment(
  userId: string,
  planId: string,
  amountCents: number,
  channel: string = "wechat",
): Promise<Payment> {
  const result = await query<Payment>(
    `INSERT INTO payments (user_id, plan_id, amount_cents, channel)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, planId, amountCents, channel],
  );
  return result.rows[0];
}

/** 支付成功回调：标记付款完成 + 创建订阅。 */
export async function completePayment(
  paymentId: string,
  transactionId: string,
): Promise<{ payment: Payment; subscription: Subscription } | null> {
  const payResult = await query<Payment>(
    `UPDATE payments SET status = 'success', transaction_id = $2, paid_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [paymentId, transactionId],
  );
  const payment = payResult.rows[0];
  if (!payment) return null;

  const plan = await getPlanById(payment.plan_id);
  if (!plan) return null;

  const subscription = await createSubscription(
    payment.user_id,
    payment.plan_id,
    plan.duration_days,
  );

  return { payment, subscription };
}

/** 检查用户是否是付费用户（非 free）。 */
export async function isPaidUser(userId: string): Promise<boolean> {
  const sub = await getActiveSubscription(userId);
  if (!sub) return false;
  return sub.plan_id !== FREE_PLAN_ID;
}

/** 获取用户的支付历史。 */
export async function getPaymentHistory(userId: string, limit = 20): Promise<Payment[]> {
  const result = await query<Payment>(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}
