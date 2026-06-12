/**
 * 问路 — 邀请奖励发放服务。
 */

import type pg from "pg";
import {
  applyInviteRewardSubscription,
  getPlanById,
  type Plan,
} from "../db/subscriptionRepo.js";
import {
  createInviteRewardGrant,
  findInviteRewardGrantByUniqueKey,
  getUserInvitedCount,
  listActiveInviteRewardPolicies,
  type InviteRewardPolicy,
  type InviteRewardTriggerType,
} from "../db/inviteRepo.js";
import { transaction } from "../db/pool.js";

const DEFAULT_REWARD_PLAN_ID = (process.env.INVITE_REWARD_DEFAULT_PLAN_ID ?? "member").trim() || "member";
const FREE_PLAN_ID = "free";

export interface AwardInviteRewardsInput {
  inviterUserId: string;
  inviteeUserId?: string | null;
  grantedBy?: string | null;
  executor?: Queryable;
}

export interface InviteRewardAwardResult {
  policyId: string;
  policyName: string;
  triggerType: InviteRewardTriggerType;
  triggerInvitedCount: number;
  rewardDurationDays: number;
  rewardPlanId: string | null;
  subscriptionId: string;
  subscriptionExpiresAt: Date | null;
  grantId: string;
  note: string | null;
}

export interface EvaluateInviteRewardResult {
  inviterUserId: string;
  invitedCount: number;
  awarded: InviteRewardAwardResult[];
  skipped: Array<{ policyId: string; reason: string }>;
}

type QueryExecutor = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

type Queryable = {
  query: QueryExecutor;
};

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.trunc(value);
  return int > 0 ? int : null;
}

function describeReward(policy: InviteRewardPolicy, invitedCount: number): string {
  if (policy.trigger_type === "per_count") {
    return `邀请人数达到 ${invitedCount}，触发“每邀请 ${policy.invite_count_step} 人送 ${policy.reward_duration_days} 天”规则`;
  }
  return `邀请人数达到 ${policy.threshold_count}，触发“一次性奖励 ${policy.reward_duration_days} 天”规则`;
}

function resolveTriggerCounts(policy: InviteRewardPolicy, invitedCount: number): number[] {
  if (policy.trigger_type === "per_count") {
    const step = normalizePositiveInteger(policy.invite_count_step);
    if (!step || invitedCount < step) {
      return [];
    }

    const totalTimes = Math.floor(invitedCount / step);
    const maxTimes = normalizePositiveInteger(policy.max_reward_times);
    const effectiveTimes = maxTimes ? Math.min(totalTimes, maxTimes) : totalTimes;
    const counts: number[] = [];
    for (let index = 1; index <= effectiveTimes; index += 1) {
      counts.push(index * step);
    }
    return counts;
  }

  const threshold = normalizePositiveInteger(policy.threshold_count);
  if (!threshold || invitedCount < threshold) {
    return [];
  }

  return [threshold];
}

async function resolveRewardPlan(policy: InviteRewardPolicy, executor?: Queryable): Promise<Plan | null> {
  const planId = policy.reward_plan_id?.trim() || DEFAULT_REWARD_PLAN_ID;
  const plan = await getPlanById(planId, executor);
  if (!plan || plan.id === FREE_PLAN_ID) {
    return null;
  }
  return plan;
}

async function awardInviteRewardsWithinExecutor(
  input: AwardInviteRewardsInput,
  executor: Queryable,
): Promise<EvaluateInviteRewardResult> {
  await executor.query(
    "SELECT id FROM users WHERE id = $1 FOR UPDATE",
    [input.inviterUserId],
  );

  const invitedCount = await getUserInvitedCount(input.inviterUserId, executor);
  const policies = await listActiveInviteRewardPolicies(executor);
  const awarded: InviteRewardAwardResult[] = [];
  const skipped: Array<{ policyId: string; reason: string }> = [];

  for (const policy of policies) {
    const triggerCounts = resolveTriggerCounts(policy, invitedCount);
    if (triggerCounts.length === 0) {
      skipped.push({ policyId: policy.id, reason: "未达到奖励条件" });
      continue;
    }

    const rewardPlan = await resolveRewardPlan(policy, executor);
    if (!rewardPlan) {
      skipped.push({ policyId: policy.id, reason: `奖励套餐不存在：${policy.reward_plan_id ?? DEFAULT_REWARD_PLAN_ID}` });
      continue;
    }

    for (const triggerInvitedCount of triggerCounts) {
      if (policy.trigger_type === "threshold_once") {
        const awardedBefore = await executor.query<{ id: string }>(
          `SELECT id FROM invite_reward_grants WHERE user_id = $1 AND policy_id = $2 LIMIT 1`,
          [input.inviterUserId, policy.id],
        );
        if (awardedBefore.rows[0]?.id) {
          continue;
        }
      }

      const existing = await findInviteRewardGrantByUniqueKey(
        input.inviterUserId,
        policy.id,
        triggerInvitedCount,
        executor,
      );
      if (existing) {
        continue;
      }

      const note = describeReward(policy, triggerInvitedCount);
      const subscription = await applyInviteRewardSubscription(
        input.inviterUserId,
        {
          durationDays: policy.reward_duration_days,
          preferredPlanId: rewardPlan.id,
        },
        executor,
      );

      const grant = await createInviteRewardGrant({
        userId: input.inviterUserId,
        policyId: policy.id,
        subscriptionId: subscription.id,
        rewardPlanId: rewardPlan.id,
        rewardDurationDays: policy.reward_duration_days,
        triggerInvitedCount,
        status: "granted",
        grantedBy: input.grantedBy ?? null,
        note: input.inviteeUserId
          ? `${note}；来源用户 ${input.inviteeUserId}`
          : note,
      }, executor);

      if (!grant) {
        continue;
      }

      awarded.push({
        policyId: policy.id,
        policyName: policy.name,
        triggerType: policy.trigger_type,
        triggerInvitedCount,
        rewardDurationDays: policy.reward_duration_days,
        rewardPlanId: rewardPlan.id,
        subscriptionId: subscription.id,
        subscriptionExpiresAt: subscription.expires_at,
        grantId: grant.id,
        note: grant.note,
      });
    }
  }

  return {
    inviterUserId: input.inviterUserId,
    invitedCount,
    awarded,
    skipped,
  };
}

export async function awardInviteRewards(
  input: AwardInviteRewardsInput,
): Promise<EvaluateInviteRewardResult> {
  if (input.executor) {
    return awardInviteRewardsWithinExecutor(input, input.executor);
  }

  return transaction((client) => awardInviteRewardsWithinExecutor(input, client));
}
