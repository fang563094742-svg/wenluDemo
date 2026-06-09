/**
 * 任务 4.8：git 活动与在用 App 采集集成测试（vitest，外部依赖 → 集成测试）。
 *
 * 被测：`src/scanner/macScanner.ts` 的阶段1 粗筛中两类**外部只读采集**：
 *  - git 只读活动采集（`git -C <repo> rev-parse` / `git -C <repo> log --since --name-only`）；
 *  - 当前在用 App 采集（`osascript` 查 System Events 进程名）。
 *
 * 这两项依赖真实外部环境（真实 git 仓库 / 系统权限），无法用纯函数 / mock 充分覆盖，
 * 故以集成测试验证：
 *  1. 在 `os.tmpdir()` 下 `git init` 一个**临时仓库**并做多次 commit，验证 MacScanner
 *     能采集到该仓库的 git 活动（`recentCommits` / `changedFiles` / `currentBranch`）。
 *  2. 在用 App 列表采集：macOS 上 `osascript` 可能因权限被拒 → MacScanner 须**容忍空列表、
 *     不抛错**（断言 `scan()` 正常 resolve、App 条目结构合法即可，不强求非空）。
 *  3. 非 macOS 平台（或无 git 的环境）→ 条件跳过（`describe.skipIf`）。
 *
 * 安全边界（与硬约束一致）：临时 git 仓库一律建于 `os.tmpdir()` 下，测试结束 `afterAll`
 * 递归清理，**绝不触碰项目外的用户真实路径**。
 *
 * _Requirements: 3.2, 3.3_
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";

import { MacScanner } from "../../src/scanner/macScanner.js";
import type { Scan_Summary, ScanOptions } from "../../src/scanner/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 运行条件判定：仅 macOS 且本机可用 git 时运行；否则整组跳过（条件跳过，R3.2/R3.3）
// ---------------------------------------------------------------------------

const IS_MAC = process.platform === "darwin";

/** 同步探测本机是否可用 git（模块加载期判定，供 describe.skipIf 使用）。 */
function detectGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = detectGit();
const CAN_RUN = IS_MAC && HAS_GIT;

// ---------------------------------------------------------------------------
// 测试夹具：os.tmpdir() 下的临时 git 仓库
// ---------------------------------------------------------------------------

/** 在指定仓库目录内运行一条 git 命令并返回 stdout。 */
async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

describe.skipIf(!CAN_RUN)("MacScanner 集成：git 活动与在用 App 采集（R3.2/R3.3）", () => {
  let tmpRoot = "";
  let repoDir = "";
  let summary: Scan_Summary;

  const COMMIT_MESSAGES = [
    "feat: 初始化主动察觉 demo 项目",
    "feat: 新增扫描器模块",
    "fix: 修正时间窗过滤边界",
  ];

  beforeAll(async () => {
    // 1) 在 os.tmpdir() 下创建唯一临时根目录（绝不触碰项目外用户路径）。
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wenlu-scanner-it-"));
    repoDir = path.join(tmpRoot, "demo-repo");
    await fs.mkdir(repoDir, { recursive: true });

    // 2) 初始化临时仓库并配置本地身份（避免依赖全局 git 配置）。
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "wenlu-test@example.com"]);
    await git(repoDir, ["config", "user.name", "Wenlu Integration Test"]);
    await git(repoDir, ["config", "commit.gpgsign", "false"]);

    // 3) 第一次提交：新增 file1.txt。
    await fs.writeFile(path.join(repoDir, "file1.txt"), "hello wenlu\n", "utf8");
    await git(repoDir, ["add", "file1.txt"]);
    await git(repoDir, ["commit", "-m", COMMIT_MESSAGES[0]!]);

    // 首个提交落定后把分支统一改名为 main，使 currentBranch 断言可确定。
    await git(repoDir, ["branch", "-M", "main"]);

    // 4) 第二次提交：新增 file2.txt。
    await fs.writeFile(path.join(repoDir, "file2.txt"), "second file\n", "utf8");
    await git(repoDir, ["add", "file2.txt"]);
    await git(repoDir, ["commit", "-m", COMMIT_MESSAGES[1]!]);

    // 5) 第三次提交：修改 file1.txt。
    await fs.writeFile(path.join(repoDir, "file1.txt"), "hello wenlu\nupdated\n", "utf8");
    await git(repoDir, ["add", "file1.txt"]);
    await git(repoDir, ["commit", "-m", COMMIT_MESSAGES[2]!]);

    // 6) 以临时仓库为扫描起点跑一次真实扫描（topN 放大，确保 git/app 条目不被裁掉）。
    const options: ScanOptions = { recentDays: 7, topN: 50, homeDir: repoDir };
    const scanner = new MacScanner();
    summary = await scanner.scan(options);
  }, 60000);

  afterAll(async () => {
    // 递归清理临时仓库（仅清理 os.tmpdir() 下自建目录）。
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // git 只读活动采集（R3.2）
  // =========================================================================

  it("采集到临时仓库的 git 活动：recentCommits / changedFiles / currentBranch", () => {
    const gitItems = summary.items.filter((it) => it.kind === "git" && it.git);
    expect(gitItems.length).toBeGreaterThanOrEqual(1);

    // 定位本次创建的临时仓库对应的 git 活动条目。
    const activity = gitItems
      .map((it) => it.git!)
      .find((g) => path.resolve(g.repoPath) === path.resolve(repoDir));
    expect(activity).toBeDefined();

    // currentBranch：已统一改名为 main。
    expect(activity!.currentBranch).toBe("main");

    // recentCommits：三次提交均落在 7 天窗口内，应被采集到。
    expect(activity!.recentCommits.length).toBeGreaterThanOrEqual(3);
    const collectedMessages = activity!.recentCommits.map((c) => c.message);
    for (const msg of COMMIT_MESSAGES) {
      expect(collectedMessages).toContain(msg);
    }
    // 每条提交都带 hash 与 ISO 日期（只读元信息，无 diff 正文）。
    for (const commit of activity!.recentCommits) {
      expect(commit.hash.length).toBeGreaterThan(0);
      expect(commit.date.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(commit.date))).toBe(false);
    }

    // changedFiles：近 7 天涉及的文件（仅仓库相对路径），应包含两个被改动文件。
    expect(activity!.changedFiles).toContain("file1.txt");
    expect(activity!.changedFiles).toContain("file2.txt");
  });

  // =========================================================================
  // 在用 App 采集（R3.3）：容忍空列表，关键是不抛错且结构合法
  // =========================================================================

  it("在用 App 采集容错：scan 正常完成且 App 条目结构合法（允许空列表）", () => {
    // beforeAll 中 scan 已成功 resolve（osascript 因权限失败时退化为空列表，不抛错）。
    expect(Array.isArray(summary.items)).toBe(true);

    const appItems = summary.items.filter((it) => it.kind === "app");
    // 不强求非空（CI / 无权限环境可能为空），但凡采集到的 App 条目必须结构合法。
    for (const item of appItems) {
      expect(item.app).toBeDefined();
      expect(typeof item.app!.appName).toBe("string");
      expect(item.app!.appName.length).toBeGreaterThan(0);
    }
  });

  it("再次扫描临时仓库不抛错（App 采集失败应被容忍而非中断扫描）", async () => {
    const scanner = new MacScanner();
    const options: ScanOptions = { recentDays: 7, topN: 50, homeDir: repoDir };
    await expect(scanner.scan(options)).resolves.toBeDefined();
  }, 30000);
});
