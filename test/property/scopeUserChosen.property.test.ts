// Feature: proactive-awareness-demo, Property 23: *For any* 用户指定（接受、拒绝后改写）的有效目录路径，`Scope_Resolver.confirm` 落定的 Working_Directory 的 `rootAbsPath` 等于该路径的规范化绝对路径。
//
// **Validates: Requirements 9.3**
//
// 本测试聚焦任务 9.1 的被测单元 `DefaultScopeResolver.confirm`：对任意「有效」（即未命中
// 关键目录黑名单）的用户指定路径——无论用户是接受建议还是拒绝后改写——confirm 落定的
// Working_Directory.rootAbsPath 都必须等于 `path.resolve(userChosenPath)`（规范化绝对路径），
// 既不附加也不偏移。生成器刻意只产出「聚焦的深层目录」（绝对路径以唯一前缀段打头、相对路径
// 解析到 cwd 之下），从而保证「有效」前提成立、confirm 不会因黑名单而抛错。

import { describe, it } from "vitest";
import fc from "fast-check";
import path from "node:path";

import { DefaultScopeResolver } from "../../src/scope/scopeResolver.js";

/** 安全路径段：仅 [a-z0-9_-]，非空，绝不含 "." / ".." / "/"。 */
const segment = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/** 1~5 个安全段。 */
const segments = fc.array(segment, { minLength: 1, maxLength: 5 });

/** 末尾是否带冗余分隔符（验证规范化会折叠尾随分隔符）。 */
const trailingSlash = fc.boolean();

/**
 * 用户指定路径用例：覆盖「接受建议 / 拒绝后改写」两类来源都会出现的两种路径形态：
 *  - absolute：绝对路径。首段固定为唯一前缀 `pad-scope-root`，确保**绝不**命中
 *    `CRITICAL_DIR_BLACKLIST`（"/"、"/Users"、homedir() 等单段/已知敏感根），从而满足
 *    Property 23 的「有效目录路径」前提。
 *  - relative：相对路径。`path.resolve` 会把它解析到 `process.cwd()`（=wenLuDemo，深层、
 *    非关键目录）之下，同样保证「有效」。可选 `./` 前缀验证冗余当前目录段被规范化折叠。
 */
type Case =
  | { kind: "absolute"; segs: string[]; trailing: boolean }
  | { kind: "relative"; segs: string[]; dotPrefix: boolean; trailing: boolean };

const caseArb: fc.Arbitrary<Case> = fc.oneof(
  fc.record({ segs: segments, trailing: trailingSlash }).map<Case>((r) => ({
    kind: "absolute",
    segs: r.segs,
    trailing: r.trailing,
  })),
  fc
    .record({ segs: segments, dotPrefix: fc.boolean(), trailing: trailingSlash })
    .map<Case>((r) => ({
      kind: "relative",
      segs: r.segs,
      dotPrefix: r.dotPrefix,
      trailing: r.trailing,
    })),
);

/** 由 case 拼出用户实际输入的路径字符串。 */
function toUserPath(c: Case): string {
  const tail = c.trailing ? "/" : "";
  if (c.kind === "absolute") {
    return "/" + ["pad-scope-root", ...c.segs].join("/") + tail;
  }
  const prefix = c.dotPrefix ? "./" : "";
  return prefix + c.segs.join("/") + tail;
}

describe("Property 23: 工作目录采用用户最终指定值", () => {
  it("confirm 落定的 rootAbsPath 等于用户指定路径的规范化绝对路径", () => {
    // 默认黑名单 + 不做文件系统存在性校验：confirm 即「规范化 + 关键目录安全门」。
    const resolver = new DefaultScopeResolver();

    fc.assert(
      fc.property(caseArb, (c) => {
        const userPath = toUserPath(c);
        const wd = resolver.confirm(userPath);
        return wd.rootAbsPath === path.resolve(userPath);
      }),
      { numRuns: 100 },
    );
  });
});
