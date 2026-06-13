import { DefaultRegistry, type Registry } from "../registry/registry.js";
import type { Executor_Tool, ToolSpec } from "./types.js";

import { readFileTool } from "./tools/readFile.js";
import { writeFileTool } from "./tools/writeFile.js";
import { listDirTool } from "./tools/listDir.js";
import { runCommandTool } from "./tools/runCommand.js";
import { deleteFileTool } from "./tools/deleteFile.js";
import { inspectNativeAppsTool } from "./tools/inspectNativeApps.js";
import { focusNativeAppTool } from "./tools/focusNativeApp.js";

export const BUILTIN_EXECUTOR_TOOLS: readonly Executor_Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  runCommandTool,
  deleteFileTool,
  inspectNativeAppsTool,
  focusNativeAppTool,
];

export function createToolRegistry(
  tools: readonly Executor_Tool[] = BUILTIN_EXECUTOR_TOOLS,
): Registry<Executor_Tool> {
  const registry = new DefaultRegistry<Executor_Tool>("ToolRegistry");
  for (const tool of tools) {
    registry.register(tool.name, tool);
  }
  return registry;
}

export function toolSpecs(
  tools: readonly Executor_Tool[] = BUILTIN_EXECUTOR_TOOLS,
): ToolSpec[] {
  return tools.map((t) => t.spec);
}
