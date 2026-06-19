// 从 06-15 16:26 删除前的 tsx 转译缓存恢复（逻辑级还原为 TS）。
// 原始本地未提交代码于 06-15 重置时丢失，此文件依据转译产物重建。
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { scrubSecrets } from "../sovereign/privacy-boundary.js";

const CHANNELS_BACKUP_DIR = ".mind-backups";
// 备份间隔从 1 分钟拉到 5 分钟; 单用户单进程典型每天 ~150 个备份 (vs 之前 1440 个).
const BACKUP_MIN_INTERVAL_MS = 5 * 60_000;
let lastBackupTime = 0;

export interface ChannelLike {
  id?: string;
  [key: string]: unknown;
}

export interface PersistMindOptions {
  backupBeforeWrite?: boolean;
  blockOnChannelShrink?: boolean;
  backupDir?: string;
}

export interface PersistMindResult {
  backedUpTo?: string;
  channelCountBefore: number;
  channelCountAfter: number;
  shrank: boolean;
  mergedMissingChannelIds: string[];
  sizeDropDetected: boolean;
}

export interface ChannelSetComparison {
  beforeCount: number;
  afterCount: number;
  shrank: boolean;
  missingIds: string[];
}

export function timestampToSafeName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function parseBackupTimestamp(filename: string): number | null {
  const match = filename.match(
    /^mind\.json\.bak-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`).getTime();
}

export function compareChannelSets(
  before: ChannelLike[] | undefined,
  after: ChannelLike[] | undefined,
): ChannelSetComparison {
  const beforeIds = new Set(
    (before ?? []).map((c) => c?.id).filter((id): id is string => !!id),
  );
  const afterIds = new Set(
    (after ?? []).map((c) => c?.id).filter((id): id is string => !!id),
  );
  const missingIds = [...beforeIds].filter((id) => !afterIds.has(id));
  return {
    beforeCount: beforeIds.size,
    afterCount: afterIds.size,
    shrank: afterIds.size < beforeIds.size || missingIds.length > 0,
    missingIds,
  };
}

async function writeAtomicJson(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const tmp = join(dir, `.tmp-${timestampToSafeName()}-${process.pid}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

export async function pruneBackups(backupDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(backupDir);
  } catch {
    return;
  }
  const now = Date.now();
  // 配额阶梯 (multi-user 上线后单用户进程仍按这个跑, 比之前更紧):
  //  - 最近 15 分钟: 全保留 (短窗口随手回滚)
  //  - 15 分钟 -> 1 天: 每 15 分钟保留 1 个
  //  - 1 天 -> 7 天: 每天保留 1 个
  //  - 7 天前: 全删
  const QUARTER_HOUR = 15 * 60_000;
  const ONE_HOUR = 3_600_000;
  const ONE_DAY = 86_400_000;
  const SEVEN_DAYS = 7 * ONE_DAY;
  const parsed: { name: string; ts: number }[] = [];
  for (const f of files) {
    const ts = parseBackupTimestamp(f);
    if (ts != null) parsed.push({ name: f, ts });
  }
  parsed.sort((a, b) => b.ts - a.ts);
  const toDelete: string[] = [];
  const keptQuarterBuckets = new Set<number>();
  const keptDayBuckets = new Set<number>();
  for (const entry of parsed) {
    const age = now - entry.ts;
    if (age <= QUARTER_HOUR) {
      continue;
    } else if (age <= ONE_DAY) {
      const bucket = Math.floor(entry.ts / QUARTER_HOUR);
      if (keptQuarterBuckets.has(bucket)) {
        toDelete.push(entry.name);
      } else {
        keptQuarterBuckets.add(bucket);
      }
    } else if (age <= SEVEN_DAYS) {
      const bucket = Math.floor(entry.ts / ONE_DAY);
      if (keptDayBuckets.has(bucket)) {
        toDelete.push(entry.name);
      } else {
        keptDayBuckets.add(bucket);
      }
    } else {
      toDelete.push(entry.name);
    }
  }
  const batchSize = 100;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    await Promise.all(
      toDelete
        .slice(i, i + batchSize)
        .map((f) => unlink(join(backupDir, f)).catch(() => {})),
    );
  }
}

export async function persistMindJson(
  mindFile: string,
  payload: { channels?: ChannelLike[]; [key: string]: unknown } | null,
  options: PersistMindOptions = {},
): Promise<PersistMindResult> {
  const backupBeforeWrite = options.backupBeforeWrite ?? true;
  const blockOnChannelShrink = options.blockOnChannelShrink ?? false;
  const currentPayload = payload;
  const currentChannels = currentPayload?.channels;
  let previousChannels: ChannelLike[] | undefined;
  try {
    const raw = await readFile(mindFile, "utf-8");
    const prev = JSON.parse(raw);
    previousChannels = prev.channels;
  } catch {
    previousChannels = undefined;
  }
  const cmp = compareChannelSets(previousChannels, currentChannels);
  if (cmp.shrank && blockOnChannelShrink) {
    throw new Error(
      `mind.json 写盘阻断：频道数量从 ${cmp.beforeCount} 缩到 ${cmp.afterCount}，缺失: ${cmp.missingIds.join(", ") || "unknown"}`,
    );
  }
  let mergedMissingChannelIds: string[] = [];
  const mergedPayload = currentPayload
    ? structuredClone(currentPayload)
    : currentPayload;
  if (
    mergedPayload &&
    Array.isArray(previousChannels) &&
    Array.isArray(mergedPayload.channels)
  ) {
    const existing = new Set(
      mergedPayload.channels.map((c) => c?.id).filter((id): id is string => !!id),
    );
    const missing = previousChannels.filter(
      (ch) => ch?.id && !existing.has(ch.id),
    );
    if (missing.length > 0) {
      mergedMissingChannelIds = missing.map((ch) => ch.id as string);
      mergedPayload.channels = [
        ...mergedPayload.channels,
        ...missing.map((ch) => structuredClone(ch)),
      ];
    }
  }
  let backedUpTo: string | undefined;
  if (backupBeforeWrite) {
    const now = Date.now();
    if (now - lastBackupTime >= BACKUP_MIN_INTERVAL_MS) {
      try {
        const backupDir =
          options.backupDir ??
          resolvePath(dirname(mindFile), CHANNELS_BACKUP_DIR);
        await mkdir(backupDir, { recursive: true });
        const backupPath = join(
          backupDir,
          `mind.json.bak-${timestampToSafeName()}`,
        );
        try {
          await stat(mindFile);
          await writeFile(backupPath, await readFile(mindFile, "utf-8"), "utf-8");
          backedUpTo = backupPath;
          lastBackupTime = now;
        } catch {
          /* mindFile 不存在时跳过备份 */
        }
      } catch {
        /* 备份失败不阻断写盘 */
      }
      if (backedUpTo) {
        const backupDir =
          options.backupDir ??
          resolvePath(dirname(mindFile), CHANNELS_BACKUP_DIR);
        pruneBackups(backupDir).catch(() => {});
      }
    }
  }
  // 写盘前对 JSON 序列化结果统一过 scrubSecrets，挡住 LLM 误把 .env/token/api-key 写进 mind 的情况。
  const rawJson = JSON.stringify(mergedPayload ?? payload, null, 2);
  const scrubbed = scrubSecrets(rawJson);

  // 文件大小骤降告警：新 JSON < 旧文件 50% 且旧文件 >10KB 时强制备份+日志
  const SIZE_DROP_THRESHOLD = 0.5;
  const MIN_SIZE_FOR_CHECK = 10_240;
  let sizeDropDetected = false;
  try {
    const prevStat = await stat(mindFile);
    const prevSize = prevStat.size;
    const newSize = Buffer.byteLength(scrubbed.text, "utf-8");
    if (prevSize >= MIN_SIZE_FOR_CHECK && newSize < prevSize * SIZE_DROP_THRESHOLD) {
      sizeDropDetected = true;
      const dropBackupDir = resolvePath(dirname(mindFile), CHANNELS_BACKUP_DIR);
      await mkdir(dropBackupDir, { recursive: true });
      const dropBackupPath = join(dropBackupDir, `mind.json.size-drop-${timestampToSafeName()}`);
      await writeFile(dropBackupPath, await readFile(mindFile, "utf-8"), "utf-8");
      console.warn(
        `[persistMindJson] SIZE DROP ALERT: ${prevSize} → ${newSize} bytes (${Math.round((newSize / prevSize) * 100)}%). Backup: ${dropBackupPath}`,
      );
    }
  } catch {
    /* mindFile 不存在或 stat 失败，跳过检查 */
  }

  await writeAtomicJson(mindFile, scrubbed.text);
  return {
    backedUpTo,
    channelCountBefore: cmp.beforeCount,
    channelCountAfter: mergedPayload?.channels?.length ?? cmp.afterCount,
    shrank: cmp.shrank,
    mergedMissingChannelIds,
    sizeDropDetected,
  };
}
