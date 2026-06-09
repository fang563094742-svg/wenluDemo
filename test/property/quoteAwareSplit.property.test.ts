// Feature: proactive-awareness-demo, Bug 5 property: *For any* 由若干子命令经**引号外真实连接符**（`| && ; || &`）拼接而成的组合命令——其中各子命令的参数里可能含**引号内**的同形连接符（`'A|B|C'`、`"x && y"` 等，本是参数而非 shell 连接）——`splitTopLevelCommands` 必须恰好切回这些子命令（引号内连接符不被错切），且 `isCommandWhitelisted` 返回 true 当且仅当**每个**子命令主命令(basename)均在白名单内。
//
// **Validates: Requirements 13.1, 13.2**
//
// 被测纯函数：`src/executor/highRiskGuard.ts` 的 `splitTopLevelCommands` / `isCommandWhitelisted`。
// 用"按构造已知答案"策略：每个 case 由其构造语义直接给出期望（子命令列表 + 是否全白名单），
// 不复用被测逻辑做 oracle，避免同义反复。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  splitTopLevelCommands,
  isCommandWhitelisted,
} from "../../src/executor/highRiskGuard.js";

const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");

/** 白名单名：纯小写字母，长度 1~6。 */
const wlName = fc
  .array(fc.constantFrom(...LOWER), { minLength: 1, maxLength: 6 })
  .map((c) => c.join(""));

/** 白名单集合（去重，1~6 个）。 */
const whitelistArb = fc.uniqueArray(wlName, { minLength: 1, maxLength: 6 });

/** 越界主命令名：必含至少一个数字，故必不在（全小写字母的）白名单内。 */
const outsideName = fc
  .tuple(
    fc.array(fc.constantFrom(...LOWER), { minLength: 0, maxLength: 4 }).map((c) => c.join("")),
    fc.constantFrom(...DIGITS),
    fc.array(fc.constantFrom(...LOWER), { minLength: 0, maxLength: 4 }).map((c) => c.join("")),
  )
  .map(([a, d, b]) => a + d + b);

/** 引号内可出现的内容：含连接符与字母数字，但不含引号与反引号（避免破坏引号配对）。 */
const quotedInnerChars = [...LOWER, ...DIGITS, "|", "&", ";", " ", ".", "*"];
const quotedInner = fc
  .array(fc.constantFrom(...quotedInnerChars), { minLength: 0, maxLength: 10 })
  .map((c) => c.join(""));

/** 引号参数：单引号或双引号包裹一段可能含连接符的内容（这些连接符不应被切分）。 */
const quotedArg = fc
  .tuple(fc.constantFrom("'", '"'), quotedInner)
  .map(([q, inner]) => `${q}${inner}${q}`);

interface SubSpec {
  whitelisted: boolean;
  /** 子命令文本：主命令 [+ 可选引号参数]，自身不含任何引号外连接符。 */
  text: string;
}

const caseArb = whitelistArb.chain((whitelist) => {
  const mkSub = (whitelisted: boolean): fc.Arbitrary<SubSpec> =>
    fc
      .tuple(
        whitelisted ? fc.constantFrom(...whitelist) : outsideName,
        fc.option(quotedArg, { nil: undefined }),
      )
      .map(([main, arg]) => ({ whitelisted, text: arg ? `${main} ${arg}` : main }));

  return fc.record({
    whitelist: fc.constant(whitelist),
    subs: fc.array(fc.oneof(mkSub(true), mkSub(false)), { minLength: 1, maxLength: 5 }),
    // 引号外真实连接符（两侧留空格，贴近真实输入；被测会 trim）。
    seps: fc.array(fc.constantFrom(" | ", " && ", " ; ", " || ", " & "), {
      minLength: 4,
      maxLength: 4,
    }),
  });
});

/** 用引号外连接符把子命令拼成组合命令。 */
function buildCommand(subs: SubSpec[], seps: string[]): string {
  let cmd = subs[0].text;
  for (let i = 1; i < subs.length; i++) {
    cmd += `${seps[(i - 1) % seps.length]}${subs[i].text}`;
  }
  return cmd;
}

describe("Bug 5 property: 引号感知拆分与白名单判定正确性", () => {
  it("splitTopLevelCommands 恰好切回各子命令（引号内连接符不被错切）", () => {
    fc.assert(
      fc.property(caseArb, ({ subs, seps }) => {
        const command = buildCommand(subs, seps);
        const expected = subs.map((s) => s.text);
        expect(splitTopLevelCommands(command)).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("isCommandWhitelisted 为 true 当且仅当所有子命令主命令均在白名单内", () => {
    fc.assert(
      fc.property(caseArb, ({ whitelist, subs, seps }) => {
        const command = buildCommand(subs, seps);
        const expected = subs.every((s) => s.whitelisted);
        return isCommandWhitelisted(command, whitelist) === expected;
      }),
      { numRuns: 100 },
    );
  });
});
