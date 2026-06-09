/**
 * 任务 11.14：Executor tool-calling 循环集成测试（vitest，非 property）。
 *
 * 被测：`src/executor/executor.ts` 的 `runLoop`——由 LLM tool-calling 循环驱动**真实执行**，
 * 在 Working_Directory（sandbox）内通过内置工具真实落地（写文件、跑命令）（R12.1）。
 *
 * 本测试按 design「外部/编排依赖，用集成测试」处理：用一个 **scripted mock LLM_Provider**
 * （`completeWithTools` 返回真实的 tool calls 序列：write_file → run_command(cat) → finalText），
 * 配合**真实内置工具**与一个建于 `os.tmpdir()` 下的**真实 sandbox**，断言：
 *  1. 循环真实调用工具在 sandbox 内落地——文件真的被创建且内容正确（不是只给计划/文本）。
 *  2. run_command 真的把文件内容读回（cat 输出含写入内容），证明工具确有副作用与可观测结果。
 *  3. 最终判定 `completed`（hasMaterializedRelevantActions 命中 primaryTargets）。
 *  4. 顺带验证 `emitProgress` 推送了成对的 `tool-start` / `tool-result` 事件，且 status 为 `ok`。
 *
 * 安全边界：所有落地操作均发生在 `os.tmpdir()` 下的临时 sandbox 内，测试结束清理；
 * 绝不触及项目目录外的用户真实路径。`cat` 在 `SAFE_COMMAND_WHITELIST` 内、非高危，
 * 因此循环不应触发任何高危确认或阻断性提问（用断言守护）。
 *
 * _Requirements: 12.1_
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runLoop } from "../../src/executor/executor.js";
import type {
  ExecutionHooks,
  ExecutionProgressEvent,
} from "../../src/executor/types.js";
import type {
  LLM_Provider,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type { Task_Frame } from "../../src/clarifier/types.js";

/**
 * Scripted mock LLM_Provider：忽略对话内容，按固定脚本逐步返回 tool-calling 响应。
 * 每次 `completeWithTools` 取脚本下一项；超出脚本长度则沿用最后一项（finalText 完成信号）。
 */
class ScriptedLlm implements LLM_Provider {
  readonly providerKey = "mock-scripted";
  private step = 0;
  readonly toolRequests: LlmToolRequest[] = [];

  constructor(private readonly script: LlmToolResponse[]) {}

  complete(): Promise<LlmResponse> {
    return Promise.reject(new Error("complete 不应被 Executor 执行循环调用"));
  }

  completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    this.toolRequests.push(req);
    const idx = Math.min(this.step, this.script.length - 1);
    this.step += 1;
    return Promise.resolve(this.script[idx]);
  }
}

/** 写入文件的目标内容，作为“文件真的被创建/内容正确”的断言锚点。 */
const FILE_CONTENT = "hello wenlu — 执行循环真实落地验证 0xCAFE";
const TARGET_REL = "output.txt";

/** 构造一个最小可执行的 Task_Frame，primaryTargets 指向待落地文件以触发相关性校验。 */
function makeTaskFrame(): Task_Frame {
  return {
    awarenessItemId: "aw-1",
    objective: `在 sandbox 内创建 ${TARGET_REL} 并写入约定内容，再读回校验`,
    phases: [],
    resolvedPreconditions: [],
    confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
    acceptanceTests: [
      {
        id: "at-1",
        description: `${TARGET_REL} 存在且内容正确`,
        checkMethod: `cat ${TARGET_REL} 输出包含约定内容`,
      },
    ],
    primaryTargets: [TARGET_REL],
  };
}

describe("任务 11.14：Executor tool-calling 循环集成测试（真实工具 + 临时 sandbox）", () => {
  let sandboxDir: string;

  beforeEach(() => {
    // 真实 sandbox：os.tmpdir() 下的临时目录，绝不触及项目外用户真实路径。
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-exec-loop-"));
  });

  afterEach(() => {
    if (sandboxDir) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("mock LLM 串联 write_file→run_command(cat)→finalText：文件真实落地、读回正确、判定 completed", async () => {
    // 脚本：1) write_file 写文件 → 2) run_command cat 读回 → 3) finalText 声称完成。
    const llm = new ScriptedLlm([
      {
        toolCalls: [
          {
            id: "tc-write",
            name: "write_file",
            arguments: { path: TARGET_REL, content: FILE_CONTENT },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-cat",
            name: "run_command",
            arguments: { command: `cat ${TARGET_REL}` },
          },
        ],
      },
      { finalText: `已创建并写入 ${TARGET_REL}，内容校验通过。` },
    ]);

    const events: ExecutionProgressEvent[] = [];
    let highRiskCalls = 0;
    let askUserCalls = 0;
    const hooks: ExecutionHooks = {
      confirmHighRisk: () => {
        highRiskCalls += 1;
        return Promise.resolve("confirm");
      },
      askUser: () => {
        askUserCalls += 1;
        return Promise.resolve("继续");
      },
      emitProgress: (event) => {
        events.push(event);
      },
    };

    const result = await runLoop(
      makeTaskFrame(),
      { rootAbsPath: sandboxDir },
      hooks,
      { llm },
    );

    // 1) 最终判定 completed。
    expect(result.status).toBe("completed");
    expect(result.finalText).toContain(TARGET_REL);

    // 2) 文件真的被创建且内容正确（真实落地，不是只给计划/文本）。
    const writtenPath = path.join(sandboxDir, TARGET_REL);
    expect(fs.existsSync(writtenPath)).toBe(true);
    expect(fs.readFileSync(writtenPath, "utf8")).toBe(FILE_CONTENT);

    // 3) write_file 与 run_command 均真实执行且成功（落地记录可回溯）。
    const writeInv = result.log.find((inv) => inv.tc.name === "write_file");
    const cmdInv = result.log.find((inv) => inv.tc.name === "run_command");
    expect(writeInv?.result.ok).toBe(true);
    expect(writeInv?.blocked).toBeFalsy();
    expect(cmdInv?.result.ok).toBe(true);
    // run_command 真的把文件内容读回（cat 输出含写入内容）。
    expect(cmdInv?.result.output).toContain(FILE_CONTENT);

    // 4) emitProgress 推送了成对的 tool-start / tool-result，且 status 为 ok。
    const startTools = events
      .filter((e) => e.kind === "tool-start")
      .map((e) => (e as { tool: string }).tool);
    expect(startTools).toContain("write_file");
    expect(startTools).toContain("run_command");

    const resultEvents = events.filter((e) => e.kind === "tool-result") as Array<{
      kind: "tool-result";
      tool: string;
      status: "ok" | "failed" | "blocked" | "skipped";
      resultSummary: string;
    }>;
    const writeResultEvent = resultEvents.find((e) => e.tool === "write_file");
    const cmdResultEvent = resultEvents.find((e) => e.tool === "run_command");
    expect(writeResultEvent?.status).toBe("ok");
    expect(cmdResultEvent?.status).toBe("ok");

    // cat 在白名单内、非高危：循环不应触发高危确认或阻断性提问。
    expect(highRiskCalls).toBe(0);
    expect(askUserCalls).toBe(0);

    // 循环确实经过 tool-calling 决策（至少 3 次：write / cat / 完成）。
    expect(llm.toolRequests.length).toBeGreaterThanOrEqual(3);
  });
});
