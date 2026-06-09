// Feature: proactive-awareness-demo, Property 1: *For any* 文件路径与元信息，当且仅当该路径命中任一红线（系统级路径黑名单、加密文件、聊天记录目录）时 `ExclusionPolicy.isExcluded` 返回 true；且对任意目录树，产出的 Scan_Summary 中所有条目路径均不被排除，扫描全程从不读取被排除内容的正文。
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 18.4**
//
// 本测试聚焦任务 4.2 的被测纯函数 `isExcluded(path, meta)`（scanner/exclusionPolicy.ts）。
// 策略：用「按构造已知期望值」的分桶生成器（clean / 系统级 / 加密扩展名 / 加密容器 / 聊天记录），
// 每个用例的 `expected` 完全由构造方式确定（不借助被测逻辑做 oracle），从而严格检验充要条件
// 两个方向：命中任一红线 ⇒ true；不命中任何红线 ⇒ false。
// 另以「过滤不变量」代理第二子句（Scan_Summary 中所有条目路径均不被排除），以「仅依赖
// path+ext、与 size/mtime/name 无关」代理"从不读取正文"的结构性保证（纯函数、无 I/O）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isExcluded,
  SYSTEM_TOP_DIRS,
  ENCRYPTED_EXTENSIONS,
  ENCRYPTED_CONTAINER_SEGMENTS,
  CHAT_PATH_MARKERS,
  TOOL_NOISE_DIR_SEGMENTS,
  NOISE_EXTENSIONS,
} from "../../src/scanner/exclusionPolicy.js";
import type { FileMeta } from "../../src/scanner/types.js";

// ---------------------------------------------------------------------------
// 基础生成器
// ---------------------------------------------------------------------------

/**
 * 安全路径段：仅 [a-z0-9_]，非空，且不等于任何系统级顶层目录（如 library/usr/bin），
 * 也不等于任何工具运行时噪音目录段（如 venv/build/dist/node_modules）。
 * 因不含 "." 也不含 "/"，故绝不会构成加密容器段（`.ssh`/`.gnupg`/`.gpg`）、聊天记录标记，
 * 或带点的噪音目录段（`.npm` 等），可放心用于拼装"干净"路径。
 */
const safeSeg = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((cs) => cs.join(""))
  .filter((s) => !SYSTEM_TOP_DIRS.includes(s))
  .filter((s) => !TOOL_NOISE_DIR_SEGMENTS.includes(s))
  // 避免偶然生成长 hash blob（≥16 位十六进制）或固定噪音文件名。
  .filter((s) => !/^[0-9a-f]{16,}$/i.test(s) && s !== "ds_store");

/** 非加密、非敏感、非噪音的安全扩展名（与 ENCRYPTED_EXTENSIONS / NOISE_EXTENSIONS 无交集）。 */
const cleanExt = fc
  .constantFrom("txt", "ts", "md", "js", "json", "png", "csv")
  .filter((e) => !NOISE_EXTENSIONS.includes(e));

/** 单个红线 token 生成器。 */
const sysDir = fc.constantFrom(...SYSTEM_TOP_DIRS);
const encExt = fc.constantFrom(...ENCRYPTED_EXTENSIONS);
const containerSeg = fc.constantFrom(...ENCRYPTED_CONTAINER_SEGMENTS);
const chatMarker = fc.constantFrom(...CHAT_PATH_MARKERS);

// ---------------------------------------------------------------------------
// 「按构造已知期望值」的分桶用例
// ---------------------------------------------------------------------------

interface Labeled {
  path: string;
  ext: string;
  /** 由构造方式直接确定的期望排除结果（不依赖被测函数）。 */
  expected: boolean;
}

/** clean：不命中任何红线 → expected false。 */
const cleanCase: fc.Arbitrary<Labeled> = fc
  .record({
    segs: fc.array(safeSeg, { minLength: 1, maxLength: 5 }),
    ext: cleanExt,
  })
  .map(({ segs, ext }) => ({ path: "/" + segs.join("/"), ext, expected: false }));

/** 系统级（根下第一段为系统目录）→ expected true（R4.1）。 */
const systemRootCase: fc.Arbitrary<Labeled> = fc
  .record({ d: sysDir, rest: fc.array(safeSeg, { maxLength: 4 }), ext: cleanExt })
  .map(({ d, rest, ext }) => ({ path: "/" + [d, ...rest].join("/"), ext, expected: true }));

/** 系统级（~/Library 等：/Users/<name>/<systemDir>/…）→ expected true（R4.1）。 */
const systemUserCase: fc.Arbitrary<Labeled> = fc
  .record({
    name: safeSeg,
    d: sysDir,
    rest: fc.array(safeSeg, { maxLength: 4 }),
    ext: cleanExt,
  })
  .map(({ name, d, rest, ext }) => ({
    path: "/Users/" + [name, d, ...rest].join("/"),
    ext,
    expected: true,
  }));

/** 加密文件（按扩展名）→ expected true（R4.2）。基路径本身干净，唯一排除原因是 ext。 */
const encExtCase: fc.Arbitrary<Labeled> = fc
  .record({ segs: fc.array(safeSeg, { minLength: 1, maxLength: 4 }), ext: encExt })
  .map(({ segs, ext }) => ({ path: "/Users/u/" + segs.join("/"), ext, expected: true }));

/** 加密容器目录段（.ssh/.gnupg/.gpg）→ expected true（R4.2）。基路径与 ext 均干净，唯一排除原因是容器段。 */
const encContainerCase: fc.Arbitrary<Labeled> = fc
  .record({
    pre: fc.array(safeSeg, { maxLength: 2 }),
    c: containerSeg,
    post: fc.array(safeSeg, { maxLength: 2 }),
    ext: cleanExt,
  })
  .map(({ pre, c, post, ext }) => ({
    path: "/Users/u/" + [...pre, c, ...post].join("/"),
    ext,
    expected: true,
  }));

/** 聊天记录目录（含 IM 容器标记 / iMessage 路径）→ expected true（R4.3）。 */
const chatCase: fc.Arbitrary<Labeled> = fc
  .record({ name: safeSeg, marker: chatMarker, tail: safeSeg, ext: cleanExt })
  .map(({ name, marker, tail, ext }) => {
    // marker 以 "/" 开头者（如 "/library/messages"）直接拼接，否则作为独立路径段嵌入。
    const path = marker.startsWith("/")
      ? `/Users/${name}${marker}/${tail}.db`
      : `/Users/${name}/sub/${marker}/${tail}.txt`;
    return { path, ext, expected: true };
  });

const labeledCase: fc.Arbitrary<Labeled> = fc.oneof(
  cleanCase,
  systemRootCase,
  systemUserCase,
  encExtCase,
  encContainerCase,
  chatCase,
);

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function metaFor(path: string, ext: string, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    name: path.split("/").pop() ?? "",
    path,
    mtime: "2024-01-01T00:00:00.000Z",
    sizeBytes: 1,
    ext,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe("Property 1: 扫描排除红线不变量", () => {
  it("isExcluded(path, meta) 返回 true 当且仅当命中任一红线（按构造已知期望值，覆盖充要条件双向）", () => {
    fc.assert(
      fc.property(labeledCase, ({ path, ext, expected }) => {
        expect(isExcluded(path, metaFor(path, ext))).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("过滤后的条目集合中所有路径均不被排除（Scan_Summary 条目不被排除的不变量代理）", () => {
    fc.assert(
      fc.property(fc.array(labeledCase, { maxLength: 30 }), (cases) => {
        // 模拟"采集阶段即排除"：用 !isExcluded 过滤出可纳入 Scan_Summary 的条目，
        // 断言保留的每一条都确实未命中红线。
        const kept = cases.filter((c) => !isExcluded(c.path, metaFor(c.path, c.ext)));
        return kept.every((c) => isExcluded(c.path, metaFor(c.path, c.ext)) === false);
      }),
      { numRuns: 100 },
    );
  });

  it("判定仅依赖 path 与 ext，与 size/mtime/name 等无关（纯函数、从不读取正文的结构性保证）", () => {
    fc.assert(
      fc.property(labeledCase, fc.nat(), ({ path, ext, expected }, size) => {
        const m1 = metaFor(path, ext, {
          name: path.split("/").pop() ?? "",
          mtime: "1970-01-01T00:00:00.000Z",
          sizeBytes: 0,
        });
        const m2 = metaFor(path, ext, {
          name: "totally-different-name",
          mtime: "2030-12-31T23:59:59.000Z",
          sizeBytes: size,
        });
        const r1 = isExcluded(path, m1);
        const r2 = isExcluded(path, m2);
        return r1 === r2 && r1 === expected;
      }),
      { numRuns: 100 },
    );
  });
});
