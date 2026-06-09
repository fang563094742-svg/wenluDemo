/**
 * 问路 — 分享/邀请码 CRUD。
 */

import { query } from "./pool.js";

export interface ShareInvite {
  id: string;
  inviter_id: string;
  invite_code: string;
  plan_id: string;
  duration_days: number;
  max_uses: number;
  used_count: number;
  expires_at: Date;
  created_at: Date;
}

export interface ShareRedemption {
  id: string;
  invite_id: string;
  redeemer_id: string;
  created_at: Date;
}

/** 生成随机邀请码（6位字母数字）。 */
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆字符
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** 创建邀请（付费用户分享体验卡）。 */
export async function createInvite(
  inviterId: string,
  planId: string = "monthly",
  durationDays: number = 3,
  maxUses: number = 3,
  expiresInDays: number = 7,
): Promise<ShareInvite> {
  const code = generateCode();
  const result = await query<ShareInvite>(
    `INSERT INTO share_invites (inviter_id, invite_code, plan_id, duration_days, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expiresInDays} days')
     RETURNING *`,
    [inviterId, code, planId, durationDays, maxUses],
  );
  return result.rows[0];
}

/** 按邀请码查找。 */
export async function findInviteByCode(code: string): Promise<ShareInvite | null> {
  const result = await query<ShareInvite>(
    `SELECT * FROM share_invites WHERE invite_code = $1`,
    [code.toUpperCase()],
  );
  return result.rows[0] ?? null;
}

/** 使用邀请码（兑换体验）。 */
export async function redeemInvite(
  inviteCode: string,
  redeemerId: string,
): Promise<{ success: boolean; message: string; invite?: ShareInvite }> {
  const invite = await findInviteByCode(inviteCode);

  if (!invite) {
    return { success: false, message: "邀请码不存在" };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { success: false, message: "邀请码已过期" };
  }
  if (invite.used_count >= invite.max_uses) {
    return { success: false, message: "邀请码已用完" };
  }
  if (invite.inviter_id === redeemerId) {
    return { success: false, message: "不能使用自己的邀请码" };
  }

  // 检查是否已使用过
  const existingResult = await query(
    `SELECT id FROM share_redemptions WHERE invite_id = $1 AND redeemer_id = $2`,
    [invite.id, redeemerId],
  );
  if (existingResult.rows.length > 0) {
    return { success: false, message: "你已经使用过这个邀请码了" };
  }

  // 记录使用 + 增加计数
  await query(
    `INSERT INTO share_redemptions (invite_id, redeemer_id) VALUES ($1, $2)`,
    [invite.id, redeemerId],
  );
  await query(
    `UPDATE share_invites SET used_count = used_count + 1 WHERE id = $1`,
    [invite.id],
  );

  return { success: true, message: "兑换成功", invite };
}

/** 获取用户创建的邀请列表。 */
export async function getUserInvites(userId: string): Promise<ShareInvite[]> {
  const result = await query<ShareInvite>(
    `SELECT * FROM share_invites WHERE inviter_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}
