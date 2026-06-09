/**
 * ToolRegistry 装配（任务 11.10，R12.3 / R17.2 / R17.3）。
 *
 * Executor_Tool 是三大可插拔点之一（与 Device_Scanner / LLM_Provider 并列），共享通用
 * `Registry<T>` 模式（见 `registry/registry.ts`）。本模块把第一版五个内置工具按 tool name
 * 注册到一个 `DefaultRegistry<Executor_Tool>`，供 Executor 执行循环（任务 11.11）以
 * `resolve(tc.name)` 解析、以工具声明 `ToolSpec[]` 喂给 LLM tool-calling。
 *
 * 解耦保证（R17.3）：新增/替换某个 Executor_Tool 实现只需在装配处 `register`，
 * 调用方仅依赖 `Registry<Executor_Tool>` 接口契约，无需改动。
 *
 * _Requirements: 12.1, 12.3, 17.2_
 */

import { DefaultRegistry, type Registry } from "../registry/registry.js";
import type { Executor_Tool, ToolSpec } from "./types.js";

import { readFileTool } from "./tools/readFile.js";
import { writeFileTool } from "./tools/writeFile.js";
import { listDirTool } from "./tools/listDir.js";
import { runCommandTool } from "./tools/runCommand.js";
import { deleteFileTool } from "./tools/deleteFile.js";

/**
 * 第一版内置工具集合（顺序仅影响诊断/声明列出顺序，不影响解析）。
 *
 * 注：`runCommandTool` 使用默认 `RUN_COMMAND_TIMEOUT_MS` 超时；若需自定义超时，
 * 改用 `createRunCommandTool(ms)` 构造后注册即可（R17.3 解耦）。
 */
export const BUILTIN_EXECUTOR_TOOLS: readonly Executor_Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  runCommandTool,
  deleteFileTool,
];

/**
 * 装配并返回内置 ToolRegistry：把内置工具按 `tool.name` 注册进通用注册表。
 *
 * @param tools 待注册的工具集合，默认 `BUILTIN_EXECUTOR_TOOLS`（注入便于测试/拓展）。
 * @returns 已注册全部工具的 `Registry<Executor_Tool>`（按 tool name 解析）。
 */
export function createToolRegistry(
  tools: readonly Executor_Tool[] = BUILTIN_EXECUTOR_TOOLS,
): Registry<Executor_Tool> {
  const registry = new DefaultRegistry<Executor_Tool>("ToolRegistry");
  for (const tool of tools) {
    registry.register(tool.name, tool);
  }
  return registry;
}

/**
 * 取一组工具的 LLM 工具声明（`ToolSpec[]`），喂给 `LLM_Provider.completeWithTools`。
 *
 * @param tools 工具集合，默认 `BUILTIN_EXECUTOR_TOOLS`。
 * @returns 各工具的 `ToolSpec` 列表。
 */
export function toolSpecs(
  tools: readonly Executor_Tool[] = BUILTIN_EXECUTOR_TOOLS,
): ToolSpec[] {
  return tools.map((t) => t.spec);
}
