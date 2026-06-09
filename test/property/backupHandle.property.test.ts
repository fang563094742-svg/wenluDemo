// Feature: proactive-awareness-demo, Property 14: 备份句柄保留可恢复信息。*For any* 成功创建的备份，返回的 BackupHandle 含非空的恢复引用（git 策略下为 gitRef，文件快照策略下为 snapshotPath）以及非空的 rollbackInstruction，足以将 Working_Directory 恢复到执行前状态。
//
// **Validates: Requirements 11.3**
//
// 被测：`src/backup/backupManager.ts` 的 `createBackup` —— 它据目录是否为 git 工作树选择
// 策略（git 工作树走 `git-commit`/`git-stash`；非 git 走 `file-snapshot`），并产出携带足够
// 回滚信息的 `BackupHandle`。本属性用 fast-check 在 `os.tmpdir()` 下随机生成目录结构/文件，
// 同时覆盖「git 仓库」与「非 git」两类工作目录，断言：
//   1) rollbackInstruction 恒为非空字符串（且包含工作目录根，足以定位恢复目标）；
//   2) 按策略含非空恢复引用：file-snapshot ⇒ 非空 snapshotPath；git-* ⇒ 非空 gitRef；
//   3) workingDirRoot / createdAt 完整且 createdAt 可解析为时间。
// 每次运行的临时目录均建于 `os.tmpdir()` 下，运行后立即递归清理（finally + afterAll 兜底），
// 绝不触碰项目外的用户真实路径。

import { describe, it, expect, afterAll } from "vitest";
import fc from "fast-check";
import { promises as fs } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";

import { createBackup } from "../../src/backup/backupManager.js";
import type { BackupHandle } from "../../src/backup/backupManager.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 运行环境探测：本机是否可用 git（决定能否覆盖 git 策略分支）
// ---------------------------------------------------------------------------

/** 同步探测本机是否可用 git（模块加载期判定，供生成器约束使用）。 */
function detectGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = detectGit();

/** 在指定仓库目录内运行一条 git 命令（仅用于夹具搭建：init/config）。 */
async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// 生成器：随机工作目录规格（文件结构 + 是否 git 仓库）
// ---------------------------------------------------------------------------

// 仅由小写字母/数字构成的安全名（不含路径分隔符与点号，天然不会撞上 .git/.pad-backups
// /node_modules 等忽略目录名）。
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const safeNameArb = fc.stringOf(fc.constantFrom(...SAFE_CHARS), {
  minLength: 1,
  maxLength: 6,
});

/** 单个待写入文件：最多两层子目录嵌套 + 文件名 + 任意内容。 */
const fileEntryArb = fc.record({
  dirs: fc.array(safeNameArb, { maxLength: 2 }),
  name: safeNameArb,
  content: fc.string({ maxLength: 64 }),
});

/** 工作目录规格：随机文件集合 + 是否构造为 git 仓库（无 git 环境则恒为非 git）。 */
const workingDirSpecArb = fc.record({
  useGit: HAS_GIT ? fc.boolean() : fc.constant(false),
  files: fc.array(fileEntryArb, { maxLength: 4 }),
});

type WorkingDirSpec = {
  useGit: boolean;
  files: { dirs: string[]; name: string; content: string }[];
};

// 已创建的临时根目录登记表（afterAll 兜底清理，防止 shrink 过程中遗漏）。
const createdRoots: string[] = [];

/**
 * 据规格在 `os.tmpdir()` 下物化一个工作目录：写入随机文件；若为 git 仓库则 `git init`
 * 并配置本地身份。git 提交策略需至少一个可提交文件以保证首个备份提交成功，故在 git 且
 * 未写入任何文件时补一个种子文件。
 */
async function materializeWorkingDir(spec: WorkingDirSpec): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wenlu-backup-pbt-"));
  createdRoots.push(root);

  let wroteAny = false;
  for (const entry of spec.files) {
    const dir = path.join(root, ...entry.dirs);
    const target = path.join(dir, entry.name);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, entry.content, "utf8");
      wroteAny = true;
    } catch {
      // 同名路径既作目录又作文件等冲突 → 跳过；本属性不依赖具体文件集合。
    }
  }

  if (spec.useGit && !wroteAny) {
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n", "utf8");
  }

  if (spec.useGit) {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "wenlu-test@example.com"]);
    await git(root, ["config", "user.name", "Wenlu Backup PBT"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe("Property 14: 备份句柄保留可恢复信息", () => {
  afterAll(async () => {
    for (const root of createdRoots) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("createBackup 返回的 BackupHandle 恒含非空 rollbackInstruction，且按策略含非空 gitRef / snapshotPath", async () => {
    await fc.assert(
      fc.asyncProperty(workingDirSpecArb, async (spec) => {
        let root = "";
        try {
          root = await materializeWorkingDir(spec as WorkingDirSpec);
          const handle: BackupHandle = await createBackup({ rootAbsPath: root });

          // 1) rollbackInstruction 恒为非空字符串，且包含工作目录根（足以定位恢复目标）。
          expect(typeof handle.rollbackInstruction).toBe("string");
          expect(handle.rollbackInstruction.trim().length).toBeGreaterThan(0);
          expect(handle.rollbackInstruction).toContain(root);

          // 2) 句柄基本信息完整：根路径回填、createdAt 可解析为时间。
          expect(handle.workingDirRoot).toBe(root);
          expect(Number.isNaN(Date.parse(handle.createdAt))).toBe(false);

          // 3) 按策略含非空恢复引用。
          if (handle.strategy === "file-snapshot") {
            expect(typeof handle.snapshotPath).toBe("string");
            expect((handle.snapshotPath ?? "").trim().length).toBeGreaterThan(0);
            // 非 git 工作目录必走文件快照策略。
            expect(spec.useGit).toBe(false);
          } else {
            // git-commit / git-stash：恢复引用 gitRef 非空。
            expect(typeof handle.gitRef).toBe("string");
            expect((handle.gitRef ?? "").trim().length).toBeGreaterThan(0);
            // git 工作目录必走 git 策略。
            expect(spec.useGit).toBe(true);
          }
        } finally {
          if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 100 },
    );
  }, 180000);
});
