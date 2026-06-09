/**
 * 符号链接逃逸拦截（任务 11.3，安全关键，R12.2）。
 *
 * `SandboxGuard.isInside` 已用 realpath 解析后判定越界，能拦截"经已存在软链
 * 指向外部"的读写；但它**无法阻止 Executor 在 sandbox 内新建一个指向外部的软链**——
 * 一旦软链被创建，后续对该软链的写入就会落到 sandbox 外（软链本身在内、realpath
 * 解析后指向外）。因此本模块作为纵深防御的第二道闸：在工具真正落盘/执行**之前**，
 * 对 tool call 做静态检测，命中即阻止并记录 `blocked`。
 *
 * 覆盖两类逃逸：
 *  - `write_file`：目标路径**已是**符号链接（用 `lstat` 判定、不跟随软链）→ 一律拒绝写入，
 *    无论该软链指向何处（防止借既有软链把写入透传到 sandbox 外）。
 *  - `run_command`：命令串含 `ln -s <src> <linkName>` 且**软链落点在 sandbox 内、
 *    源指向 sandbox 外** → 阻止（防止凭空造一条逃逸软链）。
 *
 * 设计取舍：本函数是**纯静态判定**（仅 `write_file` 的 lstat 触及文件系统以判断目标是否
 * 已是软链），不修改任何状态；越界软链的判定复用 `SandboxGuard.isInside`（realpath 解析）。
 * 返回非空字符串表示命中（应阻止并记录），返回 `null` 表示放行。
 *
 * _Requirements: 12.2_
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolCall } from "./types.js";
import type { SandboxGuard } from "./sandboxGuard.js";

/**
 * 检测并阻止符号链接逃逸（R12.2）。
 *
 * 判定规则（命中任一即返回描述性原因字符串）：
 *  1. `write_file` 且目标路径**已存在且为符号链接**（`fs.lstatSync(...).isSymbolicLink()`，
 *     不跟随软链）→ 拒绝写入。
 *  2. `run_command` 且命令含 `ln -s <src> <linkName>`，其创建的软链 `linkName`
 *     在 sandbox 内、而源 `src` 指向 sandbox 外（均经 `sandbox.isInside` 的 realpath
 *     判定）→ 阻止。
 *
 * 其余 tool call（包括正常的 `write_file`/`run_command`、`read_file`、`list_dir`、
 * `delete_file` 等）一律返回 `null` 放行——本函数只负责符号链接逃逸这一类，越界等
 * 其他防御由 `SandboxGuard.isInside` 与 High_Risk_Guard 各司其职。
 *
 * @param tc 待检测的工具调用（依据 `name` 与 `arguments` 中的 `path`/`command` 判定）。
 * @param sandbox 已对根做 realpath 规范化的越界校验器，用于判定 `ln -s` 越界。
 * @returns 命中时返回描述性原因（非空字符串，供记录与回灌 LLM）；未命中返回 `null`。
 */
export function detectSymlinkEscape(
  tc: ToolCall,
  sandbox: SandboxGuard,
): string | null {
  // write_file: 目标已是符号链接则拒绝（lstat 判定, 不跟随软链）
  if (tc.name === "write_file") {
    const target = path.resolve(String(tc.arguments.path ?? ""));
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      return `write_file 目标 ${target} 是符号链接，拒绝写入`;
    }
  }
  // run_command: 含 `ln -s` 且 软链在 sandbox 内、源指向 sandbox 外 → 阻止
  if (tc.name === "run_command") {
    const cmd = String(tc.arguments.command ?? "");
    const m = cmd.match(/\bln\s+-s\w*\s+(\S+)\s+(\S+)/); // ln -s <src> <linkName>
    if (m) {
      const [, src, linkName] = m;
      const linkInside = sandbox.isInside(linkName);
      const srcInside = sandbox.isInside(src);
      if (linkInside && !srcInside) {
        return `run_command 试图在 sandbox 内创建指向外部的软链: ${src} → ${linkName}`;
      }
    }
  }
  return null;
}
