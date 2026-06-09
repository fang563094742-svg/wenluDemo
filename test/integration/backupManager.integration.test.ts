/**
 * 任务 10.4：Backup_Manager 备份 / 回滚集成测试（vitest，外部依赖 → 集成测试）。
 *
 * 被测：`src/backup/backupManager.ts` 的 `createBackup`——
 *  - **git 工作树** → `git add -A` + `git commit`，以提交 hash 作为 `gitRef` 恢复点；
 *  - **非 git 目录** → 复制到 `<root>/.pad-backups/<ts>/` 文件快照，排除忽略项与备份目录自身。
 *
 * 这两条路径都依赖真实外部环境（真实 git 仓库 / 真实文件系统遍历复制），无法用纯函数 /
 * mock 充分覆盖，故以集成测试验证（R11.1 / R11.2）：
 *
 *  1. **git 场景**：在 `os.tmpdir()` 下 `git init` + commit，再改动文件后 `createBackup`
 *     （git-commit 策略），断言：
 *       - 产生有效恢复点（`gitRef` 指向一个真实可解析的 commit 对象）；
 *       - `rollbackInstruction` 可据以用 `git reset --hard <gitRef>` 回滚；
 *       - 回滚后工作树恢复到「执行前（备份时）」状态，且相对备份提交 `git diff` 为空（diff 一致）。
 *  2. **非 git 场景**：在 `os.tmpdir()` 下普通目录 `createBackup`（file-snapshot 策略），
 *     断言 `.pad-backups/<ts>/` 快照内容与原目录一致（排除 `node_modules`/`.git`/`.pad-backups`）。
 *
 * 条件跳过：git 场景需本机可用 git，无 git 环境用 `describe.skipIf` 跳过；git 跨平台，故
 * 非 macOS 不影响（不限制平台）。非 git 快照场景不依赖 git，任何平台均运行。
 *
 * 安全边界（与硬约束一致）：所有 git 仓库 / 目录一律建于 `os.tmpdir()` 下临时目录，
 * 测试结束 `afterAll` 递归清理，**绝不触碰项目外的用户真实路径**。
 *
 * _Requirements: 11.1, 11.2_
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";

import { createBackup } from "../../src/backup/backupManager.js";
import type { BackupHandle } from "../../src/backup/backupManager.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 运行条件：本机是否可用 git（仅 git 场景需要；非 git 快照场景任何环境都跑）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 通用 fixture 辅助
// ---------------------------------------------------------------------------

/** 在指定仓库目录内运行一条 git 命令并返回 stdout。 */
async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** 在临时根目录下写入文件（自动创建父目录）。 */
async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

/**
 * 递归读取 `base` 下所有文件为「相对路径 → 内容」映射，跳过名称命中 `excludeDirs` 的目录。
 * 用于快照内容比对与回滚后状态比对。
 */
async function readTreeFiles(
  base: string,
  excludeDirs: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (excludeDirs.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (ent.isFile()) {
        const rel = path.relative(base, full);
        out.set(rel, await fs.readFile(full, "utf8"));
      }
    }
  }

  await walk(base);
  return out;
}

// ===========================================================================
// 场景 1：git 仓库的备份 / 回滚 / diff（R11.1 / R11.2 / R11.3）
// ===========================================================================

describe.skipIf(!HAS_GIT)("Backup_Manager 集成：git 仓库备份与回滚（R11.1/R11.2）", () => {
  let tmpRoot = "";
  let repoDir = "";
  let handle: BackupHandle;
  /** 备份时刻（执行前）的工作树文件快照，用于回滚后比对。 */
  let preExecutionTree: Map<string, string>;

  const EXCLUDE = new Set([".git"]);

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wenlu-backup-git-"));
    repoDir = path.join(tmpRoot, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    // 初始化仓库并配置本地身份（避免依赖全局 git 配置）。
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "wenlu-test@example.com"]);
    await git(repoDir, ["config", "user.name", "Wenlu Integration Test"]);
    await git(repoDir, ["config", "commit.gpgsign", "false"]);
    await git(repoDir, ["branch", "-M", "main"]);

    // 初始提交：app.txt = "original"。
    await writeFile(repoDir, "app.txt", "original\n");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "init"]);

    // 「执行前」用户工作状态：修改 app.txt + 新增 notes.md（此即备份要保留的状态）。
    await writeFile(repoDir, "app.txt", "user working changes\n");
    await writeFile(repoDir, "notes.md", "user notes\n");

    // 创建备份（git-commit 策略会把当前工作树全部提交为恢复点）。
    handle = await createBackup({ rootAbsPath: repoDir });

    // 记录备份时刻的工作树（createBackup 提交后工作内容不变，等价于执行前状态）。
    preExecutionTree = await readTreeFiles(repoDir, EXCLUDE);
  }, 60000);

  afterAll(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("采用 git-commit 策略并产出指向有效提交的 gitRef（恢复点）", async () => {
    expect(handle.strategy).toBe("git-commit");
    expect(handle.workingDirRoot).toBe(repoDir);
    expect(typeof handle.gitRef).toBe("string");
    expect(handle.gitRef!.length).toBeGreaterThan(0);

    // gitRef 必须能被 git 解析为一个真实存在的 commit 对象。
    const type = (await git(repoDir, ["cat-file", "-t", handle.gitRef!])).trim();
    expect(type).toBe("commit");

    // rev-parse --verify <ref>^{commit} 成功即证明它是合法提交引用。
    const resolved = (
      await git(repoDir, ["rev-parse", "--verify", `${handle.gitRef}^{commit}`])
    ).trim();
    expect(resolved).toBe(handle.gitRef);
  });

  it("rollbackInstruction 含可执行的 git reset --hard <gitRef> 回滚指引", () => {
    expect(handle.rollbackInstruction).toContain("git reset --hard");
    expect(handle.rollbackInstruction).toContain(handle.gitRef!);
    expect(handle.rollbackInstruction).toContain(repoDir);
  });

  it("据 rollbackInstruction 用 git reset --hard 回滚后恢复到执行前状态、diff 一致", async () => {
    // 1) 模拟 Executor 执行期对工作目录的改动：改写、删除、新增（含未跟踪文件）。
    await writeFile(repoDir, "app.txt", "EXECUTOR BROKE IT\n");
    await fs.rm(path.join(repoDir, "notes.md"));
    await writeFile(repoDir, "garbage.tmp", "executor scratch\n");

    // 确认确实偏离了备份状态。
    const dirtyTree = await readTreeFiles(repoDir, EXCLUDE);
    expect(dirtyTree).not.toEqual(preExecutionTree);

    // 2) 按 rollbackInstruction 回滚：reset --hard 恢复跟踪文件，clean -fd 清未跟踪文件。
    await git(repoDir, ["reset", "--hard", handle.gitRef!]);
    await git(repoDir, ["clean", "-fd"]);

    // 3) diff 一致：相对备份提交无任何差异，工作树干净。
    const diff = (await git(repoDir, ["diff", handle.gitRef!])).trim();
    expect(diff).toBe("");
    const status = (await git(repoDir, ["status", "--porcelain"])).trim();
    expect(status).toBe("");

    // 4) 文件内容逐一恢复到执行前（备份时）状态。
    const restoredTree = await readTreeFiles(repoDir, EXCLUDE);
    expect(restoredTree).toEqual(preExecutionTree);
    expect(restoredTree.get("app.txt")).toBe("user working changes\n");
    expect(restoredTree.get("notes.md")).toBe("user notes\n");
    expect(restoredTree.has("garbage.tmp")).toBe(false);
  }, 30000);
});

// ===========================================================================
// 场景 2：非 git 目录的文件快照（R11.1）—— 任何平台均运行（不依赖 git）
// ===========================================================================

describe("Backup_Manager 集成：非 git 目录文件快照（R11.1）", () => {
  let tmpRoot = "";
  let workDir = "";
  let handle: BackupHandle;

  /** 期望被快照保留的「真实内容」文件（排除忽略项）。 */
  const SOURCE_FILES: Record<string, string> = {
    "README.md": "# demo project\n",
    "src/index.ts": "export const x = 1;\n",
    "src/util/helper.ts": "export const help = () => 42;\n",
    "data/config.json": '{"k":"v"}\n',
  };

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wenlu-backup-snap-"));
    workDir = path.join(tmpRoot, "project");
    await fs.mkdir(workDir, { recursive: true });

    // 1) 写入真实源文件（应被快照完整保留）。
    for (const [rel, content] of Object.entries(SOURCE_FILES)) {
      await writeFile(workDir, rel, content);
    }

    // 2) 写入忽略项内容：node_modules / .git / 既有 .pad-backups（均不应进入快照）。
    await writeFile(workDir, "node_modules/dep/index.js", "module.exports = {};\n");
    await writeFile(workDir, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(workDir, ".pad-backups/old-snapshot/stale.txt", "stale\n");

    // 3) 非 git 目录 → 走 file-snapshot 策略。
    handle = await createBackup({ rootAbsPath: workDir });
  }, 60000);

  afterAll(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("采用 file-snapshot 策略，snapshotPath 落在 .pad-backups/<ts>/ 且回滚指引非空", () => {
    expect(handle.strategy).toBe("file-snapshot");
    expect(handle.workingDirRoot).toBe(workDir);
    expect(typeof handle.snapshotPath).toBe("string");
    expect(handle.snapshotPath!.startsWith(path.join(workDir, ".pad-backups"))).toBe(true);
    expect(handle.gitRef).toBeUndefined();
    expect(handle.rollbackInstruction.length).toBeGreaterThan(0);
    expect(handle.rollbackInstruction).toContain(handle.snapshotPath!);
  });

  it("快照内容与原目录一致（排除 node_modules/.git/.pad-backups 忽略项）", async () => {
    const excludeDirs = new Set([".pad-backups", "node_modules", ".git"]);

    // 原目录中应被保留的真实文件集合（排除忽略项）。
    const expectedTree = await readTreeFiles(workDir, excludeDirs);

    // 快照目录内容（快照内部不应再含被忽略目录，无需额外排除，但保险起见同样排除）。
    const snapshotTree = await readTreeFiles(handle.snapshotPath!, excludeDirs);

    // 1) 文件集合与逐一内容完全一致。
    expect(snapshotTree).toEqual(expectedTree);

    // 2) 真实源文件逐项命中且内容正确。
    for (const [rel, content] of Object.entries(SOURCE_FILES)) {
      const key = rel.split("/").join(path.sep);
      expect(snapshotTree.get(key)).toBe(content);
    }

    // 3) 忽略项确实未被纳入快照（防体积爆炸 / 无限递归）。
    for (const key of snapshotTree.keys()) {
      const segments = key.split(path.sep);
      expect(segments).not.toContain("node_modules");
      expect(segments).not.toContain(".git");
      expect(segments).not.toContain(".pad-backups");
    }
  });
});
