/**
 * 问路 — 订阅/套餐 CRUD。
 */

import { query } from "./pool.js";

export interface Plan {
  id: string;
  name: string;
  price_cents: number;
  duration_days: number;
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

/** 获取所有套餐。 */
export async function listPlans(): Promise<Plan[]> {
  const result = await query<Plan>("SELECT * FROM plans ORDER BY price_cents ASC");
  return result.rows;
}

/** 获取用户当前有效订阅。 */
export async function getActiveSubscription(userId: string): Promise<Subscription | null> {
  const result = await query<Subscription>(
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
): Promise<Subscription> {
  const expiresAt = durationDays > 0
    ? `NOW() + INTERVAL '${durationDays} days'`
    : "NULL";

  // 先把旧订阅标记为失效
  await query(
    `UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );

  const result = await query<Subscription>(
    `INSERT INTO subscriptions (user_id, plan_id, expires_at)
     VALUES ($1, $2, ${expiresAt}) RETURNING *`,
    [userId, planId],
  );
  return result.rows[0];
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

  // 查套餐信息
  const planResult = await query<Plan>(
    "SELECT * FROM plans WHERE id = $1",
    [payment.plan_id],
  );
  const plan = planResult.rows[0];
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
  return sub.plan_id !== "free";
}

/** 获取用户的支付历史。 */
export async function getPaymentHistory(userId: string, limit = 20): Promise<Payment[]> {
  const result = await query<Payment>(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}
