/**
 * 问路 — SensorRepo：感知器官运行状态（原 sensors/_state.json）按用户隔离存储。
 */

import { withUser } from "./pool.js";

/** 读取用户器官状态；无行返回 null。 */
export async function loadSensorState(userId: string): Promise<Record<string, unknown> | null> {
  return withUser(userId, async (client) => {
    const r = await client.query<{ state: Record<string, unknown> }>(
      "SELECT state FROM sensor_state WHERE user_id = $1",
      [userId],
    );
    return r.rows[0]?.state ?? null;
  });
}

/** 保存用户器官状态（upsert）。 */
export async function saveSensorState(userId: string, state: Record<string, unknown>): Promise<void> {
  await withUser(userId, async (client) => {
    await client.query(
      `INSERT INTO sensor_state (user_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET state = $2, updated_at = now()`,
      [userId, JSON.stringify(state)],
    );
  });
}
