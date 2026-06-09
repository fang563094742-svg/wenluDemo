/**
 * 问路 — 短信验证码数据存储。
 *
 * 使用 PostgreSQL 存储验证码（便于多实例部署时共享状态）。
 */

import { query } from "./pool.js";

/**
 * 保存验证码。同时实现频率限制（60 秒内同一手机号不能重复发）。
 */
export async function saveSmsCode(phone: string, code: string, expireSeconds: number): Promise<void> {
  // 检查 60 秒内是否已发送
  const recent = await query(
    `SELECT id FROM sms_codes WHERE phone = $1 AND created_at > NOW() - INTERVAL '60 seconds'`,
    [phone],
  );

  if (recent.rowCount && recent.rowCount > 0) {
    throw new Error("频率限制：60 秒内不能重复发送");
  }

  await query(
    `INSERT INTO sms_codes (phone, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${expireSeconds} seconds')`,
    [phone, code],
  );
}

/**
 * 验证验证码。正确则删除（一次性）并返回 true。
 */
export async function verifySmsCode(phone: string, code: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM sms_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW() RETURNING id`,
    [phone, code],
  );
  return (result.rowCount ?? 0) > 0;
}
