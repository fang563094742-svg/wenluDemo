/**
 * 一次性历史数据搬运（multiuser-pg-store 任务 8）：
 * 把现有 .wenlu-local 的单份全局大脑迁入 PostgreSQL，归属 System_User（local）。
 *
 *   mind.json          → brain(SYSTEM_USER_ID)         （拆 6 板块）
 *   memory.json        → memory(SYSTEM_USER_ID)
 *   sensors/_state.json→ sensor_state(SYSTEM_USER_ID)
 *   channels.messages / 遗留 conversation → conversation_message（前向兼容填充）
 *
 * 搬运后做结构与关键计数一致性校验并报告差异；校验通过前保留源文件作冷备（本脚本绝不删源）。
 *
 * 运行：npx tsx scripts/migrateLocalToPg.ts
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { bootstrapDb, closePool, withUser } from "../src/db/pool.js";
import { SYSTEM_USER_ID } from "../src/db/systemUser.js";
import { upsertInitialBrain, loadBrain } from "../src/db/brainRepo.js";
import { saveMemoryFor, loadMemoryFor } from "../src/db/memoryRepo.js";
import { saveSensorState, loadSensorState } from "../src/db/sensorRepo.js";
import { appendMessage } from "../src/db/conversationRepo.js";
import { getWenluDataDir } from "../src/runtime/localDataDir.js";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function countArrays(o: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

async function main() {
  await bootstrapDb();
  const dir = getWenluDataDir();
  const report: string[] = [];

  // ── 大脑 ──
  const mind = await readJson<Record<string, unknown>>(resolvePath(dir, "mind.json"));
  if (mind) {
    await upsertInitialBrain(SYSTEM_USER_ID, mind);
    const back = await loadBrain(SYSTEM_USER_ID);
    const srcCounts = countArrays(mind);
    const dstCounts = countArrays(back);
    const diffs: string[] = [];
    for (const k of Object.keys(srcCounts)) {
      if (srcCounts[k] !== dstCounts[k]) diffs.push(`${k}: src=${srcCounts[k]} dst=${dstCounts[k]}`);
    }
    report.push(`[brain] 字段数 src=${Object.keys(mind).length} dst=${back ? Object.keys(back).length : 0}；数组计数差异=${diffs.length ? diffs.join(", ") : "无"}`);
  } else {
    report.push("[brain] 未找到 mind.json，跳过");
  }

  // ── 分层记忆 ──
  const mem = await readJson<Record<string, unknown>>(resolvePath(dir, "memory.json"));
  if (mem) {
    await saveMemoryFor(SYSTEM_USER_ID, mem);
    const back = await loadMemoryFor(SYSTEM_USER_ID);
    const ep = Array.isArray(mem.episodic) ? (mem.episodic as unknown[]).length : 0;
    const epBack = Array.isArray((back as { episodic?: unknown[] })?.episodic) ? ((back as { episodic: unknown[] }).episodic).length : 0;
    report.push(`[memory] episodic src=${ep} dst=${epBack}；meta.version=${JSON.stringify((back as { meta?: { version?: number } })?.meta?.version)}`);
  } else {
    report.push("[memory] 未找到 memory.json，跳过");
  }

  // ── 器官状态 ──
  const sensor = await readJson<Record<string, unknown>>(resolvePath(dir, "sensors", "_state.json"));
  if (sensor) {
    await saveSensorState(SYSTEM_USER_ID, sensor);
    const back = await loadSensorState(SYSTEM_USER_ID);
    report.push(`[sensor_state] 键数 src=${Object.keys(sensor).length} dst=${back ? Object.keys(back).length : 0}`);
  } else {
    report.push("[sensor_state] 未找到 sensors/_state.json，跳过");
  }

  // ── 对话（前向兼容填充 conversation_message；幂等性：仅当目标频道为空时填充）──
  if (mind) {
    const channels = (mind.channels as Array<{ id?: string; messages?: Array<{ role?: string; text?: string; time?: string }> }> | undefined) ?? [];
    let migrated = 0;
    for (const ch of channels) {
      const chId = ch.id ?? "chat_default";
      const existing = await withUser(SYSTEM_USER_ID, async (client) => {
        const r = await client.query<{ n: string }>(
          "SELECT COUNT(*) AS n FROM conversation_message WHERE user_id=$1 AND channel_id=$2",
          [SYSTEM_USER_ID, chId],
        );
        return parseInt(r.rows[0]?.n ?? "0", 10);
      });
      if (existing > 0) continue; // 已有则不重复灌
      for (const m of ch.messages ?? []) {
        const role = m.role === "user" || m.role === "wenlu" || m.role === "system" ? m.role : "system";
        await appendMessage(SYSTEM_USER_ID, chId, role, String(m.text ?? ""), m.time ? { time: m.time } : undefined);
        migrated++;
      }
    }
    report.push(`[conversation_message] 前向兼容填充 ${migrated} 条`);
  }

  console.log("─── 历史搬运报告 ───");
  for (const line of report) console.log(line);
  console.log("─── 源文件保留（未删除），可作回滚冷备 ───");
  await closePool();
}

main().catch((e) => { console.error("[migrateLocalToPg] 失败:", e); process.exit(1); });
