import type { PoolClient } from "pg";
import { transaction } from "../db/pool.js";

const DEFAULT_FREE_PLAN_ID = "free";
const BUSINESS_MESSAGE_RESOURCE_KEY = "business_message";
const LIMIT_TIMEZONE = process.env.MEMBERSHIP_LIMIT_TIMEZONE?.trim() || "Asia/Shanghai";
const DEFAULT_FREE_DAILY_MESSAGE_LIMIT = parsePositiveInt(process.env.FREE_DAILY_MESSAGE_LIMIT, 10);
const DEFAULT_FREE_TRIAL_DAYS = parsePositiveInt(process.env.FREE_TRIAL_DAYS, 3);
const DAY_MS = 24 * 60 * 60 * 1000;

interface MembershipUserRow {
  id: string;
  created_at: Date;
  extra_business_message_credits: number;
}

interface MembershipPlanRow {
  id: string;
  name: string;
  features: Record<string, unknown>;
}

interface MembershipSubscriptionRow {
  plan_id: string;
  expires_at: Date | null;
}

interface MembershipUsageRow {
  used_count: number;
}

interface MembershipContext {
  user: MembershipUserRow;
  plan: MembershipPlanRow;
  subscription: MembershipSubscriptionRow | null;
  usedToday: number;
}

export type MembershipAccessReasonCode =
  | "OK"
  | "FREE_TRIAL_EXPIRED"
  | "FREE_DAILY_LIMIT_REACHED"
  | "EXTRA_BUSINESS_CREDITS_USED";

export interface MembershipAccessSnapshot {
  planId: string;
  planName: string;
  isMember: boolean;
  hasActiveSubscription: boolean;
  subscriptionExpiresAt: string | null;
  dailyLimit: number | null;
  dailyUsed: number | null;
  dailyRemaining: number | null;
  trialDays: number | null;
  trialEndsAt: string | null;
  trialExpired: boolean;
  allowed: boolean;
  reasonCode: MembershipAccessReasonCode;
  reason: string | null;
  /** 额外业务指令次数余额（如邀请赠送）；每日免费额度用完后才动用，试用到期即失效。 */
  extraBusinessMessageCredits?: number;
}

export interface EvaluateMembershipAccessInput {
  planId: string;
  planName: string;
  hasActiveSubscription: boolean;
  subscriptionExpiresAt: Date | null;
  userCreatedAt: Date;
  usedToday: number;
  maxMessagesPerDay: number | null;
  freeTrialDays: number | null;
  now?: Date;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function formatCnDateTime(value: Date): string {
  return value.toLocaleString("zh-CN", {
    hour12: false,
    timeZone: LIMIT_TIMEZONE,
  });
}

function normalizeNumericFeature(raw: unknown, fallback: number | null): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function resolvePlanFeatureNumber(
  features: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number | null,
): number | null {
  if (!features || typeof features !== "object") {
    return fallback;
  }
  return normalizeNumericFeature(features[key], fallback);
}

export function buildUsageDateStamp(now: Date, timeZone: string = LIMIT_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function calculateFreeTrialEndsAt(createdAt: Date, freeTrialDays: number | null): Date | null {
  if (freeTrialDays === null || freeTrialDays <= 0) {
    return null;
  }
  return new Date(createdAt.getTime() + freeTrialDays * DAY_MS);
}

export function evaluateMembershipAccess(input: EvaluateMembershipAccessInput): MembershipAccessSnapshot {
  const now = input.now ?? new Date();
  const isMember = input.hasActiveSubscription && input.planId !== DEFAULT_FREE_PLAN_ID;
  const freeTrialEndsAt = isMember ? null : calculateFreeTrialEndsAt(input.userCreatedAt, input.freeTrialDays);
  const trialExpired = freeTrialEndsAt !== null && freeTrialEndsAt.getTime() <= now.getTime();
  const dailyLimit =
    isMember || input.maxMessagesPerDay === null || input.maxMessagesPerDay < 0
      ? null
      : input.maxMessagesPerDay;
  const dailyUsed = isMember ? null : input.usedToday;
  const dailyRemaining =
    dailyLimit === null || dailyUsed === null
      ? null
      : Math.max(dailyLimit - dailyUsed, 0);

  if (isMember) {
    return {
      planId: input.planId,
      planName: input.planName,
      isMember: true,
      hasActiveSubscription: true,
      subscriptionExpiresAt: toIsoString(input.subscriptionExpiresAt),
      dailyLimit: null,
      dailyUsed: null,
      dailyRemaining: null,
      trialDays: null,
      trialEndsAt: null,
      trialExpired: false,
      allowed: true,
      reasonCode: "OK",
      reason: null,
    };
  }

  if (trialExpired && freeTrialEndsAt) {
    return {
      planId: input.planId,
      planName: input.planName,
      isMember: false,
      hasActiveSubscription: input.hasActiveSubscription,
      subscriptionExpiresAt: toIsoString(input.subscriptionExpiresAt),
      dailyLimit,
      dailyUsed,
      dailyRemaining,
      trialDays: input.freeTrialDays,
      trialEndsAt: toIsoString(freeTrialEndsAt),
      trialExpired: true,
      allowed: false,
      reasonCode: "FREE_TRIAL_EXPIRED",
      reason: `免费体验已于 ${formatCnDateTime(freeTrialEndsAt)} 到期，开通会员后可继续发送业务指令。`,
    };
  }

  if (dailyLimit !== null && input.usedToday >= dailyLimit) {
    return {
      planId: input.planId,
      planName: input.planName,
      isMember: false,
      hasActiveSubscription: input.hasActiveSubscription,
      subscriptionExpiresAt: toIsoString(input.subscriptionExpiresAt),
      dailyLimit,
      dailyUsed,
      dailyRemaining,
      trialDays: input.freeTrialDays,
      trialEndsAt: toIsoString(freeTrialEndsAt),
      trialExpired: false,
      allowed: false,
      reasonCode: "FREE_DAILY_LIMIT_REACHED",
      reason: `免费用户每天最多发送 ${dailyLimit} 次业务指令，今日额度已用完，请明天再试或开通会员。`,
    };
  }

  return {
    planId: input.planId,
    planName: input.planName,
    isMember: false,
    hasActiveSubscription: input.hasActiveSubscription,
    subscriptionExpiresAt: toIsoString(input.subscriptionExpiresAt),
    dailyLimit,
    dailyUsed,
    dailyRemaining,
    trialDays: input.freeTrialDays,
    trialEndsAt: toIsoString(freeTrialEndsAt),
    trialExpired: false,
    allowed: true,
    reasonCode: "OK",
    reason: null,
  };
}

async function findUserByIdForMembership(client: PoolClient, userId: string): Promise<MembershipUserRow | null> {
  const result = await client.query<MembershipUserRow>(
    "SELECT id, created_at, extra_business_message_credits FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return result.rows[0] ?? null;
}

async function findActiveSubscriptionForMembership(
  client: PoolClient,
  userId: string,
): Promise<MembershipSubscriptionRow | null> {
  const result = await client.query<MembershipSubscriptionRow>(
    `SELECT plan_id, expires_at
       FROM subscriptions
      WHERE user_id = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function findPlanForMembership(client: PoolClient, planId: string): Promise<MembershipPlanRow | null> {
  const result = await client.query<MembershipPlanRow>(
    "SELECT id, name, features FROM plans WHERE id = $1 LIMIT 1",
    [planId],
  );
  return result.rows[0] ?? null;
}

async function getDailyUsageCount(
  client: PoolClient,
  userId: string,
  usageDate: string,
  resourceKey: string,
): Promise<number> {
  const result = await client.query<MembershipUsageRow>(
    `SELECT used_count
       FROM membership_usage_counters
      WHERE user_id = $1 AND usage_date = $2 AND resource_key = $3
      LIMIT 1`,
    [userId, usageDate, resourceKey],
  );
  return result.rows[0]?.used_count ?? 0;
}

async function incrementDailyUsageCount(
  client: PoolClient,
  userId: string,
  usageDate: string,
  resourceKey: string,
): Promise<number> {
  const result = await client.query<MembershipUsageRow>(
    `INSERT INTO membership_usage_counters (user_id, usage_date, resource_key, used_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, resource_key, usage_date)
     DO UPDATE SET
       used_count = membership_usage_counters.used_count + 1,
       updated_at = NOW()
     RETURNING used_count`,
    [userId, usageDate, resourceKey],
  );
  return result.rows[0]?.used_count ?? 0;
}

async function loadMembershipContext(
  client: PoolClient,
  userId: string,
  usageDate: string,
): Promise<MembershipContext> {
  const user = await findUserByIdForMembership(client, userId);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const subscription = await findActiveSubscriptionForMembership(client, userId);
  const planId = subscription?.plan_id ?? DEFAULT_FREE_PLAN_ID;
  const plan =
    (await findPlanForMembership(client, planId)) ??
    (await findPlanForMembership(client, DEFAULT_FREE_PLAN_ID));

  if (!plan) {
    throw new Error("FREE_PLAN_NOT_FOUND");
  }

  const usedToday = await getDailyUsageCount(client, userId, usageDate, BUSINESS_MESSAGE_RESOURCE_KEY);
  return { user, plan, subscription, usedToday };
}

function buildAccessFromContext(
  context: MembershipContext,
  now: Date,
  usedToday: number,
): MembershipAccessSnapshot {
  const freeTrialDays = resolvePlanFeatureNumber(
    context.plan.features,
    "free_trial_days",
    DEFAULT_FREE_TRIAL_DAYS,
  );
  const maxMessagesPerDay = resolvePlanFeatureNumber(
    context.plan.features,
    "max_messages_per_day",
    DEFAULT_FREE_DAILY_MESSAGE_LIMIT,
  );
  const extraBusinessCredits = Math.max(0, Math.trunc(context.user.extra_business_message_credits ?? 0));

  const base = evaluateMembershipAccess({
    planId: context.plan.id,
    planName: context.plan.name,
    hasActiveSubscription: context.subscription !== null,
    subscriptionExpiresAt: context.subscription?.expires_at ?? null,
    userCreatedAt: context.user.created_at,
    usedToday,
    maxMessagesPerDay,
    freeTrialDays,
    now,
  });

  // 统一带上额外业务次数余额，供前端展示。
  const annotated: MembershipAccessSnapshot = { ...base, extraBusinessMessageCredits: extraBusinessCredits };

  if (annotated.isMember) {
    return annotated;
  }

  if (annotated.allowed) {
    return {
      ...annotated,
      allowed: true,
    };
  }

  if (annotated.reasonCode === "FREE_DAILY_LIMIT_REACHED" && extraBusinessCredits > 0) {
    return {
      ...annotated,
      allowed: true,
      reasonCode: "EXTRA_BUSINESS_CREDITS_USED",
      reason: `今日免费额度已用完，正在使用赠送的额外业务次数（剩余 ${extraBusinessCredits} 次）。`,
    };
  }

  return annotated;
}

export async function getBusinessAccessSnapshot(userId: string, now: Date = new Date()): Promise<MembershipAccessSnapshot> {
  const usageDate = buildUsageDateStamp(now);
  return transaction(async (tx) => {
    const context = await loadMembershipContext(tx, userId, usageDate);
    return buildAccessFromContext(context, now, context.usedToday);
  });
}

export async function consumeBusinessMessageAccess(userId: string, now: Date = new Date()): Promise<MembershipAccessSnapshot> {
  const usageDate = buildUsageDateStamp(now);
  return transaction(async (client) => {
    const lockKey = `${userId}:${BUSINESS_MESSAGE_RESOURCE_KEY}:${usageDate}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

    const context = await loadMembershipContext(client, userId, usageDate);
    const beforeConsume = buildAccessFromContext(context, now, context.usedToday);
    if (beforeConsume.isMember) {
      return beforeConsume;
    }
    if (!beforeConsume.allowed && beforeConsume.reasonCode !== "EXTRA_BUSINESS_CREDITS_USED") {
      return beforeConsume;
    }

    const freeLimit = resolvePlanFeatureNumber(
      context.plan.features,
      "max_messages_per_day",
      DEFAULT_FREE_DAILY_MESSAGE_LIMIT,
    );
    const nextUsedCount = await incrementDailyUsageCount(client, userId, usageDate, BUSINESS_MESSAGE_RESOURCE_KEY);

    if (freeLimit !== null && nextUsedCount > freeLimit) {
      const currentCredits = Math.max(0, Math.trunc(context.user.extra_business_message_credits ?? 0));
      if (currentCredits <= 0) {
        return {
          ...beforeConsume,
          allowed: false,
          reasonCode: "FREE_DAILY_LIMIT_REACHED",
          reason: beforeConsume.reason ?? "免费用户每天额度已用完。",
        };
      }
      const creditsAfterConsume = currentCredits - 1;
      await client.query(
        `UPDATE users
            SET extra_business_message_credits = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [userId, creditsAfterConsume],
      );
      const reloadedContext = {
        ...context,
        user: { ...context.user, extra_business_message_credits: creditsAfterConsume },
      };
      return {
        ...buildAccessFromContext(reloadedContext, now, nextUsedCount),
        allowed: true,
        reasonCode: "EXTRA_BUSINESS_CREDITS_USED",
        reason: `今日免费额度已用完，已消耗管理员赠送的额外业务次数。`,
      };
    }

    const afterConsume = buildAccessFromContext(context, now, nextUsedCount);
    return {
      ...afterConsume,
      allowed: true,
      reasonCode: "OK",
      reason: null,
    };
  });
}
