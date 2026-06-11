/**
 * 问路 — MemoryRepo：分层记忆（LayeredMemory）按用户隔离存储。
 *
 * memory 表每用户一行，板块=列（working/episodic/semantic/procedural/meta）。
 * 保留原 LayeredMemory 的结构与 meta.version 语义；裁剪/巩固仍在内存（hippocampus）做，
 * 此处只负责整体读写（按脏板块）。所有读写经 withUser → RLS 隔离。
 */

import { withUser } from "./pool.js";

export type MemorySection = "working" | "episodic" | "semantic" | "procedural" | "meta";

export const MEMORY_SECTIONS: readonly MemorySection[] = [
  "working", "episodic", "semantic", "procedural", "meta",
];

export type LayeredMemoryLike = {
  working?: unknown;
  episodic?: unknown;
  semantic?: unknown;
  procedural?: unknown;
  meta?: unknown;
  [k: string]: unknown;
};

interface MemoryRow {
  working: unknown;
  episodic: unknown;
  semantic: unknown;
  procedural: unknown;
  meta: unknown;
}

/** 读取用户分层记忆；无行返回 null。 */
export async function loadMemoryFor(userId: string): Promise<LayeredMemoryLike | null> {
  return withUser(userId, async (client) => {
    const r = await client.query<MemoryRow>(
      "SELECT working, episodic, semantic, procedural, meta FROM memory WHERE user_id = $1",
      [userId],
    );
    if (!r.rows[0]) return null;
    return {
      working: r.rows[0].working,
      episodic: r.rows[0].episodic,
      semantic: r.rows[0].semantic,
      procedural: r.rows[0].procedural,
      meta: r.rows[0].meta,
    };
  });
}

/** 保存用户分层记忆（upsert 全板块；dirty 指定时只写变动列）。 */
export async function saveMemoryFor(
  userId: string,
  mem: LayeredMemoryLike,
  dirty?: Set<MemorySection>,
): Promise<void> {
  const sections: MemorySection[] = dirty && dirty.size > 0
    ? MEMORY_SECTIONS.filter((s) => dirty.has(s))
    : [...MEMORY_SECTIONS];

  const val = (s: MemorySection) => JSON.stringify(mem[s] ?? (s === "episodic" || s === "semantic" ? [] : {}));

  await withUser(userId, async (client) => {
    const exists = await client.query("SELECT 1 FROM memory WHERE user_id = $1", [userId]);
    if (exists.rows.length === 0) {
      await client.query(
        `INSERT INTO memory (user_id, working, episodic, semantic, procedural, meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, val("working"), val("episodic"), val("semantic"), val("procedural"), val("meta")],
      );
      return;
    }
    const setParts: string[] = [];
    const params: unknown[] = [userId];
    let idx = 2;
    for (const section of sections) {
      setParts.push(`${section} = $${idx}`);
      params.push(val(section));
      idx++;
    }
    setParts.push("updated_at = now()");
    await client.query(`UPDATE memory SET ${setParts.join(", ")} WHERE user_id = $1`, params);
  });
}
