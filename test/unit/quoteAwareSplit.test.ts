// Bug 5 回归（真实 GPT-5.4 端到端暴露）：`isCommandWhitelisted` / `splitTopLevelCommands`
// 引号感知拆分。
//
// **Validates: Requirements 13.1, 13.2**
//
// 现象：旧实现用 `command.split(/\|\||&&|;|\||&/)` 裸分割，会把**引号内**的 `|`/`&&`/`;`/`&`
// 也错切。GPT-5.4 产出的 grep 验收命令含引号内正则 `'A|B|C'`，被错切成多段、片段首 token
// 不在白名单 → 误判高危 → 验收 failed。修复：仅在**不处于引号内**时才按连接符切分。
//
// 本文件用确定性示例锚定：引号内的连接符不被错切（→ 命中白名单），引号外的真实连接符仍被
// 正确切分逐一判定，黑名单优先性不受影响。

import { describe, it, expect } from "vitest";

import {
  isCommandWhitelisted,
  splitTopLevelCommands,
  HighRiskGuard,
} from "../../src/executor/highRiskGuard.js";
import { SAFE_COMMAND_WHITELIST } from "../../src/config/config.js";
import type { ToolCall } from "../../src/executor/types.js";

const WL = SAFE_COMMAND_WHITELIST;

describe("Bug 5 / splitTopLevelCommands 引号感知拆分（确定性示例）", () => {
  it("引号内的 | 不切分：单引号正则内的管道符视为参数", () => {
    expect(splitTopLevelCommands("grep -Ei 'A|B|C' x")).toEqual(["grep -Ei 'A|B|C' x"]);
  });

  it("引号内的 && / ; / & 不切分", () => {
    expect(splitTopLevelCommands("echo 'a && b ; c & d'")).toEqual(["echo 'a && b ; c & d'"]);
    expect(splitTopLevelCommands('echo "x || y"')).toEqual(['echo "x || y"']);
  });

  it("引号外的真实连接符仍被正确切分", () => {
    expect(splitTopLevelCommands("grep -F 'a|b' x && grep -F 'c' y")).toEqual([
      "grep -F 'a|b' x",
      "grep -F 'c' y",
    ]);
    expect(splitTopLevelCommands("ls | sort | uniq")).toEqual(["ls", "sort", "uniq"]);
    expect(splitTopLevelCommands("a ; b ; c")).toEqual(["a", "b", "c"]);
  });

  it("空串 / 纯空白 → 空数组", () => {
    expect(splitTopLevelCommands("")).toEqual([]);
    expect(splitTopLevelCommands("   ")).toEqual([]);
  });
});

describe("Bug 5 / isCommandWhitelisted 引号感知（确定性示例）", () => {
  it("grep 正则含引号内 | 的组合命令 → true（不被错切）", () => {
    const cmd = "grep -Ei 'A|B|C' x && grep -F 'y' x";
    expect(isCommandWhitelisted(cmd, WL)).toBe(true);
  });

  it("真实 GPT-5.4 grep 验收命令（多 alternation + 多 grep）→ true", () => {
    const cmd =
      "grep -Ei 'Node.*字符串工具|字符串工具.*Node|Node string utility|string utility.*Node' README.md && grep -F 'slugify' README.md && grep -F 'truncate' README.md";
    expect(isCommandWhitelisted(cmd, WL)).toBe(true);
  });

  it("引号外真实管道接非白名单命令 → false（防御不被削弱）", () => {
    // 'foobarcli' 不在白名单内；引号外的真实管道应被切出并判定。
    expect(isCommandWhitelisted("grep -F 'a|b' x | foobarcli", WL)).toBe(false);
  });

  it("test / [ 现已在白名单内", () => {
    expect(isCommandWhitelisted("test -f README.md", WL)).toBe(true);
    expect(isCommandWhitelisted("[ -d src ]", WL)).toBe(true);
  });
});

describe("Bug 5 / HighRiskGuard 黑名单优先性不被破坏", () => {
  const guard = new HighRiskGuard();
  const run = (command: string): ToolCall => ({
    id: "t",
    name: "run_command",
    arguments: { command },
  });

  it("echo hi && rm -rf / 仍判高危（黑名单优先于白名单与引号感知）", () => {
    expect(guard.isHighRisk(run("echo hi && rm -rf /"))).toBe(true);
  });

  it("grep 引号内 | 的 NL 命令裸命令 → 非高危（test/grep 都在白名单）", () => {
    expect(guard.isHighRisk(run("test -f README.md"))).toBe(false);
    expect(
      guard.isHighRisk(run("grep -Ei 'A|B|C' README.md && grep -F 'slugify' README.md")),
    ).toBe(false);
  });

  it("引号外真实管道接 rm 仍判高危（rm 命中黑名单）", () => {
    expect(guard.isHighRisk(run("grep -F 'a|b' x | rm -rf dist"))).toBe(true);
  });
});
