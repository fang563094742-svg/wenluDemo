/**
 * executorShared.ts — executor 与 concurrentExecutor 共享的函数、常量与接口。
 *
 * 独立提取以避免循环依赖。
 */

import type { Task_Frame } from "../clarifier/types.js";
import type { LLM_Provider, LlmMessage } from "../llm/llmProvider.js";
import type { Executor_Tool, ToolCall, ToolResult } from "./types.js";
import { HighRiskGuard } from "./highRiskGuard.js";

/** 执行循环步数硬上限。 */
export const MAX_STEPS = 50;

export const EXECUTOR_SYSTEM_PROMPT = [
  "你是问路（Wenlu）的执行器（Executor），在一个受限的工作目录（Working_Directory / sandbox）内真实地完成任务。",
  "硬性要求：",
  "1. 你必须通过提供的工具（read_file / write_file / list_dir / run_command / delete_file）真实地改动目标文件/目录，",
  "   而不是只给出计划、思路或代码文本——仅有计划或文本不算完成。",
  "2. 所有文件与命令操作必须限定在 Working_Directory 范围内；任何越界操作都会被安全门拦截并回灌错误。",
  '3. 优先对任务的主要操作对象（primaryTargets）执行实际更改；不要用无关的临时操作伪装"已落地"。',
  "4. 高危动作（删除文件、运行 shell、sudo、chmod、改权限、git force push、未知命令等）会暂停等待用户确认。",
  "5. 遇到可自行解决的小问题（如文件不存在、命令非零退出）应在后续步骤自行调整；只有真正无法推进的阻断性问题才需要向用户求助。",
  "当且仅当任务已真实落地完成时，停止调用工具并给出最终完成说明。",
].join("\n");

export interface ExecutorDeps {
  llm: LLM_Provider;
  tools?: readonly Executor_Tool[];
  highRiskGuard?: HighRiskGuard;
  maxSteps?: number;
}

export class BlockingError extends Error {
  readonly blocking = true as const;
  constructor(message: string) {
    super(message);
    this.name = "BlockingError";
  }
}

export function isBlocking(err: unknown): boolean {
  if (err instanceof BlockingError) return true;
  if (
    err !== null &&
    typeof err === "object" &&
    (err as { blocking?: unknown }).blocking === true
  ) {
    return true;
  }
  return false;
}

const SUMMARY_MAX_LEN = 300;

export function truncate(s: string, max = SUMMARY_MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断，共 ${s.length} 字符）`;
}

export function describe(tc: ToolCall): string {
  const cmd = tc.arguments?.command;
  if (tc.name === "run_command" && typeof cmd === "string") {
    return `run_command: ${truncate(cmd, 120)}`;
  }
  const p = tc.arguments?.path;
  if (typeof p === "string") return `${tc.name}: ${p}`;
  return `${tc.name}: ${truncate(JSON.stringify(tc.arguments ?? {}), 120)}`;
}

export function summarizeArgs(tc: ToolCall): string {
  return describe(tc);
}

export function summarizeResult(result: ToolResult): string {
  if (result.ok) return truncate(result.output || "成功");
  return truncate(result.error ?? result.output ?? "失败");
}

export function toolResultMessage(toolCallId: string, result: ToolResult): LlmMessage {
  return { role: "tool", content: JSON.stringify(result), toolCallId };
}

export function formatProblem(tc: ToolCall, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `执行「${describe(tc)}」时遇到无法自行解决的问题：${msg}。请提供进一步指示。`;
}

export function extractPaths(tc: ToolCall): string[] {
  const p = tc.arguments?.path;
  return typeof p === "string" && p.length > 0 ? [p] : [];
}

export function buildInitialContext(task: Task_Frame): LlmMessage[] {
  const lines: string[] = [];
  lines.push("# 待执行任务");
  lines.push(`目标（objective）：${task.objective}`);

  if (task.phases.length > 0) {
    lines.push("\n## 逻辑阶段");
    for (const p of [...task.phases].sort((a, b) => a.order - b.order)) {
      lines.push(`- (${p.order}) ${p.title}`);
    }
  }

  if (task.resolvedPreconditions.length > 0) {
    lines.push("\n## 已澄清的执行前提");
    for (const pc of task.resolvedPreconditions) {
      const val = pc.resolvedValue ?? pc.proposedDefault ?? "(未指定)";
      lines.push(`- ${pc.description}：${val}`);
    }
  }

  if (task.primaryTargets && task.primaryTargets.length > 0) {
    lines.push("\n## 主要操作对象（primaryTargets，必须对其真实落地改动）");
    for (const t of task.primaryTargets) lines.push(`- ${t}`);
  } else {
    lines.push(
      "\n## 主要操作对象\n（未指定具体目标；至少需有一个真实落地动作才算完成）",
    );
  }

  lines.push("\n## 验收测试（完成后将逐条强制运行，全部通过才算交付）");
  for (const at of task.acceptanceTests) {
    lines.push(`- [${at.id}] ${at.description} —— 检验方式：${at.checkMethod}`);
  }

  lines.push(
    "\n请在 Working_Directory（sandbox）内通过工具真实完成上述任务；完成后停止调用工具并给出完成说明。",
  );

  return [{ role: "user", content: lines.join("\n") }];
}
