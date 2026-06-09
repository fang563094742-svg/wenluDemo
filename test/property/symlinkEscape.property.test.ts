// Feature: proactive-awareness-demo, Property 25: *For any* tool call 与 sandbox，`detectSymlinkEscape(tc, sandbox)` 返回非空（应阻止）当且仅当：(a) `write_file` 的目标路径已是一个符号链接（lstat 判定），或 (b) `run_command` 含 `ln -s` 且其创建的软链指向 sandbox 之外（经 realpath 判定越界）；对不触发上述任一条件的正常 tool call 返回 null（放行）。
//
// **Validates: Requirements 12.2, 12.4**
//
// 本测试聚焦任务 11.3 的被测单元 `detectSymlinkEscape`（配合 `SandboxGuard`）。
// 所有临时文件/目录/符号链接均创建于 os.tmpdir() 下，测试结束清理；绝不触及项目目录外的用户路径。

import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectSymlinkEscape } from "../../src/executor/symlinkEscape.js";
import { SandboxGuard } from "../../src/executor/sandboxGuard.js";
import type { ToolCall } from "../../src/executor/types.js";

/**
 * 测试夹具：在 os.tmpdir() 下搭建真实 sandbox 根 + sandbox 外目录，
 * 并在 sandbox 内预置——一个真实符号链接（用于 write_file 命中分支）、
 * 一个普通文件、一个普通目录（用于 write_file 放行分支）。
 */
interface Fixture {
  /** sandbox 根（os.tmpdir() 下，前缀 pad-sym-）。 */
  root: string;
  /** sandbox 外的真实目录（os.tmpdir() 下，前缀 pad-symout-）。 */
  outsideDir: string;
  /** sandbox 内的真实符号链接绝对路径（指向 outsideDir）。 */
  symlinkPath: string;
  /** sandbox 内的真实普通文件绝对路径。 */
  regularFile: string;
  /** sandbox 内的真实普通目录绝对路径。 */
  regularDir: string;
  guard: SandboxGuard;
}

let fx: Fixture;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pad-sym-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-symout-"));

  // sandbox 内已存在的符号链接：write_file 目标若是它，无论指向何处都应被拒绝。
  const symlinkPath = path.join(root, "existing-symlink");
  fs.symlinkSync(outsideDir, symlinkPath);

  // sandbox 内普通文件 / 普通目录：write_file 目标若是它们应放行（非符号链接）。
  const regularFile = path.join(root, "regular.txt");
  fs.writeFileSync(regularFile, "x");
  const regularDir = path.join(root, "regular-dir");
  fs.mkdirSync(regularDir, { recursive: true });

  // 构造函数会对根做 realpathSync 规范化（解析 tmpdir 上的符号链接，如 macOS /tmp→/private/tmp）。
  const guard = new SandboxGuard(root);
  fx = { root, outsideDir, symlinkPath, regularFile, regularDir, guard };
});

afterAll(() => {
  if (fx?.root) fs.rmSync(fx.root, { recursive: true, force: true });
  if (fx?.outsideDir) fs.rmSync(fx.outsideDir, { recursive: true, force: true });
});

/** 安全路径段：仅 [a-z0-9_-]，非空，绝不含 "." / ".." / "/" / 空白，避免命令/路径歧义。 */
const segment = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/** 1~3 段拼成的相对路径片段（无 ".."、无前导分隔符、无空白）。 */
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 3 })
  .map((segs) => segs.join("/"));

/** `ln` 选项变体（覆盖 -s / -sf / -sn 等 `-s\w*` 形态）。 */
const lnFlag = fc.constantFrom("-s", "-sf", "-sn", "-snf");

/** 不含 `ln -s` 的普通命令前缀。 */
const benignCmd = fc.constantFrom("echo", "ls", "cat", "npm", "git");

/**
 * 构造已知答案的测试用例：每个 case 决定一种 tool call 形态，
 * 并按构造方式直接得出 `expectBlocked`（是否应返回非空），无需复用被测逻辑做 oracle。
 */
type Case =
  // (a) write_file —— 命中：目标已是符号链接
  | { kind: "wf-symlink" }
  // write_file —— 放行：目标是普通文件 / 普通目录 / 不存在
  | { kind: "wf-regular-file" }
  | { kind: "wf-regular-dir" }
  | { kind: "wf-nonexistent"; rel: string }
  // (b) run_command ln -s —— 命中：软链落在 sandbox 内、源指向 sandbox 外
  | { kind: "rc-escape"; flag: string; rel: string }
  // run_command ln -s —— 放行：源与软链都在 sandbox 内
  | { kind: "rc-both-inside"; flag: string; relSrc: string; relLink: string }
  // run_command ln -s —— 放行：软链落点在 sandbox 外（不在保护范围内，无需阻止）
  | { kind: "rc-link-outside"; flag: string; rel: string }
  // run_command —— 放行：不含 ln -s 的普通命令
  | { kind: "rc-benign"; cmd: string; rel: string }
  // 其他 tool call —— 一律放行
  | { kind: "read-file"; rel: string }
  | { kind: "list-dir"; rel: string }
  | { kind: "delete-file"; rel: string };

const caseArb: fc.Arbitrary<Case> = fc.oneof(
  fc.constant<Case>({ kind: "wf-symlink" }),
  fc.constant<Case>({ kind: "wf-regular-file" }),
  fc.constant<Case>({ kind: "wf-regular-dir" }),
  relPath.map<Case>((rel) => ({ kind: "wf-nonexistent", rel })),
  fc.tuple(lnFlag, relPath).map<Case>(([flag, rel]) => ({ kind: "rc-escape", flag, rel })),
  fc
    .tuple(lnFlag, relPath, relPath)
    .map<Case>(([flag, relSrc, relLink]) => ({ kind: "rc-both-inside", flag, relSrc, relLink })),
  fc.tuple(lnFlag, relPath).map<Case>(([flag, rel]) => ({ kind: "rc-link-outside", flag, rel })),
  fc.tuple(benignCmd, relPath).map<Case>(([cmd, rel]) => ({ kind: "rc-benign", cmd, rel })),
  relPath.map<Case>((rel) => ({ kind: "read-file", rel })),
  relPath.map<Case>((rel) => ({ kind: "list-dir", rel })),
  relPath.map<Case>((rel) => ({ kind: "delete-file", rel })),
);

/** 由 case 推导出 (待检测 tool call, 期望是否应被阻止)。 */
function materialize(c: Case): { tc: ToolCall; expectBlocked: boolean } {
  const { root, outsideDir, symlinkPath, regularFile, regularDir } = fx;
  const wf = (p: string): ToolCall => ({ id: "t", name: "write_file", arguments: { path: p } });
  const rc = (command: string): ToolCall => ({ id: "t", name: "run_command", arguments: { command } });

  switch (c.kind) {
    case "wf-symlink":
      // 目标已是符号链接 → lstat 命中 → 阻止。
      return { tc: wf(symlinkPath), expectBlocked: true };
    case "wf-regular-file":
      return { tc: wf(regularFile), expectBlocked: false };
    case "wf-regular-dir":
      return { tc: wf(regularDir), expectBlocked: false };
    case "wf-nonexistent":
      // sandbox 内不存在的路径（"nx/" 前缀确保不撞夹具条目）→ 非符号链接 → 放行。
      return { tc: wf(path.join(root, "nx", c.rel)), expectBlocked: false };
    case "rc-escape": {
      // 软链落点在 sandbox 内、源指向 sandbox 外 → 阻止。
      const link = path.join(root, "newlink", c.rel);
      const src = path.join(outsideDir, c.rel);
      return { tc: rc(`ln ${c.flag} ${src} ${link}`), expectBlocked: true };
    }
    case "rc-both-inside": {
      // 源与软链都在 sandbox 内 → 放行。
      const src = path.join(root, "in-src", c.relSrc);
      const link = path.join(root, "in-link", c.relLink);
      return { tc: rc(`ln ${c.flag} ${src} ${link}`), expectBlocked: false };
    }
    case "rc-link-outside": {
      // 软链落点在 sandbox 外（不在保护范围）→ 放行。
      const src = path.join(root, "in-src", c.rel);
      const link = path.join(outsideDir, "outlink", c.rel);
      return { tc: rc(`ln ${c.flag} ${src} ${link}`), expectBlocked: false };
    }
    case "rc-benign":
      // 不含 ln -s 的普通命令 → 放行。
      return { tc: rc(`${c.cmd} ${c.rel}`), expectBlocked: false };
    case "read-file":
      return { tc: { id: "t", name: "read_file", arguments: { path: path.join(root, c.rel) } }, expectBlocked: false };
    case "list-dir":
      return { tc: { id: "t", name: "list_dir", arguments: { path: path.join(root, c.rel) } }, expectBlocked: false };
    case "delete-file":
      // delete_file 的高危由 High_Risk_Guard 负责，符号链接逃逸检测一律放行。
      return { tc: { id: "t", name: "delete_file", arguments: { path: path.join(root, c.rel) } }, expectBlocked: false };
  }
}

describe("Property 25: 符号链接逃逸拦截（detectSymlinkEscape 充要判定）", () => {
  it("返回非空当且仅当 write_file 目标是符号链接 或 run_command 的 ln -s 软链越界逃逸", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { tc, expectBlocked } = materialize(c);
        const reason = detectSymlinkEscape(tc, fx.guard);
        // 充要：命中应返回非空字符串；放行应返回 null。
        return expectBlocked ? typeof reason === "string" && reason.length > 0 : reason === null;
      }),
      { numRuns: 100 },
    );
  });
});
