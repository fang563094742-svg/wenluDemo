// Feature: proactive-awareness-demo, Property 27: For any 用户指定路径，当其规范化绝对路径等于受保护关键目录黑名单之一（如 `~`/用户主目录本身、`/`、`/Users`、`/home`、`/etc` 等）时，`Scope_Resolver.confirm` 拒绝落定（抛 `ScopeError`，绝不把该目录设为 Working_Directory）；当不命中黑名单时采用用户指定值落定。

import { describe, it, expect } from "vitest";
import path from "node:path";
import fc from "fast-check";
import {
  DefaultScopeResolver,
  ScopeError,
  isCriticalDir,
} from "../../src/scope/scopeResolver.js";

/**
 * Property 27: 关键目录拒绝（安全关键）
 *
 * Validates: Requirements 9.2, 9.3
 *
 * 充要分支：
 *  - 拒绝方向：用户指定路径规范化后**精确命中**关键目录黑名单（含 `/`、`/Users`、
 *    用户主目录本身等及其等价非规范化写法）→ `confirm` 抛 `ScopeError`，绝不落定。
 *  - 采用方向：不命中黑名单（含黑名单目录下属的**聚焦子目录**）→ `confirm` 落定，
 *    且 `rootAbsPath` 等于用户指定路径的规范化绝对值（R9.3，采用用户最终指定值）。
 *
 * 说明：`confirm` 默认不校验路径存在（`validatePathExists=false`），可在任意生成路径上
 * 确定性验证安全门逻辑；测试注入一组合成关键目录黑名单以保持确定性、避免依赖真实文件系统。
 */

/** 合成关键目录黑名单（绝对路径，规范化比较）。 */
const BLACKLIST: string[] = [
  "/",
  "/Users",
  "/home",
  "/etc",
  "/var",
  "/System",
  "/Library",
  "/usr",
  "/bin",
];

/** 黑名单中的某一项。 */
const blacklistEntryArb = fc.constantFrom(...BLACKLIST);

/** 安全的单个路径段：非空、不含分隔符、非 `.`/`..`。 */
const safeSegArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split("")), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""))
  .filter((s) => s !== "." && s !== "..");

/**
 * 等价非规范化后缀：拼到黑名单项后仍 `path.resolve` 回该项本身。
 * 用于验证安全门对"换皮但等价"的写法同样拒绝。
 */
const equivalentSuffixArb = fc.constantFrom("", "/", "/.", "/./", "/foo/..", "/a/b/../..");

describe("Property 27: 关键目录拒绝", () => {
  it("命中关键目录黑名单（含等价非规范化写法）→ confirm 抛 ScopeError，绝不落定", () => {
    fc.assert(
      fc.property(blacklistEntryArb, equivalentSuffixArb, (entry, suffix) => {
        const resolver = new DefaultScopeResolver({ criticalDirBlacklist: BLACKLIST });
        const userPath = entry + suffix;
        // 前置：该写法确实规范化命中黑名单（构造保证，断言以防回归）
        expect(isCriticalDir(userPath, BLACKLIST)).toBe(true);
        expect(() => resolver.confirm(userPath)).toThrow(ScopeError);
      }),
      { numRuns: 100 },
    );
  });

  it("黑名单目录下的聚焦子目录不被拒，采用用户指定值落定（R9.3）", () => {
    fc.assert(
      fc.property(
        blacklistEntryArb,
        fc.array(safeSegArb, { minLength: 1, maxLength: 4 }),
        (entry, segs) => {
          const base = entry === "/" ? "" : entry;
          const userPath = base + "/" + segs.join("/");
          // 仅在确实不命中黑名单时校验采用方向（极少数子段拼接恰好等于黑名单项则跳过）
          fc.pre(!isCriticalDir(userPath, BLACKLIST));
          const resolver = new DefaultScopeResolver({ criticalDirBlacklist: BLACKLIST });
          const wd = resolver.confirm(userPath);
          expect(wd.rootAbsPath).toBe(path.resolve(userPath));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("不命中黑名单的任意路径 → 采用用户指定值（rootAbsPath === path.resolve(input)）", () => {
    fc.assert(
      fc.property(
        fc.array(safeSegArb, { minLength: 1, maxLength: 6 }),
        (segs) => {
          const userPath = "/" + segs.join("/");
          fc.pre(!isCriticalDir(userPath, BLACKLIST));
          const resolver = new DefaultScopeResolver({ criticalDirBlacklist: BLACKLIST });
          const wd = resolver.confirm(userPath);
          expect(wd.rootAbsPath).toBe(path.resolve(userPath));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("拒绝/采用互斥：confirm 抛错 ⟺ isCriticalDir 为真（用默认黑名单交叉校验）", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          blacklistEntryArb,
          fc.array(safeSegArb, { minLength: 1, maxLength: 5 }).map((s) => "/" + s.join("/")),
        ),
        (userPath) => {
          const resolver = new DefaultScopeResolver({ criticalDirBlacklist: BLACKLIST });
          const hit = isCriticalDir(userPath, BLACKLIST);
          if (hit) {
            expect(() => resolver.confirm(userPath)).toThrow(ScopeError);
          } else {
            expect(resolver.confirm(userPath).rootAbsPath).toBe(path.resolve(userPath));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
