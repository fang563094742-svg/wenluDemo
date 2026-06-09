/**
 * 内置工具 `list_dir`（任务 11.10，R12.1 / R12.3 / R17.2）。
 *
 * 列出 sandbox 内某目录的直接子项。`riskClass: "safe"`（只读）。
 *
 * 安全自校验（防御性纵深，R12.2 / R12.4）：用注入的 `ctx.sandbox` 对目标目录做
 * `isInside` 越界校验——越界则拒绝并以 `ToolResult{ ok:false }` 回灌。
 *
 * 相对路径相对 `ctx.workingDirRoot` 解析；缺省 `path` 时列 sandbox 根。每个子项以
 * `name`（目录追加 `/` 标识）逐行输出，便于 LLM 直接消费。目录不存在 / 实为文件等
 * 作为可回灌的非致命错误返回 `ok:false`。
 *
 * _Requirements: 12.1, 12.3, 17.2_
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  Executor_Tool,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../types.js";

/** `list_dir` 的 LLM 工具声明（`path` 可选，缺省列 sandbox 根）。 */
const LIST_DIR_SPEC: ToolSpec = {
  name: "list_dir",
  description:
    "列出 Working_Directory（sandbox）内某目录的直接子项（文件与子目录）。path 可省略（默认列 sandbox 根），可为绝对或相对 sandbox 根的相对路径。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "待列出的目录路径（绝对或相对 sandbox 根）；省略则列 sandbox 根。",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * 内置 `list_dir` 工具实例。列出 sandbox 内目录的直接子项。
 */
export const listDirTool: Executor_Tool = {
  name: "list_dir",
  spec: LIST_DIR_SPEC,
  riskClass: "safe",

  async invoke(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawPath =
      typeof args.path === "string" && args.path.trim().length > 0
        ? args.path
        : ".";

    const target = path.resolve(ctx.workingDirRoot, rawPath);

    // 防御性纵深：目标目录的 sandbox 越界自校验（R12.2 / R12.4）。
    if (!ctx.sandbox.isInside(target)) {
      return {
        ok: false,
        output: "",
        error: `越界拒绝: ${rawPath} 不在 Working_Directory 内`,
      };
    }

    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return {
        ok: true,
        output: lines.length > 0 ? lines.join("\n") : "（空目录）",
      };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `列目录失败: ${(err as Error).message}`,
      };
    }
  },
};
