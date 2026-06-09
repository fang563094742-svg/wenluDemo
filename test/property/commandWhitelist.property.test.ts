// Feature: proactive-awareness-demo, Property 24: *For any* 命令字符串与安全命令白名单，`isCommandWhitelisted(command, whitelist)` 返回 true 当且仅当：将命令按 `|`、`&&`、`;`、`||` 拆分为各子命令后，**每个**子命令的主命令（去除路径前缀取 basename）都在白名单内；只要存在任一子命令的主命令不在白名单内，即返回 false（从而由 `HighRiskGuard` 兜底判为高危）。
//
// **Validates: Requirements 13.1, 13.2**
//
// 本测试聚焦任务 11.7 的被测单元 `isCommandWhitelisted`（组合命令按 | && ; || 拆分、
// 主命令取 basename 比对白名单）。纯静态字符串判定，不触及文件系统/外部状态。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { isCommandWhitelisted } from "../../src/executor/highRiskGuard.js";
import { SAFE_COMMAND_WHITELIST } from "../../src/config/config.js";

const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");

/** 白名单条目名：纯小写字母，长度 1~6（与下方"含数字"的越界名天然不相交）。 */
const wlName = fc
  .array(fc.constantFrom(...LOWER), { minLength: 1, maxLength: 6 })
  .map((c) => c.join(""));

/** 安全命令白名单：去重的小写名集合，1~6 个。 */
const whitelistArb = fc.uniqueArray(wlName, { minLength: 1, maxLength: 6 });

/**
 * 越界主命令名：必含至少一个数字。
 * 白名单条目全为小写字母，因此含数字的 basename 必不在白名单内（即便加路径前缀，
 * basename 仍含数字），从而保证"非白名单"语义稳定可判定。
 */
const outsideName = fc
  .tuple(
    fc.array(fc.constantFrom(...LOWER), { minLength: 0, maxLength: 5 }).map((c) => c.join("")),
    fc.constantFrom(...DIGITS),
    fc.array(fc.constantFrom(...LOWER), { minLength: 0, maxLength: 5 }).map((c) => c.join("")),
  )
  .map(([a, d, b]) => a + d + b);

/** 可选路径前缀：覆盖 basename 去前缀（含 ./ ../ 绝对路径 相对路径）。 */
const prefix = fc.constantFrom("", "./", "../", "/usr/bin/", "bin/");

/** 命令参数 token：字母数字，不含任何分隔符/空白，保证拆分确定。 */
const argTok = fc
  .array(fc.constantFrom(...LOWER, ...DIGITS), { minLength: 1, maxLength: 5 })
  .map((c) => c.join(""));
const args = fc.array(argTok, { minLength: 0, maxLength: 3 });

interface SubSpec {
  /** 该子命令的主命令是否命中白名单（= 期望该子命令"合法"）。 */
  whitelisted: boolean;
  /** 子命令文本（主命令 [+ 参数]）。 */
  text: string;
}

/**
 * 生成一个 case：选定白名单后，构造 1~5 个子命令（每个或合规或越界），
 * 以及用于连接子命令的分隔符序列（仅取自 Property 24 规定的 | && ; ||）。
 */
const caseArb = whitelistArb.chain((whitelist) => {
  const whitelistedSub: fc.Arbitrary<SubSpec> = fc
    .tuple(prefix, fc.constantFrom(...whitelist), args)
    .map(([p, name, a]) => ({ whitelisted: true, text: [p + name, ...a].join(" ") }));
  const outsideSub: fc.Arbitrary<SubSpec> = fc
    .tuple(prefix, outsideName, args)
    .map(([p, name, a]) => ({ whitelisted: false, text: [p + name, ...a].join(" ") }));
  return fc.record({
    whitelist: fc.constant(whitelist),
    subs: fc.array(fc.oneof(whitelistedSub, outsideSub), { minLength: 1, maxLength: 5 }),
    seps: fc.array(fc.constantFrom("|", "&&", ";", "||"), { minLength: 4, maxLength: 4 }),
  });
});

/** 用分隔符把子命令拼成组合命令串（分隔符两侧留空格，更贴近真实输入）。 */
function buildCommand(subs: SubSpec[], seps: string[]): string {
  let cmd = subs[0].text;
  for (let i = 1; i < subs.length; i++) {
    cmd += ` ${seps[(i - 1) % seps.length]} ${subs[i].text}`;
  }
  return cmd;
}

describe("Property 24: 组合命令白名单拆分正确性", () => {
  it("当且仅当所有子命令主命令(basename)均命中白名单时返回 true", () => {
    fc.assert(
      fc.property(caseArb, ({ whitelist, subs, seps }) => {
        const command = buildCommand(subs, seps);
        const expected = subs.every((s) => s.whitelisted); // 子命令数 >= 1，恒有定义
        return isCommandWhitelisted(command, whitelist) === expected;
      }),
      { numRuns: 100 },
    );
  });

  // 显式锚定若干已知答案，作为属性测试的边界补充。
  it("空命令/纯空白 → false（无法确认安全性，保守兜底）", () => {
    expect(isCommandWhitelisted("", SAFE_COMMAND_WHITELIST)).toBe(false);
    expect(isCommandWhitelisted("   ", SAFE_COMMAND_WHITELIST)).toBe(false);
  });

  it("全部子命令命中白名单 → true；任一未命中 → false", () => {
    expect(isCommandWhitelisted("git status", SAFE_COMMAND_WHITELIST)).toBe(true);
    expect(isCommandWhitelisted("git status | grep foo", SAFE_COMMAND_WHITELIST)).toBe(true);
    expect(isCommandWhitelisted("/usr/bin/node app.js", SAFE_COMMAND_WHITELIST)).toBe(true);
    expect(isCommandWhitelisted("git status | unknowncmd", SAFE_COMMAND_WHITELIST)).toBe(false);
    expect(isCommandWhitelisted("rm -rf x && npm i", SAFE_COMMAND_WHITELIST)).toBe(false);
  });
});
