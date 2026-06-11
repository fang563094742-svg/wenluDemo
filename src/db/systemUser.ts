/**
 * 问路 — System_User 身份（决策 A6 / ADR-1）。
 *
 * 迁移期「原单份全局大脑」的历史数据归属到一个固定身份。为同时满足
 * 「人类可读名 = local」与「user_id 类型与 users.id(UUID) 一致、可 FK、RLS 干净」，
 * 采用固定哨兵 UUID + seed 一行 users(nickname='local')，应用层用 `local` 指代它。
 *
 * 阶段二多用户启用后，真实用户写各自 UUID，本行退化为「本机默认主人」。
 */

/** System_User 的固定哨兵 UUID（全零 UUID）。 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** 人类可读别名。 */
export const SYSTEM_USER_ALIAS = "local";

/** 把人类可读别名映射为真实 user_id（其它值原样返回）。 */
export function resolveUserId(idOrAlias: string): string {
  return idOrAlias === SYSTEM_USER_ALIAS ? SYSTEM_USER_ID : idOrAlias;
}
