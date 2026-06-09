// Feature: proactive-awareness-demo, Improvement 1（察觉相关性）第 1 层：工具运行时噪音排除。
//
// **Validates: Requirements 4.1, 4.4**
//
// 本测试聚焦 `isExcluded` 中新增的 `isToolNoise` 分支（scanner/exclusionPolicy.ts）。
// 策略：用「按构造已知期望值」的分桶生成器——
//  1. 任意 NOISE_EXTENSIONS 扩展名的文件路径恒被排除（true）；
//  2. 任意 TOOL_NOISE_DIR_SEGMENTS 目录段的路径恒被排除（true）；
//  3. USER_CONTENT_EXTENSIONS 且不在噪音/系统/加密/聊天目录下的路径恒不被排除（false）。
// 第 3 桶刻意避开 system/encrypted/chat 前缀，使「不被排除」是确定的期望值。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isExcluded,
  NOISE_EXTENSIONS,
  TOOL_NOISE_DIR_SEGMENTS,
  SYSTEM_TOP_DIRS,
} from "../../src/scanner/exclusionPolicy.js";
import { USER_CONTENT_EXTENSIONS } from "../../src/scanner/macScanner.js";
import type { FileMeta } from "../../src/scanner/types.js";

// 安全路径段：纯字母数字下划线，且不命中任何系统/噪音目录段。
const safeSeg = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((cs) => cs.join(""))
  .filter((s) => !SYSTEM_TOP_DIRS.includes(s))
  .filter((s) => !TOOL_NOISE_DIR_SEGMENTS.includes(s))
  .filter((s) => !/^[0-9a-f]{16,}$/i.test(s) && s !== "ds_store");

const noiseExt = fc.constantFrom(...NOISE_EXTENSIONS);
const noiseDir = fc.constantFrom(...TOOL_NOISE_DIR_SEGMENTS);
// 用户内容扩展名中，排除与噪音扩展名的任何交集（理论上无交集，防御性过滤）。
const userExt = fc
  .constantFrom(...[...USER_CONTENT_EXTENSIONS])
  .filter((e) => !NOISE_EXTENSIONS.includes(e));

function metaFor(path: string): FileMeta {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return { name, path, mtime: "2026-06-01T00:00:00.000Z", sizeBytes: 1, ext };
}

describe("Improvement 1 第 1 层：工具运行时噪音排除不变量", () => {
  it("任意噪音扩展名文件恒被排除", () => {
    fc.assert(
      fc.property(
        fc.array(safeSeg, { minLength: 1, maxLength: 4 }),
        safeSeg,
        noiseExt,
        (dirs, base, ext) => {
          const path = "/Users/u/" + [...dirs, `${base}.${ext}`].join("/");
          expect(isExcluded(path, metaFor(path))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("任意工具/缓存噪音目录段下的路径恒被排除", () => {
    fc.assert(
      fc.property(
        fc.array(safeSeg, { maxLength: 2 }),
        noiseDir,
        fc.array(safeSeg, { maxLength: 2 }),
        safeSeg,
        (pre, dir, post, base) => {
          const path =
            "/Users/u/" + [...pre, dir, ...post, `${base}.txt`].join("/");
          expect(isExcluded(path, metaFor(path))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("用户内容扩展名 + 干净目录的路径恒不被排除", () => {
    fc.assert(
      fc.property(
        fc.array(safeSeg, { minLength: 1, maxLength: 4 }),
        safeSeg,
        userExt,
        (dirs, base, ext) => {
          // /Users/u/<safe dirs>/<base>.<userExt>：避开 system(第三段非系统目录)、
          // encrypted、chat、noise。
          const path = "/Users/u/" + [...dirs, `${base}.${ext}`].join("/");
          expect(isExcluded(path, metaFor(path))).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
