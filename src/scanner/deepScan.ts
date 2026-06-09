/**
 * DeepScan —— 增强型扫描层（River 架构）。
 *
 * 在 MacScanner 的元信息采集基础上叠加：
 *  1. git 增强：git diff HEAD（未提交改动）、git stash list、紧凑 log
 *  2. 高价值文件正文摘要：白名单文件前 50 行（README/TODO/CHANGELOG/近期修改代码）
 *  3. 跨次对比 delta：与上次扫描快照比对，识别"新增""停滞""消失"
 *
 * 安全边界：
 *  - 正文读取经 exclusionPolicy 过滤、白名单扩展名限制、前 50 行截断
 *  - 不读 .env / credentials / key 等敏感文件
 *  - git diff 输出截断 2000 字符
 *  - 所有数据仍为只读采集，不修改任何用户文件
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MacScanner } from "./macScanner.js";
import type { Scan_Summary, ScanOptions, GitActivity } from "./types.js";

const execFileAsync = promisify(execFile);

// ===========================================================================
// 类型
// ===========================================================================

/** git 增强信息（超出基础 GitActivity 的部分）。 */
export interface GitEnhanced {
  repoPath: string;
  /** git diff HEAD（未提交改动摘要，截断 2000 字符）。 */
  uncommittedDiff: string;
  /** git diff --name-only HEAD（改动文件列表，更紧凑）。 */
  uncommittedFiles: string[];
  /** git status --short（工作区状态：未暂存/未跟踪/冲突等）。 */
  statusShort: string;
  /** git stash 列表。 */
  stashList: string[];
  /** 紧凑的近期提交图（git log --oneline -20）。 */
  recentLog: string;
  /** 当前分支。 */
  branch: string;
  /** 领先远程的提交数（未 push，0=已同步，-1=无远程或检测失败）。 */
  aheadCount: number;
}

/** 高价值文件正文摘要。 */
export interface ContentPeek {
  /** 文件绝对路径。 */
  path: string;
  /** 前 50 行内容。 */
  snippet: string;
  /** 为什么被选中（"readme"/"todo"/"recent-code"/"package-json"）。 */
  reason: string;
}

/** 跨次对比信号。 */
export interface ScanDelta {
  /** 上次没有、这次新出现的文件/项目。 */
  newSinceLastScan: string[];
  /** 上次有、这次消失的。 */
  goneSinceLastScan: string[];
  /** 存在但超过 3 天没动的活跃目录内文件。 */
  stalled: string[];
  /** 项目级变化：新出现的 git 仓库。 */
  newProjects: string[];
  /** 项目级变化：分支发生变化的仓库。 */
  branchChanged: { path: string; from: string; to: string }[];
  /** 有新提交的项目（上次快照后有新 commit）。 */
  projectsWithNewCommits: string[];
}

/** 上次扫描快照（持久化到 MemoryStore）。 */
export interface ScanSnapshot {
  date: string;
  topProjects: { path: string; branch: string; lastCommitHash: string }[];
  recentFiles: { path: string; mtime: string }[];
}

/** DeepScan 完整结果。 */
export interface DeepScanResult {
  /** 基础扫描摘要（MacScanner 产出）。 */
  baseSummary: Scan_Summary;
  /** git 增强信息。 */
  gitEnhanced: GitEnhanced[];
  /** 高价值文件正文摘要。 */
  contentPeeks: ContentPeek[];
  /** 跨次对比信号（有上次快照时才有值）。 */
  delta: ScanDelta | null;
  /** 本次快照（供 MemoryStore 持久化）。 */
  snapshot: ScanSnapshot;
}

// ===========================================================================
// 常量
// ===========================================================================

/** 外部命令超时（ms）。 */
const CMD_TIMEOUT = 5000;
const CMD_MAX_BUFFER = 5 * 1024 * 1024;

/** git diff 输出截断长度。 */
const DIFF_MAX_CHARS = 2000;

/** 正文摘要行数上限。 */
const SNIPPET_MAX_LINES = 50;

/** 允许读取正文的文件名模式（不区分大小写）。 */
const PEEK_FILENAMES: RegExp[] = [
  /^readme/i,
  /^todo/i,
  /^changelog/i,
  /^package\.json$/i,
  /^tsconfig\.json$/i,
  /^\.env\.example$/i,
];

/** 允许读取正文的扩展名（仅近期修改文件）。 */
const PEEK_CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "py", "md", "txt", "json", "yaml", "yml",
  "toml", "rs", "go", "java", "rb", "sh", "swift", "kt",
]);

/** 正文读取排除的文件名模式（敏感文件）。 */
const PEEK_EXCLUDE_NAMES: RegExp[] = [
  /^\.env$/i,
  /credential/i,
  /secret/i,
  /\.key$/i,
  /\.pem$/i,
  /password/i,
  /token/i,
];

/** "近期修改"的阈值：24 小时内。 */
const RECENT_CODE_HOURS = 24;

/** stalled 判定阈值：3 天。 */
const STALLED_DAYS = 3;

/** 正文读取文件大小上限（跳过大于 100KB 的文件，避免读取 minified/bundle 文件）。 */
const SNIPPET_MAX_FILE_SIZE = 100 * 1024;

/** 二进制文件检测：若前 512 字节含 NUL 则视为二进制，跳过。 */
const BINARY_CHECK_BYTES = 512;

// ===========================================================================
// DeepScanner
// ===========================================================================

export interface DeepScanOptions extends ScanOptions {
  /** 上次扫描快照（有则产出 delta）。 */
  lastSnapshot?: ScanSnapshot;
}

/**
 * 执行增强型扫描：基础 MacScanner + git增强 + 正文摘要 + 跨次对比。
 */
export async function deepScan(options: DeepScanOptions): Promise<DeepScanResult> {
  const scanner = new MacScanner();

  // 1. 基础扫描
  const baseSummary = await scanner.scan(options);

  // 2. 提取 git 仓库路径
  const gitRepos = baseSummary.items
    .filter((item) => item.kind === "git" && item.git)
    .map((item) => item.git!);

  // 3. git 增强（并行）
  const gitEnhanced = await collectGitEnhanced(gitRepos);

  // 4. 高价值文件正文摘要
  const contentPeeks = await collectContentPeeks(baseSummary, options.homeDir);

  // 5. 构建本次快照
  const snapshot = buildSnapshot(baseSummary, gitRepos);

  // 6. 跨次对比
  const delta = options.lastSnapshot
    ? computeDelta(baseSummary, options.lastSnapshot)
    : null;

  return { baseSummary, gitEnhanced, contentPeeks, delta, snapshot };
}

// ===========================================================================
// git 增强采集
// ===========================================================================

async function collectGitEnhanced(
  repos: GitActivity[],
): Promise<GitEnhanced[]> {
  const results: GitEnhanced[] = [];

  for (const repo of repos) {
    const enhanced = await collectOneGitEnhanced(repo.repoPath, repo.currentBranch);
    if (enhanced) results.push(enhanced);
  }

  return results;
}

async function collectOneGitEnhanced(
  repoPath: string,
  branch: string,
): Promise<GitEnhanced | null> {
  let uncommittedDiff = "";
  let uncommittedFiles: string[] = [];
  let statusShort = "";
  let stashList: string[] = [];
  let recentLog = "";
  let aheadCount = -1;

  // git diff HEAD --stat（未提交改动统计）
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "diff", "HEAD", "--stat"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    uncommittedDiff = stdout.slice(0, DIFF_MAX_CHARS);
  } catch {
    // 可能是空仓库（没有 HEAD）或非 git 目录，尝试 --cached
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "diff", "--cached", "--stat"],
        { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
      );
      uncommittedDiff = stdout.slice(0, DIFF_MAX_CHARS);
    } catch {
      // 非致命
    }
  }

  // git diff --name-only HEAD（改动文件列表）
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "diff", "--name-only", "HEAD"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    uncommittedFiles = stdout.trim().split("\n").filter((l) => l.length > 0).slice(0, 30);
  } catch {
    // 非致命
  }

  // git status --short（工作区全貌：未暂存/未跟踪/冲突）
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "status", "--short"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    statusShort = stdout.slice(0, 1500);
  } catch {
    // 非致命
  }

  // git stash list
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "stash", "list"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    stashList = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(0, 10);
  } catch {
    // 非致命
  }

  // git log --oneline -20
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "log", "--oneline", "-20"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    recentLog = stdout.trim();
  } catch {
    // 非致命（可能是空仓库）
  }

  // git rev-list --count @{upstream}..HEAD（领先远程的提交数）
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-list", "--count", "@{upstream}..HEAD"],
      { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER },
    );
    const n = parseInt(stdout.trim(), 10);
    aheadCount = Number.isFinite(n) ? n : -1;
  } catch {
    // 无远程跟踪分支或检测失败
    aheadCount = -1;
  }

  return { repoPath, uncommittedDiff, uncommittedFiles, statusShort, stashList, recentLog, branch, aheadCount };
}

// ===========================================================================
// 高价值文件正文摘要
// ===========================================================================

async function collectContentPeeks(
  summary: Scan_Summary,
  _homeDir: string,
): Promise<ContentPeek[]> {
  const peeks: ContentPeek[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  const recentThreshold = now - RECENT_CODE_HOURS * 60 * 60 * 1000;

  // 策略1：从 baseSummary 的文件条目中找白名单文件
  for (const item of summary.items) {
    if (item.kind === "file" && item.file) {
      const file = item.file;
      if (PEEK_EXCLUDE_NAMES.some((re) => re.test(file.name))) continue;
      if (seen.has(file.path)) continue;

      let reason: string | null = null;
      if (PEEK_FILENAMES.some((re) => re.test(file.name))) {
        reason = file.name.toLowerCase().startsWith("readme") ? "readme"
          : file.name.toLowerCase().startsWith("todo") ? "todo"
          : file.name.toLowerCase().startsWith("changelog") ? "changelog"
          : "config";
      } else if (PEEK_CODE_EXTS.has(file.ext) && Date.parse(file.mtime) >= recentThreshold) {
        reason = "recent-code";
      }
      if (!reason) continue;
      seen.add(file.path);
      const snippet = await readSnippet(file.path);
      if (snippet) peeks.push({ path: file.path, snippet, reason });
      if (peeks.length >= 15) return peeks;
    }
  }

  // 策略2：从 git 仓库根目录主动寻找 README/package.json 等高价值文件
  for (const item of summary.items) {
    if (item.kind === "git" && item.git) {
      const repoPath = item.git.repoPath;
      const candidates = ["README.md", "README", "TODO.md", "TODO", "package.json"];
      for (const name of candidates) {
        const filePath = repoPath + "/" + name;
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        const snippet = await readSnippet(filePath);
        if (snippet) {
          const reason = name.toLowerCase().startsWith("readme") ? "readme"
            : name.toLowerCase().startsWith("todo") ? "todo"
            : "config";
          peeks.push({ path: filePath, snippet, reason });
          if (peeks.length >= 15) return peeks;
        }
      }
    }
  }

  return peeks;
}

/** 读取文件前 N 行，带大文件保护和二进制检测。失败返回 null。 */
async function readSnippet(filePath: string): Promise<string | null> {
  try {
    // 大文件保护：跳过超大文件（minified/bundle）
    const stats = await fs.stat(filePath);
    if (stats.size > SNIPPET_MAX_FILE_SIZE) return null;
    if (stats.size === 0) return null;

    const content = await fs.readFile(filePath, "utf-8");

    // 二进制检测：前 512 字节含 NUL 则视为二进制
    const checkSlice = content.slice(0, BINARY_CHECK_BYTES);
    if (checkSlice.includes("\0")) return null;

    const lines = content.split("\n").slice(0, SNIPPET_MAX_LINES);
    const result = lines.join("\n").trim();
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// 跨次对比
// ===========================================================================

function buildSnapshot(
  summary: Scan_Summary,
  repos: GitActivity[],
): ScanSnapshot {
  return {
    date: summary.scannedAt,
    topProjects: repos.map((r) => ({
      path: r.repoPath,
      branch: r.currentBranch,
      lastCommitHash: r.recentCommits[0]?.hash ?? "",
    })),
    recentFiles: summary.items
      .filter((i) => i.kind === "file" && i.file)
      .map((i) => ({ path: i.file!.path, mtime: i.file!.mtime })),
  };
}

function computeDelta(
  current: Scan_Summary,
  last: ScanSnapshot,
): ScanDelta {
  const currentPaths = new Set(
    current.items
      .filter((i) => i.kind === "file" && i.file)
      .map((i) => i.file!.path),
  );
  const lastPaths = new Set(last.recentFiles.map((f) => f.path));

  const newSinceLastScan = [...currentPaths].filter((p) => !lastPaths.has(p));
  const goneSinceLastScan = [...lastPaths].filter((p) => !currentPaths.has(p));

  // stalled: 在上次快照中存在、mtime 距今超 3 天、但仍在活跃项目目录中
  const now = Date.now();
  const stalledThreshold = now - STALLED_DAYS * 24 * 60 * 60 * 1000;
  const activeProjectDirs = new Set(last.topProjects.map((p) => p.path));

  const stalled = last.recentFiles
    .filter((f) => {
      const mtime = Date.parse(f.mtime);
      if (mtime >= stalledThreshold) return false;
      return [...activeProjectDirs].some((dir) => f.path.startsWith(dir));
    })
    .map((f) => f.path)
    .slice(0, 20);

  // 项目级对比
  const currentProjects = current.items
    .filter((i) => i.kind === "git" && i.git)
    .map((i) => i.git!);
  const lastProjectMap = new Map(last.topProjects.map((p) => [p.path, p]));
  const currentProjectPaths = new Set(currentProjects.map((p) => p.repoPath));

  // 新项目
  const newProjects = [...currentProjectPaths].filter((p) => !lastProjectMap.has(p));

  // 分支变化
  const branchChanged: { path: string; from: string; to: string }[] = [];
  for (const proj of currentProjects) {
    const lastProj = lastProjectMap.get(proj.repoPath);
    if (lastProj && lastProj.branch !== proj.currentBranch) {
      branchChanged.push({
        path: proj.repoPath,
        from: lastProj.branch,
        to: proj.currentBranch,
      });
    }
  }

  // 有新提交的项目（当前 HEAD hash ≠ 上次快照的 lastCommitHash）
  const projectsWithNewCommits: string[] = [];
  for (const proj of currentProjects) {
    const lastProj = lastProjectMap.get(proj.repoPath);
    if (!lastProj) continue;
    const currentHead = proj.recentCommits[0]?.hash ?? "";
    if (currentHead && currentHead !== lastProj.lastCommitHash) {
      projectsWithNewCommits.push(proj.repoPath);
    }
  }

  return {
    newSinceLastScan,
    goneSinceLastScan,
    stalled,
    newProjects,
    branchChanged,
    projectsWithNewCommits,
  };
}
