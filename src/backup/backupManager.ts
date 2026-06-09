/**
 * Backup_Manager —— 执行前备份与可回滚（R11）。
 *
 * 本文件分两个任务落地：
 *  - **任务 10.1（本任务）**：备份前的「体积估算」——纯函数 `estimateDirSize`
 *    与基于真实文件系统遍历的 `estimateSize`，产出 `SizeEstimate`
 *    （totalBytes / fileCount / exceededThreshold / thresholdBytes）。
 *  - 任务 10.2（后续追加）：`createBackup`（git 提交/stash 或文件快照），产出
 *    含 `rollbackInstruction` 的 `BackupHandle`；失败抛 `BackupError`。
 *
 * 安全背景（对抗性审查后强化，R11）：
 *  - 遍历/估算必须跳过 `BACKUP_IGNORE_DIRS`（默认 `.pad-backups`/`node_modules`/`.git`）。
 *    其中 `.pad-backups`（备份目录自身）若不排除会把上一次快照再次纳入，导致**无限递归 /
 *    体积爆炸**；`.git` 若不排除会进入 `.git/objects`，既慢又使估算严重失真；`node_modules`
 *    体积大且可重建。
 *  - 估算阶段遇到不可读目录/单文件 stat 失败时**跳过而非崩溃**（体积估算是非致命的准备步骤）。
 *  - 遍历**不跟随符号链接**（目录软链）以避免循环与越界，估算阶段从严。
 *
 * 大小警告 + 二次确认的状态门（`exceededThreshold` → `awaiting_backup_confirm`）由
 * Orchestrator 状态机强制，不在本模块实现（见任务 14.2 / Property 28）。
 *
 * _Requirements: 11.1_
 */

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { BACKUP_IGNORE_DIRS, BACKUP_SIZE_WARN_BYTES } from "../config/config.js";

const execFileAsync = promisify(execFile);

// ===========================================================================
// 类型契约（design.md「Backup_Manager（R11）」；本模块为 SizeEstimate/BackupHandle 权威来源）
// ===========================================================================

/**
 * 已确认的工作目录（sandbox 根）的结构化形态。
 *
 * 与 `scope/scopeResolver.ts`、`orchestrator/session.ts` 的 `WorkingDirectory`
 * （`{ rootAbsPath: string }`）结构一致：TypeScript 结构化类型下三者可直接互换传入，
 * 此处定义本地别名以保持备份模块对上游的低耦合。
 */
export interface WorkingDirectoryLike {
  /** 规范化后的绝对路径（sandbox 根，亦即体积估算的遍历起点）。 */
  rootAbsPath: string;
}

/** 备份前体积估算结果（R11）。 */
export interface SizeEstimate {
  /** 累计文件大小（字节，已排除忽略项）。 */
  totalBytes: number;
  /** 纳入统计的文件数（已排除忽略项）。 */
  fileCount: number;
  /** 是否超过警告阈值（`totalBytes > thresholdBytes`）；为真时上层需二次确认。 */
  exceededThreshold: boolean;
  /** 当前生效的警告阈值（字节，默认 `BACKUP_SIZE_WARN_BYTES`，config 可调）。 */
  thresholdBytes: number;
}

/** 备份句柄（含足以回滚到执行前状态的信息，R11.3）。任务 10.2 产出。 */
export interface BackupHandle {
  strategy: "git-commit" | "git-stash" | "file-snapshot";
  workingDirRoot: string;
  createdAt: string; // ISO8601
  /** git 策略：备份提交 hash 或 stash ref。 */
  gitRef?: string;
  /** 文件快照策略：快照目录位置（如 `.pad-backups/<timestamp>/`）。 */
  snapshotPath?: string;
  /** 足以将 Working_Directory 恢复到执行前状态的回滚说明（R11.3）。 */
  rollbackInstruction: string;
}

/**
 * 备份阶段的描述性错误（R11.2）。
 *
 * 抛出场景（任务 10.2）：备份创建失败。由 Orchestrator 捕获后转 `error` 状态、向用户返回
 * 描述性错误、详细错误记内部日志，**绝不进入 executing**。
 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/**
 * Backup_Manager 接口契约（design.md「Backup_Manager（R11）」）。
 *
 * 注：`estimateSize` 在本任务（10.1）实现；`createBackup` 由任务 10.2 追加。
 * 默认实现类 `DefaultBackupManager` 同样在任务 10.2 落地（届时聚合本文件的估算函数）。
 */
export interface Backup_Manager {
  /**
   * 快速遍历估算 Working_Directory 体积（累计文件大小），用于大小警告判定。
   * 遍历跳过 `BACKUP_IGNORE_DIRS`（备份目录自身/`node_modules`/`.git`），避免无限递归/体积爆炸。
   */
  estimateSize(workingDir: WorkingDirectoryLike): Promise<SizeEstimate>;

  /**
   * 在 Executor 执行任何动作前创建可回滚备份（R11.1）。任务 10.2 实现。
   * @throws BackupError 备份失败 → 上层中止执行（R11.2）。
   */
  createBackup(workingDir: WorkingDirectoryLike): Promise<BackupHandle>;
}

// ===========================================================================
// 纯函数：累计大小估算（排除忽略目录），便于属性测试（Property 见任务 10.x）
// ===========================================================================

/**
 * 累计一组文件条目的总字节数，排除路径中任一段命中 `ignoreDirs` 的条目（纯函数）。
 *
 * 判定方式：把每个条目的 `path` 按平台分隔符切段，若**任一路径段**等于某个忽略目录名，
 * 则该条目被排除。这样既能排除直接位于忽略目录下的文件，也能排除其更深层子孙。
 *
 * 之所以抽成纯函数：体积估算的核心算术与文件系统 IO 解耦，便于用属性测试覆盖
 * 「排除语义 + 累加正确性」而无需触碰真实磁盘。
 *
 * @param entries 文件条目（`path` 绝对/相对均可，`sizeBytes` 为文件字节数）。
 * @param ignoreDirs 需排除的目录名集合（如 `.pad-backups`/`node_modules`/`.git`）。
 * @returns 排除忽略项后的累计字节数。
 */
export function estimateDirSize(
  entries: { path: string; sizeBytes: number }[],
  ignoreDirs: string[],
): number {
  return entries
    .filter((e) => !isUnderIgnoredDir(e.path, ignoreDirs))
    .reduce((sum, e) => sum + e.sizeBytes, 0);
}

/** 路径是否有任一路径段命中忽略目录名（与 `estimateDirSize` 排除语义一致的内部判定）。 */
function isUnderIgnoredDir(p: string, ignoreDirs: string[]): boolean {
  const segments = p.split(path.sep);
  return ignoreDirs.some((d) => segments.includes(d));
}

// ===========================================================================
// 文件系统遍历 + estimateSize（任务 10.1）
// ===========================================================================

/** `estimateSize` 可注入选项（便于测试与 config 覆盖）。 */
export interface EstimateSizeOptions {
  /** 遍历/估算时跳过的目录名，默认 `BACKUP_IGNORE_DIRS`。 */
  ignoreDirs?: string[];
  /** 体积警告阈值（字节），默认 `BACKUP_SIZE_WARN_BYTES`。 */
  thresholdBytes?: number;
}

/**
 * 递归收集 `rootAbsPath` 下的文件条目（`{ path, sizeBytes }`），用于体积估算。
 *
 * 行为约束（安全/鲁棒）：
 *  - 跳过名称命中 `ignoreDirs` 的目录（防无限递归/体积爆炸/估算失真）。
 *  - **不跟随符号链接**（目录软链会造成循环/越界），估算阶段从严直接跳过软链条目。
 *  - 不可读目录（权限/竞态）或单文件 `stat` 失败时跳过该项，**不中断整体估算**。
 */
async function collectFileEntries(
  rootAbsPath: string,
  ignoreDirs: string[],
): Promise<{ path: string; sizeBytes: number }[]> {
  const out: { path: string; sizeBytes: number }[] = [];
  const ignore = new Set(ignoreDirs);

  async function walk(dir: string): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过，估算不因此崩溃
    }

    for (const ent of dirents) {
      const full = path.join(dir, ent.name);

      // 软链（含目录/文件软链）一律不跟随，避免循环与越界
      if (ent.isSymbolicLink()) continue;

      if (ent.isDirectory()) {
        if (ignore.has(ent.name)) continue; // 跳过忽略目录
        await walk(full);
        continue;
      }

      if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, sizeBytes: st.size });
        } catch {
          // 单文件 stat 失败（权限/竞态）跳过
        }
      }
    }
  }

  await walk(rootAbsPath);
  return out;
}

/**
 * 估算 Working_Directory 体积，产出 `SizeEstimate`（R11.1）。
 *
 * 流程：
 *  1. 递归遍历 `workingDir.rootAbsPath`，收集文件条目（遍历期间已跳过忽略目录与软链）。
 *  2. 用纯函数 `estimateDirSize` 累计总字节数（再次按 `ignoreDirs` 过滤，与遍历跳过形成双保险）。
 *  3. `fileCount` 取同口径过滤后的文件数。
 *  4. `exceededThreshold = totalBytes > thresholdBytes`，`thresholdBytes` 回传当前阈值。
 *
 * @param workingDir 已落定的工作目录（sandbox 根）。
 * @param options 可选 `ignoreDirs` / `thresholdBytes` 覆盖（默认取 config）。
 */
export async function estimateSize(
  workingDir: WorkingDirectoryLike,
  options: EstimateSizeOptions = {},
): Promise<SizeEstimate> {
  const ignoreDirs = options.ignoreDirs ?? BACKUP_IGNORE_DIRS;
  const thresholdBytes = options.thresholdBytes ?? BACKUP_SIZE_WARN_BYTES;

  const entries = await collectFileEntries(workingDir.rootAbsPath, ignoreDirs);

  const totalBytes = estimateDirSize(entries, ignoreDirs);
  const fileCount = entries.filter((e) => !isUnderIgnoredDir(e.path, ignoreDirs)).length;

  return {
    totalBytes,
    fileCount,
    exceededThreshold: totalBytes > thresholdBytes,
    thresholdBytes,
  };
}

// ===========================================================================
// 备份创建：createBackup（任务 10.2，R11.1 / R11.2 / R11.3）
// ===========================================================================

/** `createBackup` 可注入选项（便于测试与 config 覆盖）。 */
export interface CreateBackupOptions {
  /** 文件快照策略下跳过复制的目录名，默认 `BACKUP_IGNORE_DIRS`。 */
  ignoreDirs?: string[];
  /**
   * 时间戳生成器（ISO 形态会被规范化为文件名安全的 `<ts>`），默认取当前时间。
   * 注入便于测试快照目录命名确定性。
   */
  now?: () => Date;
}

/**
 * 判断 `rootAbsPath` 是否位于一个 git 工作树内（含其子目录）。
 *
 * 用 `git -C <root> rev-parse --is-inside-work-tree` 探测：命令成功且 stdout 为 `true`
 * 即视为 git 目录，走 git 备份策略；否则（非仓库 / 未安装 git / 命令失败）走文件快照策略。
 * 该探测失败**不抛错**——它只是用来选择策略，真正的备份失败才抛 `BackupError`。
 */
async function isGitWorkTree(rootAbsPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootAbsPath, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * 将 ISO 时间戳规范化为文件名安全的快照目录名片段（去掉 `:` 与 `.`）。
 * 例：`2026-06-03T04:17:12.691Z` → `2026-06-03T04-17-12-691Z`。
 */
function timestampToDirName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * git 仓库内的备份：`git add -A && git commit`，以提交 hash 作为 `gitRef`。
 *
 * 设计要点：
 *  - 优先用 `git commit` 建立一个明确的恢复点（提交 hash 即恢复引用，R11.3）。
 *  - 工作树「干净」（无任何可提交改动）时 `git commit` 会以非零码失败；此时回退为记录
 *    当前 HEAD 作为恢复点（已有提交即天然恢复点），策略仍标 `git-commit`。
 *  - 任何 git 调用的硬失败（非「无改动」类）→ 抛 `BackupError`，由上层中止执行（R11.2）。
 */
async function createGitBackup(rootAbsPath: string, createdAt: string): Promise<BackupHandle> {
  // 1) 暂存全部改动（含未跟踪文件）。失败即视为备份失败。
  try {
    await execFileAsync("git", ["-C", rootAbsPath, "add", "-A"], { encoding: "utf8" });
  } catch (err) {
    throw new BackupError(
      `git 备份失败：无法暂存改动（git add -A）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2) 尝试建立备份提交。无改动可提交时回退为记录当前 HEAD。
  const commitMessage = `PAD backup ${createdAt}`;
  try {
    await execFileAsync(
      "git",
      ["-C", rootAbsPath, "commit", "-m", commitMessage],
      { encoding: "utf8" },
    );
  } catch {
    // 提交失败最常见原因是「无改动可提交」——此时已有的 HEAD 即恢复点，不视为致命错误。
    // 其它原因（如无任何提交的空仓库）则在下方 rev-parse 阶段暴露。
  }

  // 3) 读取恢复点提交 hash（无论是新建提交还是既有 HEAD）。
  let gitRef: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootAbsPath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    gitRef = stdout.trim();
  } catch (err) {
    throw new BackupError(
      `git 备份失败：无法解析恢复点提交（git rev-parse HEAD）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (gitRef.length === 0) {
    throw new BackupError("git 备份失败：恢复点提交 hash 为空");
  }

  return {
    strategy: "git-commit",
    workingDirRoot: rootAbsPath,
    createdAt,
    gitRef,
    rollbackInstruction:
      `在 ${rootAbsPath} 执行 \`git reset --hard ${gitRef}\` 可将工作目录恢复到执行前状态` +
      `（如有未跟踪文件需另行 \`git clean -fd\`）。`,
  };
}

/**
 * 递归复制 `srcDir` 到 `destDir`，跳过名称命中 `ignore` 的目录与符号链接。
 *
 * 安全约束（与体积估算同源）：
 *  - 跳过 `ignore` 目录（含备份目录自身 `.pad-backups`）——否则会把上一次快照再次纳入新
 *    快照，导致**无限递归 / 体积爆炸**（R11 对抗性审查后强化）。
 *  - **不跟随符号链接**（目录/文件软链一律跳过），避免循环与越界复制。
 */
async function copyDirExcluding(
  srcDir: string,
  destDir: string,
  ignore: Set<string>,
): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const dirents = await fsp.readdir(srcDir, { withFileTypes: true });

  for (const ent of dirents) {
    if (ent.isSymbolicLink()) continue; // 不跟随软链
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);

    if (ent.isDirectory()) {
      if (ignore.has(ent.name)) continue; // 跳过忽略目录（含备份目录自身）
      await copyDirExcluding(srcPath, destPath, ignore);
      continue;
    }

    if (ent.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 非 git 目录的备份：复制到 `<root>/.pad-backups/<ts>/` 快照，排除忽略项与备份目录自身。
 *
 * @throws BackupError 复制过程中任何 IO 失败 → 备份失败，由上层中止执行（R11.2）。
 */
async function createFileSnapshot(
  rootAbsPath: string,
  ignoreDirs: string[],
  createdAt: string,
  date: Date,
): Promise<BackupHandle> {
  // 始终把备份目录自身排除，防无限递归 / 体积爆炸（即便调用方覆盖的 ignoreDirs 未含它）。
  const ignore = new Set([...ignoreDirs, ".pad-backups"]);
  const backupsRoot = path.join(rootAbsPath, ".pad-backups");
  const snapshotPath = path.join(backupsRoot, timestampToDirName(date));

  try {
    await copyDirExcluding(rootAbsPath, snapshotPath, ignore);
  } catch (err) {
    throw new BackupError(
      `文件快照备份失败：复制 ${rootAbsPath} 到 ${snapshotPath} 时出错：` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    strategy: "file-snapshot",
    workingDirRoot: rootAbsPath,
    createdAt,
    snapshotPath,
    rollbackInstruction:
      `执行前快照位于 ${snapshotPath}（已排除 ${[...ignore].join("/")}）。` +
      `如需恢复，用该目录内容覆盖回 ${rootAbsPath} 下对应文件即可还原到执行前状态。`,
  };
}

/**
 * 在 Executor 执行任何动作前创建可回滚备份（R11.1）。
 *
 * 策略选择：
 *  - **git 工作树** → `git add -A` + `git commit`，以提交 hash 作为 `gitRef` 恢复点
 *    （工作树干净时回退为记录当前 HEAD）。
 *  - **非 git 目录** → 复制到 `<root>/.pad-backups/<ts>/` 文件快照，**排除备份目录自身与
 *    忽略项**（防无限递归 / 体积爆炸）。
 *
 * 产出含 `rollbackInstruction` 的 `BackupHandle`（R11.3）；任何备份失败抛 `BackupError`，
 * 由 Orchestrator 转 `error`、向用户返回描述性错误、详细错误记内部日志，**绝不进入
 * executing**（R11.2）。
 *
 * 调用前提：若 `estimateSize` 超阈值，必须已获得用户二次确认（由 Orchestrator 经
 * `awaiting_backup_confirm` 状态保证）——本函数不负责该门禁。
 *
 * @throws BackupError 备份创建失败（R11.2）。
 */
export async function createBackup(
  workingDir: WorkingDirectoryLike,
  options: CreateBackupOptions = {},
): Promise<BackupHandle> {
  const rootAbsPath = workingDir.rootAbsPath;
  const ignoreDirs = options.ignoreDirs ?? BACKUP_IGNORE_DIRS;
  const date = (options.now ?? (() => new Date()))();
  const createdAt = date.toISOString();

  if (await isGitWorkTree(rootAbsPath)) {
    return createGitBackup(rootAbsPath, createdAt);
  }
  return createFileSnapshot(rootAbsPath, ignoreDirs, createdAt, date);
}

// ===========================================================================
// 默认实现类：聚合 estimateSize（10.1）+ createBackup（10.2）
// ===========================================================================

/**
 * `Backup_Manager` 的默认实现：聚合体积估算（`estimateSize`，任务 10.1）与备份创建
 * （`createBackup`，任务 10.2）。
 *
 * 可注入 `EstimateSizeOptions` 与 `CreateBackupOptions`（默认取 config 值），便于测试覆盖
 * 与 config 调参；不传时行为与模块级函数一致。
 */
export class DefaultBackupManager implements Backup_Manager {
  constructor(
    private readonly estimateOptions: EstimateSizeOptions = {},
    private readonly backupOptions: CreateBackupOptions = {},
  ) {}

  estimateSize(workingDir: WorkingDirectoryLike): Promise<SizeEstimate> {
    return estimateSize(workingDir, this.estimateOptions);
  }

  createBackup(workingDir: WorkingDirectoryLike): Promise<BackupHandle> {
    return createBackup(workingDir, this.backupOptions);
  }
}
