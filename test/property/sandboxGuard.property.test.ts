// Feature: proactive-awareness-demo, Property 15: *For any* sandbox 根目录与目标路径，`SandboxGuard.isInside` 在**用 realpath 解析符号链接之后**判定：对所有解析后位于根目录内（含根本身）的路径返回 true（已存在路径用 `realpathSync` 解析，待创建路径用"最近已存在父目录的 realpath + 剩余路径段"解析）；对所有越界路径——包括 `..` 穿越、绝对路径逃逸、以及**经符号链接指向根外的路径**——返回 false。且执行循环中携带越界路径的 tool call 一律被阻止并记录 `blocked=true`，对应工具绝不被 invoke。
//
// **Validates: Requirements 12.2, 12.4**
//
// 本测试聚焦任务 11.2 的被测单元 `SandboxGuard.isInside`（含 realpath 符号链接解析）。
// 所有临时文件/目录/符号链接均创建于 os.tmpdir() 下，测试结束清理；绝不触及项目目录外的用户路径。

import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxGuard } from "../../src/executor/sandboxGuard.js";

/**
 * 测试夹具：在 os.tmpdir() 下搭建一个真实 sandbox 根 + sandbox 外目录，
 * 并在 sandbox 内布置真实符号链接（指内 / 指外 / 父链指外），用于驱动
 * `SandboxGuard.isInside` 的 realpath 解析路径。
 */
interface Fixture {
  /** sandbox 根（os.tmpdir() 下，前缀 pad-sbox-）。 */
  root: string;
  /** sandbox 外的真实目录（os.tmpdir() 下，前缀 pad-out-）。 */
  outsideDir: string;
  guard: SandboxGuard;
}

let fx: Fixture;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pad-sbox-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-out-"));

  // sandbox 内的真实子目录与文件（用于"已存在路径" realpathSync 分支）。
  fs.mkdirSync(path.join(root, "realsub"), { recursive: true });
  fs.writeFileSync(path.join(root, "realsub", "realfile.txt"), "x");

  // sandbox 内符号链接：指向 sandbox 内（解析后仍在内 → true）。
  fs.symlinkSync(path.join(root, "realsub"), path.join(root, "link-to-inside"));
  // sandbox 内符号链接：指向 sandbox 外（解析后逃逸 → false）。
  fs.symlinkSync(outsideDir, path.join(root, "link-to-outside"));
  // 父链中的符号链接：nested/up 指向 sandbox 外（借父目录软链逃逸 → false）。
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(root, "nested", "up"));

  // 构造函数会对根做 realpathSync 规范化（解析 tmpdir 上的符号链接，如 macOS /tmp→/private/tmp）。
  const guard = new SandboxGuard(root);
  fx = { root, outsideDir, guard };
});

afterAll(() => {
  if (fx?.root) fs.rmSync(fx.root, { recursive: true, force: true });
  if (fx?.outsideDir) fs.rmSync(fx.outsideDir, { recursive: true, force: true });
});

/** 安全路径段：仅 [a-z0-9_-]，非空，绝不含 "." / ".." / "/"，避免与夹具条目意外冲突。 */
const segment = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/** 1~4 段拼成的相对路径片段（无 ".."、无前导分隔符）。 */
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((segs) => segs.join("/"));

/**
 * 构造已知答案的测试用例：每个 case 由生成器决定一种路径形态，
 * 并按构造方式得出 `expected`（是否应在 sandbox 内），无需复用被测逻辑做 oracle。
 */
type Case =
  | { kind: "root-abs" }
  | { kind: "root-dot" }
  | { kind: "inside-new"; rel: string }
  | { kind: "inside-existing" }
  | { kind: "inside-via-symlink"; rel: string }
  | { kind: "dotdot-escape"; seg: string }
  | { kind: "abs-outside"; rel: string }
  | { kind: "symlink-outside"; rel: string }
  | { kind: "parent-symlink-escape"; rel: string };

const caseArb: fc.Arbitrary<Case> = fc.oneof(
  fc.constant<Case>({ kind: "root-abs" }),
  fc.constant<Case>({ kind: "root-dot" }),
  fc.constant<Case>({ kind: "inside-existing" }),
  relPath.map<Case>((rel) => ({ kind: "inside-new", rel })),
  relPath.map<Case>((rel) => ({ kind: "inside-via-symlink", rel })),
  segment.map<Case>((seg) => ({ kind: "dotdot-escape", seg })),
  relPath.map<Case>((rel) => ({ kind: "abs-outside", rel })),
  relPath.map<Case>((rel) => ({ kind: "symlink-outside", rel })),
  relPath.map<Case>((rel) => ({ kind: "parent-symlink-escape", rel })),
);

/** 由 case 推导出 (目标路径, 期望是否在内)。 */
function materialize(c: Case): { target: string; expected: boolean } {
  const { root, outsideDir } = fx;
  switch (c.kind) {
    case "root-abs":
      return { target: root, expected: true };
    case "root-dot":
      return { target: path.join(root, "."), expected: true };
    case "inside-existing":
      return { target: path.join(root, "realsub", "realfile.txt"), expected: true };
    case "inside-new":
      // 不存在的内部路径：经"最近已存在父目录(=root) realpath + 剩余段"解析仍在内。
      return { target: path.join(root, "safe-inside", c.rel), expected: true };
    case "inside-via-symlink":
      // 软链 link-to-inside → realsub（内），解析后仍在内。
      return { target: path.join(root, "link-to-inside", c.rel), expected: true };
    case "dotdot-escape":
      // `..` 穿越到 root 的父目录；"zz-" 前缀确保不等于 root basename(pad-sbox-*)，必越界。
      return { target: path.join(root, "..", `zz-${c.seg}`), expected: false };
    case "abs-outside":
      // 绝对路径逃逸到 sandbox 外目录。
      return { target: path.join(outsideDir, c.rel), expected: false };
    case "symlink-outside":
      // 软链 link-to-outside → outsideDir（外），解析后越界。
      return { target: path.join(root, "link-to-outside", c.rel), expected: false };
    case "parent-symlink-escape":
      // 父链软链 nested/up → outsideDir（外），借父目录软链逃逸，必越界。
      return { target: path.join(root, "nested", "up", c.rel), expected: false };
  }
}

describe("Property 15: SandboxGuard.isInside 越界校验（含 realpath 符号链接解析）", () => {
  it("对解析后在根内的路径返回 true，对 .. 穿越/绝对逃逸/符号链接逃逸返回 false", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { target, expected } = materialize(c);
        return fx.guard.isInside(target) === expected;
      }),
      { numRuns: 100 },
    );
  });
});
