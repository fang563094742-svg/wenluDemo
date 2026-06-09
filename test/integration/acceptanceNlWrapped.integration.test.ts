/**
 * Bug 5 端到端回归（真实文件系统临时 sandbox）：自然语言包裹的 Acceptance_Test 不再被高危门误拦。
 *
 * 背景（真实 GPT-5.4 端到端暴露）：执行器已真实落地正确的 README.md，但验收阶段三条
 * `Acceptance_Test.checkMethod` 全部失败——连最基础的 `test -f README.md` 都失败——导致状态
 * 机走到 `blocked_on_user`。根因三重：
 *   A) `classifyCheckMethod` 不解析「自然语言包裹」（命令在反引号内，外层是中文散文）；
 *   B) `isCommandWhitelisted` 裸分割会把 grep 正则里引号内的 `|` 错切；
 *   C) 白名单缺 `test`。
 *
 * 本集成测试用**真实文件系统临时目录**（`mkdtempSync`，不需真实网络/LLM），构造三种与真实
 * GPT-5.4 产出同形的自然语言包裹 checkMethod，并放好对应 README.md，跑
 * `DefaultDeliveryVerifier.runAcceptanceTests`；`hooks.confirmHighRisk` **恒 reject**。
 * 断言全部 passed——证明三处修复后这些验收命令不再被高危门误拦（恒 reject 的确认通道从不被触发）。
 *
 * 安全边界：所有检验仅在 `os.tmpdir()` 下的临时 sandbox 内只读执行，测试结束清理。
 *
 * _Requirements: 15.1, 12.5, 13.1, 13.2_
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefaultDeliveryVerifier } from "../../src/delivery/deliveryVerifier.js";
import type { ExecutionHooks, ExecutionProgressEvent } from "../../src/executor/types.js";
import type { Task_Frame } from "../../src/clarifier/types.js";

/** README.md 内容：同时满足三条验收检验（含 "Node 字符串工具" / slugify / truncate）。 */
const README_CONTENT = [
  "# Node 字符串工具",
  "",
  "一个轻量的 Node string utility，提供常用字符串处理函数。",
  "",
  "## API",
  "- `slugify(input)`：把任意字符串转为 URL 友好的 slug。",
  "- `truncate(input, n)`：把字符串截断到 n 个字符并追加省略号。",
  "",
].join("\n");

/** 三条与真实 GPT-5.4 sufficient 分支产出同形的「自然语言包裹」checkMethod。 */
const CHECK_METHODS = {
  testF: "运行 `test -f README.md` 并检查退出码为 0。",
  grep:
    "运行 `grep -Ei 'Node.*字符串工具|字符串工具.*Node|Node string utility|string utility.*Node' README.md && grep -F 'slugify' README.md && grep -F 'truncate' README.md` 并检查退出码为 0。",
  python: [
    "运行 `python3 - <<'PY'",
    "import sys",
    "data = open('README.md', encoding='utf-8').read()",
    "ok = ('slugify' in data) and ('truncate' in data) and ('字符串工具' in data)",
    "sys.exit(0 if ok else 1)",
    "PY` 并检查退出码为 0。",
  ].join("\n"),
};

function makeTaskFrame(): Task_Frame {
  return {
    awarenessItemId: "bug5-aw",
    objective: "在 sandbox 内生成 README.md（Node 字符串工具：slugify/truncate）",
    phases: [],
    resolvedPreconditions: [],
    confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
    acceptanceTests: [
      { id: "at-test-f", description: "README.md 存在", checkMethod: CHECK_METHODS.testF },
      {
        id: "at-grep",
        description: "README.md 含 Node 字符串工具/slugify/truncate",
        checkMethod: CHECK_METHODS.grep,
      },
      {
        id: "at-python",
        description: "README.md 内容经 python 脚本校验通过",
        checkMethod: CHECK_METHODS.python,
      },
    ],
    primaryTargets: ["README.md"],
  };
}

describe("Bug 5 端到端：自然语言包裹的 Acceptance_Test 全部通过（真实临时 sandbox）", () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-bug5-accept-"));
    // 执行器"已落地"的正确 README.md（满足三条验收）。
    fs.writeFileSync(path.join(sandboxDir, "README.md"), README_CONTENT, "utf8");
  });

  afterEach(() => {
    if (sandboxDir) fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("confirmHighRisk 恒 reject 下，三条 NL 包裹检验全部 passed（不再被高危门误拦）", async () => {
    const verifier = new DefaultDeliveryVerifier();

    let highRiskPrompts = 0;
    const progress: ExecutionProgressEvent[] = [];
    const hooks: ExecutionHooks = {
      // 关键：恒 reject。修复后这些命令非高危，故此通道**不应被触发**；一旦被触发即会令对应
      // 验收 failed（从而暴露"误判高危"的回归）。
      confirmHighRisk: () => {
        highRiskPrompts += 1;
        return Promise.resolve("reject");
      },
      askUser: () => Promise.resolve("继续"),
      emitProgress: (e) => progress.push(e),
    };

    const results = await verifier.runAcceptanceTests(
      makeTaskFrame(),
      { rootAbsPath: sandboxDir },
      hooks,
    );

    // 三条验收逐条 passed。
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.passed, `验收 ${r.testId} 应通过，detail=${r.detail}`).toBe(true);
    }

    // 高危确认通道从未被触发（命令均非高危，未走 confirmHighRisk）。
    expect(highRiskPrompts).toBe(0);
    // 也不应出现 high-risk-pending 进度事件。
    expect(progress.some((e) => e.kind === "high-risk-pending")).toBe(false);
  });

  it("buildReport 据三条全通过结果置 hasFailures=false", async () => {
    const verifier = new DefaultDeliveryVerifier();
    const taskFrame = makeTaskFrame();
    const results = await verifier.runAcceptanceTests(
      taskFrame,
      { rootAbsPath: sandboxDir },
      {
        confirmHighRisk: () => Promise.resolve("reject"),
        askUser: () => Promise.resolve("继续"),
        emitProgress: () => {},
      },
    );
    const report = await verifier.buildReport(
      taskFrame,
      { rootAbsPath: sandboxDir },
      undefined,
      { status: "completed", log: [] },
      results,
    );
    expect(report.hasFailures).toBe(false);
    expect(report.acceptanceTestResults).toHaveLength(3);
  });
});
