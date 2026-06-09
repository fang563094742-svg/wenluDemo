/**
 * proactive-awareness-demo —— macOS 两段式扫描器实现（任务 4.6）。
 *
 * 实现 `Device_Scanner` 契约的 macOS（`darwin`）版本，落地 design.md
 * 「Mac_Scanner 两段式实现（R3）」：
 *
 *   ┌── 阶段1 规则粗筛（低成本，**绝不读正文**，仅元信息）────────────────┐
 *   │  · 文件：遍历用户目录，按 `mtime ≥ now - recentDays` 过滤，仅取        │
 *   │    `{name, path, mtime, sizeBytes, ext}`（R3.1）。                    │
 *   │  · git ：对发现的仓库根执行 `git log --since` 等**只读**命令，          │
 *   │    提取近期提交与改动文件（R3.2）。                                    │
 *   │  · App ：通过 `System Events` **只读**查询当前在用 App 名（R3.3）。    │
 *   │  · 采集阶段即调用 `isExcluded` 应用排除红线（R4，越早排除越安全）。     │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌── 阶段2 打分排序 + Top N 精选 → 组装 `Scan_Summary`────────────────┐
 *   │  · 打分函数：新近度 + git 活跃度 + 同目录聚类度。                       │
 *   │  · `selectTopN` 取前 N，组装 `Scan_Summary`。                          │
 *   │  · **仅 `Scan_Summary` 外传给 Analyzer，原始粗筛数据不外传**（R3.5）。  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * 扫描具身化（可选增强，R16.2）：阶段1 粗筛过程中，每发现一批新的文件 / git 仓库 /
 * 在用 App，即通过 `onProgress` 推送一条 `{ type:"scan:progress", found:[...] }`——
 * `found` **仅承载已通过排除红线的元信息级线索**（文件名 / 路径片段、仓库名、App 名），
 * **绝不含文件正文**。不传 `onProgress` 时静默退化为普通扫描，行为不变（非破坏性追加）。
 *
 * 安全边界（贯穿全文件）：
 *  - **只读元信息**：仅 `readdir` / `stat`（元信息）、`git log` 等**只读** git 命令、
 *    `System Events` **只读**进程查询；**从不读取任何文件正文**（R3.1/R4.4/R18.4）。
 *  - **绝不修改被扫描目录**：不写、不删、不创建任何被扫描内容；不跟随符号链接
 *    （避免越界与环路）。
 *  - 非 macOS 平台：抛 `ScanError` 描述性"暂不支持"提示（R1.5），由编排层捕获后
 *    友好呈现并保持服务运行（composition root 亦会按 `process.platform` 分派）。
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 2.2, 2.3, 2.5, 16.2_
 */

import { promises as fs, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

import { defaultExclusionPolicy, type ExclusionPolicy } from "./exclusionPolicy.js";
import { selectTopN } from "./selectTopN.js";
import type { Device_Scanner } from "./deviceScanner.js";
import type {
  AppActivity,
  FileMeta,
  GitActivity,
  Scan_Summary,
  ScanOptions,
  ScanProgressEvent,
  ScanSummaryItem,
} from "./types.js";
import { collectContextSignals } from "./contextSensors.js";

const execFileAsync = promisify(execFile);

/** 扫描阶段的描述性错误（对应 Error Handling 中的非致命错误，R1.5）。 */
export class ScanError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanError";
  }
}

// ===========================================================================
// 调参常量（遍历界限 / 外部命令超时 / 打分权重）—— 均为内部实现细节
// ===========================================================================

/** 目录遍历最大深度（防御性界限，避免病态深目录拖慢 demo 扫描）。 */
const MAX_DEPTH = 8;
/** 阶段1 最多采集的文件元信息条数（界限，超出即停止遍历）。 */
const MAX_FILES = 5000;
/** 性能跳过目录（与隐私排除红线 `isExcluded` 正交，仅为遍历提速、避免无谓深潜）。 */
const TRAVERSAL_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git", // 仓库内部对象，按名标记仓库根后即跳过，不进入 .git 子树
  ".cache",
  "dist",
  "build",
  ".next",
]);

/** `onProgress` 线索分批大小：累计到该数量即推送一条 `scan:progress`。 */
const PROGRESS_BATCH_SIZE = 6;

/** 外部只读命令超时（ms）：防止单个 git / osascript 调用挂死整轮扫描。 */
const SUBPROCESS_TIMEOUT_MS = 5000;
/** 外部命令输出缓冲上限（10MB），避免超大仓库 git log 撑爆默认 1MB 缓冲。 */
const SUBPROCESS_MAX_BUFFER = 10 * 1024 * 1024;

/** 单仓库最多保留的近期提交数（保持 `Scan_Summary` 精简）。 */
const MAX_COMMITS_PER_REPO = 30;
/** 单仓库最多保留的改动文件路径数。 */
const MAX_CHANGED_FILES_PER_REPO = 50;

/** 打分权重：文件新近度（0-1 归一后乘此权重）。 */
const RECENCY_WEIGHT = 1.0;
/**
 * 打分权重：同目录聚类度（0-1 归一后乘此权重）。
 * Improvement 1 第 2 层：从 0.5 大幅降到 0.15——保留极弱的聚类信号即可，避免
 * 「成百上千堆在一个目录的同类机器产物」单凭聚类度霸榜，挤掉用户真正在创作的文档/代码。
 */
const CLUSTER_WEIGHT = 0.15;
/** 同目录聚类计数上限（>= 该值的聚类因子封顶为 1）。 */
const CLUSTER_CAP = 5;
/**
 * 打分权重：用户内容类型（文档 / 代码 / 创作类文件）。
 * Improvement 1 第 2 层：奖励「用户主动创作 / 编辑」的内容，使其在同等新近度下
 * 排到机器产物之前。
 */
const CONTENT_TYPE_WEIGHT = 0.6;
/** git 条目基础分（git 活动是强信号，整体高于普通文件）。 */
const GIT_BASE_SCORE = 2.0;
/** git 条目每条近期提交的加权。 */
const GIT_COMMIT_WEIGHT = 0.1;
/** git 提交计数上限（封顶，避免超活跃仓库分数失真）。 */
const GIT_COMMIT_CAP = 10;
/** 在用 App 条目基础分（当下信号，但不如具体文件 / git 精确）。 */
const APP_BASE_SCORE = 0.8;

/**
 * 用户内容类型扩展名（不含点、小写）：文档 / 代码 / 创作类文件。
 * Improvement 1 第 2 层：命中这些扩展名的文件被视为「用户主动创作 / 编辑」的内容，
 * 在打分时获得 `CONTENT_TYPE_WEIGHT` 加权，从而优先于机器产物。
 */
export const USER_CONTENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // 文档 / 创作
  "md",
  "markdown",
  "txt",
  "rtf",
  "doc",
  "docx",
  "pdf",
  "pages",
  "key",
  "numbers",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "tex",
  // 代码
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sql",
  "sh",
  "json",
  "yaml",
  "yml",
  "toml",
  "html",
  "css",
  "scss",
  "vue",
  "svelte",
  "ipynb",
]);

/**
 * 系统常驻 App 黑名单（小写匹配）。Improvement 1 第 2 层：这些是 macOS 系统/桌面常驻
 * 进程，几乎总在「在用」，不反映用户当下的真实意图，应从 App 信号中过滤掉。
 */
export const SYSTEM_APP_DENYLIST: ReadonlySet<string> = new Set([
  "finder",
  "dock",
  "system settings",
  "systemuiserver",
  "controlcenter",
  "notification center",
  "notificationcenter",
  "activity monitor",
  "loginwindow",
  "windowserver",
  "spotlight",
  "siri",
  "coreservicesuiagent",
  "universalcontrol",
  "textinputmenuagent",
]);

/**
 * 判定某 App 是否为应过滤的系统常驻 App（大小写不敏感）。纯函数，便于单测。
 *
 * @param appName App 名称（如 "Finder"、"System Settings"、"Code"）。
 * @returns `true` 表示系统常驻 App（应过滤）；`false` 表示保留为用户活动信号。
 */
export function isSystemApp(appName: string): boolean {
  return SYSTEM_APP_DENYLIST.has(appName.trim().toLowerCase());
}

/**
 * 文件打分纯函数（Improvement 1 第 2 层）。便于单测：
 *
 *   score = RECENCY_WEIGHT * recency01
 *         + CLUSTER_WEIGHT  * clusterFactor
 *         + CONTENT_TYPE_WEIGHT * contentTypeFactor
 *
 * 其中 `contentTypeFactor` 当文件扩展名命中 `USER_CONTENT_EXTENSIONS` 时为 1，否则 0。
 *
 * @param meta 文件元信息（仅用扩展名判定内容类型）。
 * @param recency01 已归一到 [0,1] 的新近度。
 * @param clusterFactor 已归一到 [0,1] 的同目录聚类度。
 */
export function scoreFile(
  meta: FileMeta,
  recency01: number,
  clusterFactor: number,
): number {
  const ext = (meta.ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  const contentTypeFactor = USER_CONTENT_EXTENSIONS.has(ext) ? 1 : 0;
  return (
    RECENCY_WEIGHT * recency01 +
    CLUSTER_WEIGHT * clusterFactor +
    CONTENT_TYPE_WEIGHT * contentTypeFactor
  );
}

// ===========================================================================
// 流式进度分批器（扫描具身化，可选增强）
// ===========================================================================

/**
 * 把零散的元信息级线索按批推送给 `onProgress`。不传 `onProgress` 时全为 no-op，
 * 实现"静默退化、行为不变"（R16.2）。
 */
interface ProgressBatcher {
  /** 累加一条线索，达到批大小即自动推送一批。 */
  push(clue: string): void;
  /** 推送剩余未满批的线索（收尾调用）。 */
  flush(): void;
}

function createProgressBatcher(
  onProgress?: (event: ScanProgressEvent) => void,
): ProgressBatcher {
  // 未提供回调：返回 no-op 批器，调用方无需分支判断。
  if (!onProgress) {
    return { push: () => {}, flush: () => {} };
  }
  let pending: string[] = [];
  const emit = (): void => {
    if (pending.length === 0) {
      return;
    }
    // 仅推送元信息级线索（文件名 / 路径片段、仓库名、App 名），绝不含正文。
    onProgress({ type: "scan:progress", found: pending });
    pending = [];
  };
  return {
    push(clue: string): void {
      pending.push(clue);
      if (pending.length >= PROGRESS_BATCH_SIZE) {
        emit();
      }
    },
    flush(): void {
      emit();
    },
  };
}

// ===========================================================================
// MacScanner —— Device_Scanner 的 macOS 实现
// ===========================================================================

/**
 * macOS（`darwin`）两段式设备扫描器。经 composition root 注册为
 * `scannerRegistry.register("darwin", new MacScanner(exclusionPolicy))`。
 */
export class MacScanner implements Device_Scanner {
  /** 平台标识，用作 ScannerRegistry 的 key。 */
  public readonly platform = "darwin";

  /** 排除红线策略（默认注入 `defaultExclusionPolicy`，便于测试时替换）。 */
  private readonly policy: ExclusionPolicy;

  constructor(policy: ExclusionPolicy = defaultExclusionPolicy) {
    this.policy = policy;
  }

  /** 当前进程是否为 macOS。 */
  public isSupported(): boolean {
    return process.platform === "darwin";
  }

  /**
   * 执行一次两段式扫描。内部完成：粗筛 → 排除 → 打分 → Top N → 组装 `Scan_Summary`。
   * 仅 `Scan_Summary` 外传（原始粗筛数据不外传，R3.5）。
   *
   * @throws ScanError 非 macOS 平台 / 扫描起点不可读等描述性错误（R1.5）。
   */
  public async scan(
    options: ScanOptions,
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<Scan_Summary> {
    if (!this.isSupported()) {
      // 非 macOS：返回描述性"暂不支持"提示（R1.5），由编排层友好呈现。
      throw new ScanError(
        `当前平台「${process.platform}」暂不支持扫描：Mac_Scanner 仅支持 macOS（darwin）。`,
      );
    }

    const nowMs = Date.now();
    const recentDays = options.recentDays > 0 ? options.recentDays : 7;
    const cutoffMs = nowMs - recentDays * 24 * 60 * 60 * 1000;
    const batcher = createProgressBatcher(onProgress);

    // ---- 阶段1 粗筛：文件元信息 + git 仓库根（采集时即推送线索、即应用排除）----
    const { files, gitRepoRoots } = await this.coarseScanFiles(
      options.homeDir,
      cutoffMs,
      batcher,
    );

    // ---- 阶段1 粗筛：git 只读活动 + 在用 App + 上下文感知（外部只读命令，可并发）----
    const [gitActivities, apps, contextSignals] = await Promise.all([
      this.collectGitActivities(gitRepoRoots, recentDays, batcher),
      this.collectRunningApps(batcher),
      collectContextSignals(),
    ]);

    // 收尾推送剩余线索（不足一批的部分）。
    batcher.flush();

    // ---- 阶段2 打分排序 + Top N 精选 → 组装 Scan_Summary ----
    const items = this.scoreAndRank(files, gitActivities, apps, nowMs, cutoffMs);
    // 追加上下文感知信号（已自带打分）
    items.push(...contextSignals);
    const topItems = selectTopN(items, options.topN > 0 ? options.topN : 15);

    return {
      scannedAt: new Date(nowMs).toISOString(),
      platform: this.platform,
      recentDays,
      items: topItems,
    };
  }

  // =========================================================================
  // 阶段1：文件元信息粗筛（仅 readdir/stat 元信息，绝不读正文，不跟随符号链接）
  // =========================================================================

  private async coarseScanFiles(
    rootDir: string,
    cutoffMs: number,
    batcher: ProgressBatcher,
  ): Promise<{ files: FileMeta[]; gitRepoRoots: string[] }> {
    const files: FileMeta[] = [];
    const gitRepoRoots: string[] = [];

    // 扫描起点不可读：抛描述性 ScanError（R1.5）。
    try {
      await fs.access(rootDir);
    } catch (cause) {
      throw new ScanError(`扫描起点不可访问：${rootDir}`, { cause });
    }

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
        return;
      }

      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // 单个目录不可读（权限等）：跳过，不影响整轮扫描。
        return;
      }

      // 该目录含 `.git` → 标记为 git 仓库根（仓库名作为线索推送）。
      if (entries.some((e) => e.name === ".git")) {
        gitRepoRoots.push(dir);
        batcher.push(`仓库 ${path.basename(dir)}`);
      }

      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          return;
        }
        // 不跟随符号链接：避免越界 / 环路 / 误读链接目标（安全边界）。
        if (entry.isSymbolicLink()) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (TRAVERSAL_SKIP_DIRS.has(entry.name)) {
            continue;
          }
          // 采集阶段即应用排除红线：命中即整棵子树不再深入（越早排除越安全，R4）。
          if (this.policy.isExcluded(fullPath, dirMetaOf(fullPath, entry.name))) {
            continue;
          }
          await walk(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        // 仅取元信息：stat 不读取文件正文（R3.1/R4.4）。
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        // 时间窗过滤：mtime < cutoff 的旧文件不纳入（R3.1）。
        const mtimeMs = stat.mtimeMs;
        if (mtimeMs < cutoffMs) {
          continue;
        }

        const meta: FileMeta = {
          name: entry.name,
          path: fullPath,
          mtime: new Date(mtimeMs).toISOString(),
          sizeBytes: stat.size,
          ext: extOf(entry.name),
        };

        // 采集阶段即应用排除红线（R4）。
        if (this.policy.isExcluded(fullPath, meta)) {
          continue;
        }

        files.push(meta);
        // 仅推送文件名作为元信息级线索（不含路径全文、不含正文）。
        batcher.push(meta.name);
      }
    };

    await walk(rootDir, 0);
    return { files, gitRepoRoots };
  }

  // =========================================================================
  // 阶段1：git 只读活动采集（git log --since / rev-parse，绝不修改仓库）
  // =========================================================================

  private async collectGitActivities(
    repoRoots: string[],
    recentDays: number,
    batcher: ProgressBatcher,
  ): Promise<GitActivity[]> {
    const activities: GitActivity[] = [];
    for (const repoPath of repoRoots) {
      const activity = await this.collectGitActivity(repoPath, recentDays);
      if (activity) {
        activities.push(activity);
        batcher.push(`git ${path.basename(repoPath)} (${activity.currentBranch})`);
      }
    }
    return activities;
  }

  private async collectGitActivity(
    repoPath: string,
    recentDays: number,
  ): Promise<GitActivity | null> {
    // 当前分支（只读）。
    let currentBranch = "";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: SUBPROCESS_MAX_BUFFER },
      );
      currentBranch = stdout.trim();
    } catch {
      // 非 git 仓库 / git 不可用：跳过该仓库（非致命）。
      return null;
    }

    // 近期提交 + 改动文件（只读 `git log --since ... --name-only`）。
    // 字段分隔用 0x1f（US），每条提交行以 0x1f 起始，便于与 --name-only 文件行区分。
    const SEP = "\u001f";
    const recentCommits: GitActivity["recentCommits"] = [];
    const changedFiles = new Set<string>();
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          repoPath,
          "log",
          `--since=${recentDays} days ago`,
          "--name-only",
          `--pretty=format:${SEP}%H${SEP}%s${SEP}%cI`,
        ],
        { timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: SUBPROCESS_MAX_BUFFER },
      );

      for (const rawLine of stdout.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith(SEP)) {
          // 提交头：SEP hash SEP subject SEP dateISO
          const [, hash = "", message = "", date = ""] = line.split(SEP);
          if (recentCommits.length < MAX_COMMITS_PER_REPO) {
            recentCommits.push({ hash, message, date });
          }
          continue;
        }
        if (line.trim().length === 0) {
          continue;
        }
        // --name-only 文件行（仓库相对路径）。应用排除红线后再纳入（仅路径，不含正文）。
        if (changedFiles.size < MAX_CHANGED_FILES_PER_REPO) {
          const absPath = path.resolve(repoPath, line);
          if (!this.policy.isExcluded(absPath, dirMetaOf(absPath, path.basename(line)))) {
            changedFiles.add(line);
          }
        }
      }
    } catch {
      // git log 失败：保留已取到的分支信息，提交 / 改动文件留空（非致命）。
    }

    return {
      repoPath,
      recentCommits,
      changedFiles: [...changedFiles],
      currentBranch,
    };
  }

  // =========================================================================
  // 阶段1：当前在用 App 采集（System Events 只读查询）
  // =========================================================================

  private async collectRunningApps(batcher: ProgressBatcher): Promise<AppActivity[]> {
    try {
      // 只读查询前台（非后台）进程名；逗号分隔返回。
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-e",
          'tell application "System Events" to get name of (every process whose background only is false)',
        ],
        { timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: SUBPROCESS_MAX_BUFFER },
      );

      const apps: AppActivity[] = stdout
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        // Improvement 1 第 2 层：过滤掉系统常驻 App（大小写不敏感），仅保留反映
        // 用户真实活动的 App 信号。
        .filter((name) => !isSystemApp(name))
        .map((appName) => ({ appName }));

      for (const app of apps) {
        batcher.push(`App ${app.appName}`);
      }
      return apps;
    } catch {
      // 无权限 / osascript 不可用：在用 App 留空（非致命）。
      return [];
    }
  }

  // =========================================================================
  // 阶段2：打分排序（新近度 + git 活跃度 + 同目录聚类度）
  // =========================================================================

  private scoreAndRank(
    files: FileMeta[],
    gitActivities: GitActivity[],
    apps: AppActivity[],
    nowMs: number,
    cutoffMs: number,
  ): ScanSummaryItem[] {
    const items: ScanSummaryItem[] = [];

    // 同目录聚类计数：同一目录下近期文件越多，单文件聚类度越高。
    const dirCounts = new Map<string, number>();
    for (const file of files) {
      const dir = path.dirname(file.path);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    const windowMs = Math.max(1, nowMs - cutoffMs);
    for (const file of files) {
      const mtimeMs = Date.parse(file.mtime);
      const recency01 = clamp01((mtimeMs - cutoffMs) / windowMs);
      const clusterCount = dirCounts.get(path.dirname(file.path)) ?? 1;
      const clusterFactor = Math.min(clusterCount, CLUSTER_CAP) / CLUSTER_CAP;
      const score = scoreFile(file, recency01, clusterFactor);
      items.push({ kind: "file", score, file });
    }

    for (const git of gitActivities) {
      const score =
        GIT_BASE_SCORE +
        GIT_COMMIT_WEIGHT * Math.min(git.recentCommits.length, GIT_COMMIT_CAP);
      items.push({ kind: "git", score, git });
    }

    for (const app of apps) {
      items.push({ kind: "app", score: APP_BASE_SCORE, app });
    }

    return items;
  }
}

// ===========================================================================
// 内部纯工具函数
// ===========================================================================

/** 提取**小写、不含前导点**的扩展名（与 ExclusionPolicy 的约定一致）。 */
function extOf(name: string): string {
  return path.extname(name).replace(/^\.+/, "").toLowerCase();
}

/**
 * 为目录 / git 路径构造一个最小 `FileMeta`（仅供 `isExcluded` 的路径 / 扩展名判定）。
 * 目录无意义的大小 / mtime 一律置零，扫描判定只依赖路径与扩展名。
 */
function dirMetaOf(fullPath: string, name: string): FileMeta {
  return { name, path: fullPath, mtime: "", sizeBytes: 0, ext: extOf(name) };
}

/** 把数值钳制到 [0, 1]（NaN 归零）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
