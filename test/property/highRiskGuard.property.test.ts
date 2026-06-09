// Feature: proactive-awareness-demo, Property 17: *For any* tool call，`HighRiskGuard.isHighRisk` 返回 true 的充要条件是命中以下任一：(a) 工具为 `delete_file`；(b) `run_command` 命中高危黑名单（rm、sudo、chmod、chown、运行 shell、git force push、`find -delete`、`find -exec` 等）；(c) `run_command` 的**主命令不在安全命令白名单内**（白名单兜底门，按 `| && ; ||` 拆分后任一子命令主命令不在白名单即判高危；`curl`/`wget` 默认不在白名单内，故默认判高危）。仅当工具为只读工具，或 `run_command` 的所有子命令主命令均在白名单内且不含黑名单模式（含 `find -delete`/`-exec`）时返回 false。
//
// **Validates: Requirements 13.1, 13.2**
//
// 被测纯判定单元：`HighRiskGuard.isHighRisk`（任务 11.5，安全关键）。本测试用"按构造已知答案"
// 的策略生成工具调用：每个 case 由其构造语义直接给出期望值（expected），不复用被测逻辑做
// oracle，避免同义反复。覆盖五类：delete_file 恒高危、只读/非命令工具非高危、黑名单命中高危、
// 全白名单且无黑名单非高危、白名单未命中（含 curl/wget/未知命令/空命令）兜底高危。

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { HighRiskGuard } from "../../src/executor/highRiskGuard.js";
import { SAFE_COMMAND_WHITELIST } from "../../src/config/config.js";
import type { ToolCall } from "../../src/executor/types.js";

const guard = new HighRiskGuard(); // 默认白名单 = SAFE_COMMAND_WHITELIST

/** 调用 id：内容无关被测逻辑，任意短串即可。 */
const idArb = fc.string({ maxLength: 8 });

/** 安全相对路径片段：仅 [a-z0-9_-]/`/`，绝不含黑名单 token。 */
const relPath = fc
  .array(
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-".split("")), {
        minLength: 1,
        maxLength: 6,
      })
      .map((cs) => cs.join("")),
    { minLength: 1, maxLength: 3 },
  )
  .map((segs) => segs.join("/"));

/** 安全参数：刻意挑选不含任何黑名单模式（rm/sudo/chmod/chown/dd/mkfs/>dev 等）的常见参数。 */
const safeArg = fc.constantFrom(
  "src/app.ts", "dist", "--watch", "-v", "status", "build", "test",
  "install", "package.json", "README.md", "lib/util.js", "-la", "node_modules", ".",
);

/** 组合命令连接符（含前后空格，更贴近真实；被测按 trim 处理）。 */
const connector = fc.constantFrom(" && ", " ; ", " | ", " || ");

/**
 * 白名单基础命令池：取自 SAFE_COMMAND_WHITELIST，剔除 `find`——`find` 虽在白名单内，
 * 但 `find -delete`/`find -exec` 属黑名单，单列到黑名单用例里另测，避免本池误判。
 */
const WHITELISTED = SAFE_COMMAND_WHITELIST.filter((c) => c !== "find");
const whitelistedCmd = fc.constantFrom(...WHITELISTED);

/** 单条"安全子命令" = 白名单主命令 + 可选安全参数。 */
const safeSub = fc
  .tuple(whitelistedCmd, fc.option(safeArg, { nil: undefined }))
  .map(([c, a]) => (a ? `${c} ${a}` : c));

/** 全白名单组合命令：1~3 条安全子命令按连接符拼接（主命令全部命中白名单 → 非高危）。 */
const safeCommandArb = fc
  .array(safeSub, { minLength: 1, maxLength: 3 })
  .chain((subs) =>
    fc
      .array(connector, { minLength: subs.length - 1, maxLength: subs.length - 1 })
      .map((conns) => subs.reduce((acc, s, i) => (i === 0 ? s : acc + conns[i - 1] + s), "")),
  );

/**
 * 高危黑名单命令集合：每条都至少命中 CMD_PATTERNS / run-shell 之一（→ 恒高危）。
 * 覆盖 rm、sudo、chmod、chown、运行 shell（sh/bash/zsh -c）、git force push（--force / -f）、
 * find -delete、find -exec、mkfs、dd、写设备节点（>/dev/）。
 */
const DANGEROUS = [
  "rm -rf dist",
  "rm file.txt",
  "sudo npm install",
  "chmod 777 src",
  "chown root:root file",
  "sh -c 'echo hi'",
  "bash -c ls",
  "zsh -c pwd",
  "git push origin main --force",
  "git push -f origin main",
  "find . -delete",
  "find . -name '*.ts' -exec rm {} ;",
  "mkfs.ext4 /dev/sda1",
  "dd if=/dev/zero of=/dev/sda",
  "echo data > /dev/sda",
] as const;
const dangerousCmd = fc.constantFrom(...DANGEROUS);

/**
 * 默认不在白名单内的命令（curl/wget 数据外泄通道，以及若干常见非白名单命令）。
 * 这些命令均不命中黑名单，故"高危"来自白名单兜底门（c）。
 */
const NON_WHITELISTED = ["curl", "wget", "telnet", "ssh", "scp", "nc", "ftp", "brew", "foobar", "mycli"] as const;
const nonWlSub = fc
  .tuple(fc.constantFrom(...NON_WHITELISTED), fc.option(safeArg, { nil: undefined }))
  .map(([c, a]) => (a ? `${c} ${a}` : c));

/** 兜底高危命令：单条非白名单子命令，或 安全子命令 + 连接符 + 非白名单子命令（任一不在白名单即高危）。 */
const fallbackCommandArb = fc.oneof(
  nonWlSub,
  fc.tuple(safeSub, connector, nonWlSub).map(([s, conn, f]) => `${s}${conn}${f}`),
);

type TaggedCase = { tc: ToolCall; expected: boolean };

/** (a) delete_file 恒高危（无论参数为何）。 */
const deleteFileCase = fc.tuple(idArb, relPath).map<TaggedCase>(([id, p]) => ({
  tc: { id, name: "delete_file", arguments: { path: p } },
  expected: true,
}));

/** 只读 / 非命令工具：非高危（不属 (a)/(b)/(c) 任一）。 */
const otherToolCase = fc
  .tuple(idArb, fc.constantFrom("read_file", "write_file", "list_dir"), relPath)
  .map<TaggedCase>(([id, name, p]) => ({
    tc: { id, name, arguments: { path: p } },
    expected: false,
  }));

/** (b) run_command 黑名单命中：高危。 */
const blacklistRunCase = fc.tuple(idArb, dangerousCmd).map<TaggedCase>(([id, command]) => ({
  tc: { id, name: "run_command", arguments: { command } },
  expected: true,
}));

/** 安全前缀 + 黑名单子命令：黑名单优先，仍高危（即便前缀主命令在白名单内）。 */
const mixedBlacklistCase = fc
  .tuple(idArb, safeSub, connector, dangerousCmd)
  .map<TaggedCase>(([id, pre, conn, danger]) => ({
    tc: { id, name: "run_command", arguments: { command: `${pre}${conn}${danger}` } },
    expected: true,
  }));

/** 全白名单且无黑名单：非高危。 */
const safeRunCase = fc.tuple(idArb, safeCommandArb).map<TaggedCase>(([id, command]) => ({
  tc: { id, name: "run_command", arguments: { command } },
  expected: false,
}));

/** (c) 白名单未命中兜底：高危（含 curl/wget/未知命令、以及含一个非白名单子命令的组合命令）。 */
const fallbackRunCase = fc.tuple(idArb, fallbackCommandArb).map<TaggedCase>(([id, command]) => ({
  tc: { id, name: "run_command", arguments: { command } },
  expected: true,
}));

/** 空命令 / 纯空白 / 缺 command 字段：拆分后无有效子命令 → 白名单兜底高危。 */
const emptyRunCase = fc.tuple(idArb, fc.constantFrom("", "   ", "MISSING")).map<TaggedCase>(([id, c]) => ({
  tc: { id, name: "run_command", arguments: c === "MISSING" ? {} : { command: c } },
  expected: true,
}));

const taggedCase: fc.Arbitrary<TaggedCase> = fc.oneof(
  deleteFileCase,
  otherToolCase,
  blacklistRunCase,
  mixedBlacklistCase,
  safeRunCase,
  fallbackRunCase,
  emptyRunCase,
);

describe("Property 17: 高危动作分类（黑名单 + 白名单兜底门）", () => {
  // 前置正确性自检：保证用例池构造语义成立（白名单/非白名单划分与生成器一致）。
  it("用例池前置不变量：find 已从白名单基础池剔除，非白名单命令确不在白名单内", () => {
    expect(WHITELISTED).not.toContain("find");
    for (const c of NON_WHITELISTED) {
      expect(SAFE_COMMAND_WHITELIST).not.toContain(c);
    }
  });

  it("isHighRisk 返回 true 当且仅当 delete_file / 黑名单命中 / 白名单兜底未命中", () => {
    fc.assert(
      fc.property(taggedCase, ({ tc, expected }) => {
        return guard.isHighRisk(tc) === expected;
      }),
      { numRuns: 100 },
    );
  });
});
