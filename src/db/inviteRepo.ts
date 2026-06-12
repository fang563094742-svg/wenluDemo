/**
 * 问路 — 用户邀请码 / 邀请关系 / 邀请奖励规则。
 */

import type pg from "pg";
import { query, type QueryResult } from "./pool.js";

export interface InviteCodeOwner {
  id: string;
  phone: string | null;
  username: string | null;
  nickname: string | null;
  invite_code: string;
}

export interface UserInvitationSummary {
  userId: string;
  inviteCode: string;
  invitedByUserId: string | null;
  invitedAt: Date | null;
  invitedCount: number;
  inviter: InviteCodeOwner | null;
}

export interface InvitedUserRow {
  id: string;
  phone: string | null;
  username: string | null;
  nickname: string | null;
  created_at: Date;
  invited_at: Date | null;
}

export type InviteRewardTriggerType = "per_count" | "threshold_once";

export interface InviteRewardPolicy {
  id: string;
  name: string;
  description: string | null;
  trigger_type: InviteRewardTriggerType;
  invite_count_step: number | null;
  threshold_count: number | null;
  reward_duration_days: number;
  reward_plan_id: string | null;
  max_reward_times: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InviteRewardGrant {
  id: string;
  user_id: string;
  policy_id: string;
  subscription_id: string;
  reward_plan_id: string | null;
  reward_duration_days: number;
  trigger_invited_count: number;
  status: string;
  granted_by: string | null;
  note: string | null;
  granted_at: Date;
  created_at: Date;
}

export interface InviteRewardRecentGrant {
  id: string;
  policyId: string;
  policyName: string;
  triggerType: InviteRewardTriggerType;
  rewardPlanId: string | null;
  rewardDurationDays: number;
  triggerInvitedCount: number;
  status: string;
  grantedAt: Date;
  subscriptionId: string;
  subscriptionExpiresAt: Date | null;
}

export type InviteRewardProgressStatus = "in_progress" | "ready" | "completed";

export interface InviteRewardProgressItem {
  policyId: string;
  policyName: string;
  description: string | null;
  triggerType: InviteRewardTriggerType;
  rewardPlanId: string | null;
  rewardDurationDays: number;
  inviteCountStep: number | null;
  thresholdCount: number | null;
  maxRewardTimes: number | null;
  invitedCount: number;
  awardedTimes: number;
  nextTriggerCount: number | null;
  remainingInvites: number | null;
  status: InviteRewardProgressStatus;
}

export interface UserInviteRewardSummary {
  userId: string;
  grantedCount: number;
  totalRewardDays: number;
  latestReward: InviteRewardRecentGrant | null;
  recentRewards: InviteRewardRecentGrant[];
  progress: InviteRewardProgressItem[];
  nextPendingReward: InviteRewardProgressItem | null;
}

export interface CreateInviteRewardPolicyInput {
  name: string;
  description?: string | null;
  triggerType: InviteRewardTriggerType;
  inviteCountStep?: number | null;
  thresholdCount?: number | null;
  rewardDurationDays: number;
  rewardPlanId?: string | null;
  maxRewardTimes?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface UpdateInviteRewardPolicyInput {
  name?: string;
  description?: string | null;
  triggerType?: InviteRewardTriggerType;
  inviteCountStep?: number | null;
  thresholdCount?: number | null;
  rewardDurationDays?: number;
  rewardPlanId?: string | null;
  maxRewardTimes?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface CreateInviteRewardGrantInput {
  userId: string;
  policyId: string;
  subscriptionId: string;
  rewardPlanId?: string | null;
  rewardDurationDays: number;
  triggerInvitedCount: number;
  status?: string;
  grantedBy?: string | null;
  note?: string | null;
}

type UserInviteState = {
  id: string;
  invite_code: string | null;
  invited_by_user_id: string | null;
  invited_at: Date | null;
};

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

const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += INVITE_CODE_CHARS[Math.floor(Math.random() * INVITE_CODE_CHARS.length)];
  }
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "23505",
  );
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const integer = Math.trunc(value);
  return integer > 0 ? integer : null;
}

function toRecentGrant(row: {
  id: string;
  policy_id: string;
  policy_name: string | null;
  trigger_type: InviteRewardTriggerType | null;
  reward_plan_id: string | null;
  reward_duration_days: number;
  trigger_invited_count: number;
  status: string;
  granted_at: Date;
  subscription_id: string;
  subscription_expires_at: Date | null;
}): InviteRewardRecentGrant {
  return {
    id: row.id,
    policyId: row.policy_id,
    policyName: row.policy_name ?? "邀请奖励",
    triggerType: row.trigger_type ?? "threshold_once",
    rewardPlanId: row.reward_plan_id,
    rewardDurationDays: row.reward_duration_days,
    triggerInvitedCount: row.trigger_invited_count,
    status: row.status,
    grantedAt: row.granted_at,
    subscriptionId: row.subscription_id,
    subscriptionExpiresAt: row.subscription_expires_at,
  };
}

function buildInviteRewardProgressItem(
  policy: InviteRewardPolicy,
  invitedCount: number,
  awardedTimes: number,
): InviteRewardProgressItem {
  const normalizedAwardedTimes = Math.max(0, awardedTimes);
  const base = {
    policyId: policy.id,
    policyName: policy.name,
    description: policy.description,
    triggerType: policy.trigger_type,
    rewardPlanId: policy.reward_plan_id,
    rewardDurationDays: policy.reward_duration_days,
    inviteCountStep: policy.invite_count_step,
    thresholdCount: policy.threshold_count,
    maxRewardTimes: policy.max_reward_times,
    invitedCount,
    awardedTimes: normalizedAwardedTimes,
  };

  if (policy.trigger_type === "per_count") {
    const step = normalizePositiveInteger(policy.invite_count_step);
    const maxTimes = normalizePositiveInteger(policy.max_reward_times);
    if (!step) {
      return {
        ...base,
        nextTriggerCount: null,
        remainingInvites: null,
        status: "completed",
      };
    }

    if (maxTimes !== null && normalizedAwardedTimes >= maxTimes) {
      return {
        ...base,
        nextTriggerCount: null,
        remainingInvites: 0,
        status: "completed",
      };
    }

    const nextAwardIndex = normalizedAwardedTimes + 1;
    const nextTriggerCount = nextAwardIndex * step;
    const remainingInvites = Math.max(nextTriggerCount - invitedCount, 0);
    return {
      ...base,
      nextTriggerCount,
      remainingInvites,
      status: remainingInvites <= 0 ? "ready" : "in_progress",
    };
  }

  const thresholdCount = normalizePositiveInteger(policy.threshold_count);
  if (!thresholdCount) {
    return {
      ...base,
      nextTriggerCount: null,
      remainingInvites: null,
      status: "completed",
    };
  }

  if (normalizedAwardedTimes > 0) {
    return {
      ...base,
      nextTriggerCount: null,
      remainingInvites: 0,
      status: "completed",
    };
  }

  const remainingInvites = Math.max(thresholdCount - invitedCount, 0);
  return {
    ...base,
    nextTriggerCount: thresholdCount,
    remainingInvites,
    status: remainingInvites <= 0 ? "ready" : "in_progress",
  };
}

function pickNextPendingReward(progress: InviteRewardProgressItem[]): InviteRewardProgressItem | null {
  let best: InviteRewardProgressItem | null = null;
  for (const item of progress) {
    if (item.status === "completed") {
      continue;
    }
    if (!best) {
      best = item;
      continue;
    }
    if (best.status !== "ready" && item.status === "ready") {
      best = item;
      continue;
    }
    if (best.status === "ready" && item.status !== "ready") {
      continue;
    }
    const bestRemaining = best.remainingInvites ?? Number.MAX_SAFE_INTEGER;
    const nextRemaining = item.remainingInvites ?? Number.MAX_SAFE_INTEGER;
    if (nextRemaining < bestRemaining) {
      best = item;
    }
  }
  return best;
}

export function normalizeInviteCode(inviteCode: string): string {
  return inviteCode.trim().toUpperCase();
}

export async function findUserByInviteCode(
  inviteCode: string,
  executor?: Queryable,
): Promise<InviteCodeOwner | null> {
  const normalized = normalizeInviteCode(inviteCode);
  if (!normalized) return null;

  const result = await db(executor).query<InviteCodeOwner>(
    `SELECT id, phone, username, nickname, invite_code
       FROM users
      WHERE invite_code = $1`,
    [normalized],
  );
  return result.rows[0] ?? null;
}

export async function ensureUserInviteCode(
  userId: string,
  executor?: Queryable,
): Promise<string> {
  const stateResult = await db(executor).query<UserInviteState>(
    `SELECT id, invite_code, invited_by_user_id, invited_at
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const state = stateResult.rows[0];
  if (!state) {
    throw new Error("USER_NOT_FOUND");
  }
  if (state.invite_code) {
    return state.invite_code;
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateInviteCode();
    try {
      const updateResult = await db(executor).query<{ invite_code: string }>(
        `UPDATE users
            SET invite_code = $2,
                updated_at = NOW()
          WHERE id = $1
            AND invite_code IS NULL
        RETURNING invite_code`,
        [userId, candidate],
      );
      const assigned = updateResult.rows[0]?.invite_code;
      if (assigned) {
        return assigned;
      }

      const latestResult = await db(executor).query<{ invite_code: string | null }>(
        "SELECT invite_code FROM users WHERE id = $1",
        [userId],
      );
      const latest = latestResult.rows[0]?.invite_code;
      if (latest) {
        return latest;
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("INVITE_CODE_GENERATION_FAILED");
}

export async function bindUserToInviterByCode(
  userId: string,
  inviteCode: string,
  executor?: Queryable,
): Promise<InviteCodeOwner> {
  const normalized = normalizeInviteCode(inviteCode);
  if (!normalized) {
    throw new Error("INVITE_CODE_REQUIRED");
  }

  const [userResult, inviter] = await Promise.all([
    db(executor).query<UserInviteState>(
      `SELECT id, invite_code, invited_by_user_id, invited_at
         FROM users
        WHERE id = $1`,
      [userId],
    ),
    findUserByInviteCode(normalized, executor),
  ]);

  const user = userResult.rows[0];
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }
  if (user.invited_by_user_id) {
    throw new Error("ALREADY_INVITED");
  }
  if (!inviter) {
    throw new Error("INVITE_CODE_NOT_FOUND");
  }
  if (inviter.id === userId) {
    throw new Error("SELF_INVITE_NOT_ALLOWED");
  }

  const updated = await db(executor).query<{ invited_by_user_id: string }>(
    `UPDATE users
        SET invited_by_user_id = $2,
            invited_at = COALESCE(invited_at, NOW()),
            updated_at = NOW()
      WHERE id = $1
        AND invited_by_user_id IS NULL
    RETURNING invited_by_user_id`,
    [userId, inviter.id],
  );

  if (!updated.rows[0]?.invited_by_user_id) {
    throw new Error("ALREADY_INVITED");
  }

  return inviter;
}

export async function getUserInvitedCount(
  userId: string,
  executor?: Queryable,
): Promise<number> {
  const result = await db(executor).query<{ invited_count: number }>(
    `SELECT COUNT(*)::int AS invited_count
       FROM users
      WHERE invited_by_user_id = $1`,
    [userId],
  );
  return result.rows[0]?.invited_count ?? 0;
}

export async function getUserInvitationSummary(
  userId: string,
  executor?: Queryable,
): Promise<UserInvitationSummary> {
  const inviteCode = await ensureUserInviteCode(userId, executor);
  const result = await db(executor).query<{
    invited_by_user_id: string | null;
    invited_at: Date | null;
    invited_count: number;
    inviter_id: string | null;
    inviter_phone: string | null;
    inviter_username: string | null;
    inviter_nickname: string | null;
    inviter_invite_code: string | null;
  }>(
    `SELECT
       u.invited_by_user_id,
       u.invited_at,
       (SELECT COUNT(*)::int FROM users child WHERE child.invited_by_user_id = u.id) AS invited_count,
       inviter.id AS inviter_id,
       inviter.phone AS inviter_phone,
       inviter.username AS inviter_username,
       inviter.nickname AS inviter_nickname,
       inviter.invite_code AS inviter_invite_code
     FROM users u
     LEFT JOIN users inviter ON inviter.id = u.invited_by_user_id
     WHERE u.id = $1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("USER_NOT_FOUND");
  }

  return {
    userId,
    inviteCode,
    invitedByUserId: row.invited_by_user_id,
    invitedAt: row.invited_at,
    invitedCount: row.invited_count,
    inviter: row.inviter_id
      ? {
        id: row.inviter_id,
        phone: row.inviter_phone,
        username: row.inviter_username,
        nickname: row.inviter_nickname,
        invite_code: row.inviter_invite_code ?? "",
      }
      : null,
  };
}

export async function listInvitedUsers(
  userId: string,
  limit = 20,
  executor?: Queryable,
): Promise<InvitedUserRow[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 100) : 20;
  const result = await db(executor).query<InvitedUserRow>(
    `SELECT id, phone, username, nickname, created_at, invited_at
       FROM users
      WHERE invited_by_user_id = $1
      ORDER BY invited_at DESC NULLS LAST, created_at DESC
      LIMIT $2`,
    [userId, safeLimit],
  );
  return result.rows;
}

export async function listInviteRewardPolicies(executor?: Queryable): Promise<InviteRewardPolicy[]> {
  const result = await db(executor).query<InviteRewardPolicy>(
    `SELECT *
       FROM invite_reward_policies
      ORDER BY is_active DESC, sort_order ASC, created_at ASC`,
  );
  return result.rows;
}

export async function listActiveInviteRewardPolicies(executor?: Queryable): Promise<InviteRewardPolicy[]> {
  const result = await db(executor).query<InviteRewardPolicy>(
    `SELECT *
       FROM invite_reward_policies
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, created_at ASC`,
  );
  return result.rows;
}

export async function getInviteRewardPolicyById(
  policyId: string,
  executor?: Queryable,
): Promise<InviteRewardPolicy | null> {
  const result = await db(executor).query<InviteRewardPolicy>(
    "SELECT * FROM invite_reward_policies WHERE id = $1",
    [policyId],
  );
  return result.rows[0] ?? null;
}

export async function createInviteRewardPolicy(
  input: CreateInviteRewardPolicyInput,
  executor?: Queryable,
): Promise<InviteRewardPolicy> {
  const result = await db(executor).query<InviteRewardPolicy>(
    `INSERT INTO invite_reward_policies (
       name,
       description,
       trigger_type,
       invite_count_step,
       threshold_count,
       reward_duration_days,
       reward_plan_id,
       max_reward_times,
       sort_order,
       is_active,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      input.name,
      input.description ?? null,
      input.triggerType,
      normalizePositiveInteger(input.inviteCountStep),
      normalizePositiveInteger(input.thresholdCount),
      Math.max(1, Math.trunc(input.rewardDurationDays)),
      input.rewardPlanId?.trim() || null,
      normalizePositiveInteger(input.maxRewardTimes),
      Math.max(0, Math.trunc(input.sortOrder ?? 0)),
      input.isActive ?? true,
    ],
  );
  return result.rows[0]!;
}

export async function updateInviteRewardPolicy(
  policyId: string,
  fields: UpdateInviteRewardPolicyInput,
  executor?: Queryable,
): Promise<InviteRewardPolicy | null> {
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
  if (fields.triggerType !== undefined) {
    sets.push(`trigger_type = $${index++}`);
    params.push(fields.triggerType);
  }
  if (fields.inviteCountStep !== undefined) {
    sets.push(`invite_count_step = $${index++}`);
    params.push(normalizePositiveInteger(fields.inviteCountStep));
  }
  if (fields.thresholdCount !== undefined) {
    sets.push(`threshold_count = $${index++}`);
    params.push(normalizePositiveInteger(fields.thresholdCount));
  }
  if (fields.rewardDurationDays !== undefined) {
    sets.push(`reward_duration_days = $${index++}`);
    params.push(Math.max(1, Math.trunc(fields.rewardDurationDays)));
  }
  if (fields.rewardPlanId !== undefined) {
    sets.push(`reward_plan_id = $${index++}`);
    params.push(fields.rewardPlanId?.trim() || null);
  }
  if (fields.maxRewardTimes !== undefined) {
    sets.push(`max_reward_times = $${index++}`);
    params.push(normalizePositiveInteger(fields.maxRewardTimes));
  }
  if (fields.sortOrder !== undefined) {
    sets.push(`sort_order = $${index++}`);
    params.push(Math.max(0, Math.trunc(fields.sortOrder)));
  }
  if (fields.isActive !== undefined) {
    sets.push(`is_active = $${index++}`);
    params.push(fields.isActive);
  }

  if (sets.length === 0) {
    return getInviteRewardPolicyById(policyId, executor);
  }

  sets.push(`updated_at = NOW()`);
  params.push(policyId);
  const result = await db(executor).query<InviteRewardPolicy>(
    `UPDATE invite_reward_policies
        SET ${sets.join(", ")}
      WHERE id = $${index}
    RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function createInviteRewardGrant(
  input: CreateInviteRewardGrantInput,
  executor?: Queryable,
): Promise<InviteRewardGrant | null> {
  const result = await db(executor).query<InviteRewardGrant>(
    `INSERT INTO invite_reward_grants (
       user_id,
       policy_id,
       subscription_id,
       reward_plan_id,
       reward_duration_days,
       trigger_invited_count,
       status,
       granted_by,
       note,
       granted_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (user_id, policy_id, trigger_invited_count) DO NOTHING
     RETURNING *`,
    [
      input.userId,
      input.policyId,
      input.subscriptionId,
      input.rewardPlanId?.trim() || null,
      Math.max(1, Math.trunc(input.rewardDurationDays)),
      Math.max(1, Math.trunc(input.triggerInvitedCount)),
      input.status?.trim() || "granted",
      input.grantedBy?.trim() || null,
      input.note?.trim() || null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function findInviteRewardGrantByUniqueKey(
  userId: string,
  policyId: string,
  triggerInvitedCount: number,
  executor?: Queryable,
): Promise<InviteRewardGrant | null> {
  const result = await db(executor).query<InviteRewardGrant>(
    `SELECT *
       FROM invite_reward_grants
      WHERE user_id = $1
        AND policy_id = $2
        AND trigger_invited_count = $3
      LIMIT 1`,
    [userId, policyId, Math.max(1, Math.trunc(triggerInvitedCount))],
  );
  return result.rows[0] ?? null;
}

export async function listUserInviteRewardGrants(
  userId: string,
  limit = 10,
  executor?: Queryable,
): Promise<InviteRewardRecentGrant[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 100) : 10;
  const result = await db(executor).query<{
    id: string;
    policy_id: string;
    policy_name: string | null;
    trigger_type: InviteRewardTriggerType | null;
    reward_plan_id: string | null;
    reward_duration_days: number;
    trigger_invited_count: number;
    status: string;
    granted_at: Date;
    subscription_id: string;
    subscription_expires_at: Date | null;
  }>(
    `SELECT
       g.id,
       g.policy_id,
       p.name AS policy_name,
       p.trigger_type,
       g.reward_plan_id,
       g.reward_duration_days,
       g.trigger_invited_count,
       g.status,
       g.granted_at,
       g.subscription_id,
       s.expires_at AS subscription_expires_at
     FROM invite_reward_grants g
     JOIN invite_reward_policies p ON p.id = g.policy_id
     JOIN subscriptions s ON s.id = g.subscription_id
     WHERE g.user_id = $1
     ORDER BY g.granted_at DESC, g.created_at DESC
     LIMIT $2`,
    [userId, safeLimit],
  );
  return result.rows.map(toRecentGrant);
}

export async function getUserInviteRewardSummary(
  userId: string,
  executor?: Queryable,
): Promise<UserInviteRewardSummary> {
  const [aggregateResult, recentRewards, invitedCount, activePolicies, awardedResult] = await Promise.all([
    db(executor).query<{ granted_count: number; total_reward_days: number }>(
      `SELECT
         COUNT(*)::int AS granted_count,
         COALESCE(SUM(reward_duration_days), 0)::int AS total_reward_days
       FROM invite_reward_grants
       WHERE user_id = $1
         AND status = 'granted'`,
      [userId],
    ),
    listUserInviteRewardGrants(userId, 5, executor),
    getUserInvitedCount(userId, executor),
    listActiveInviteRewardPolicies(executor),
    db(executor).query<{ policy_id: string; awarded_times: number }>(
      `SELECT policy_id, COUNT(*)::int AS awarded_times
         FROM invite_reward_grants
        WHERE user_id = $1
          AND status = 'granted'
        GROUP BY policy_id`,
      [userId],
    ),
  ]);

  const aggregate = aggregateResult.rows[0] ?? { granted_count: 0, total_reward_days: 0 };
  const awardedTimesMap = new Map<string, number>();
  for (const row of awardedResult.rows) {
    awardedTimesMap.set(row.policy_id, Math.max(0, row.awarded_times ?? 0));
  }

  const progress = activePolicies.map((policy) => buildInviteRewardProgressItem(
    policy,
    invitedCount,
    awardedTimesMap.get(policy.id) ?? 0,
  ));
  const nextPendingReward = pickNextPendingReward(progress);

  return {
    userId,
    grantedCount: aggregate.granted_count,
    totalRewardDays: aggregate.total_reward_days,
    latestReward: recentRewards[0] ?? null,
    recentRewards,
    progress,
    nextPendingReward,
  };
}
