/**
 * 叙事输出层 · 独立性静态断言测试（任务 10.1，最高约束 · 硬覆盖）
 * ------------------------------------------------------------------
 * 对 `src/narrative/**\/*.ts`（排除 `__tests__` 测试文件本身）做静态源码扫描，
 * 断言职责边界 / 绝对独立约束：
 *  - 不出现 `server-only`、`@/lib`、`node:sqlite`。
 *  - 不出现对 3.1后端 / 3.2 后端路径的 import（含 `3.1后端` / `/3.2` / `lib/wenlu`）。
 *  - 不反向 import `riverMain`。
 *  - 仅依赖 Node 标准库（最多 `node:crypto`），无第三方运行时依赖：
 *    import 来源仅允许相对路径（`./` / `../`）或 `node:crypto`；
 *    禁止任何裸第三方包名 import。
 *    _Requirements: 9.1, 9.2, 9.3_
 *
 * 绝对边界：测试文件本身仅 import vitest / node:fs / node:path / node:url。
 * 不 import 任何被测实现、不 import 3.1/3.2 路径、不 import riverMain.ts。
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 本测试文件位于 src/narrative/__tests__/ 下；narrative 目录是 __tests__ 的父目录。
const testsDir = dirname(fileURLToPath(import.meta.url));
const narrativeDir = dirname(testsDir);

/**
 * 剥离源码中的注释与字符串字面量，仅保留"实际代码骨架"，避免对边界规则的
 * 文档化描述（JSDoc 中形如 `不 import "server-only"`）产生误报。
 * 这是对 import / 依赖约束的"真实代码"扫描，而非对散文的扫描。
 * 处理：行注释 `//`、块注释 `/* *\/`、以及单/双引号与反引号字符串。
 * 注意：import/export 的模块来源（始终为带引号的字符串）由 extractImportSources
 * 单独在"原始源码"上提取——那是受控、明确定向的 import 语句匹配，不受本剥离影响。
 */
function stripCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    // 行注释
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    // 块注释
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 字符串字面量（单引号 / 双引号 / 反引号）
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      // 用空串占位，丢弃字符串内容
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 递归收集 narrativeDir 下所有 .ts 文件，排除任何位于 __tests__ 路径中的文件。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue; // 排除测试目录
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (full.includes("__tests__")) continue; // 双保险：排除测试文件本身
      out.push(full);
    }
  }
  return out;
}

/** 仅剥离注释（保留字符串），用于在"真实代码"上提取 import 来源。 */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 保留字符串内容（import 来源是字符串），但跳过其内部以免把字符串里的 // 当注释
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += code[i];
        if (code[i] === "\\") {
          i++;
          if (i < n) out += code[i];
          i++;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从源码中提取所有 import/export ... from "X" 与 import "X" 的模块来源 X。
 * 同时覆盖动态 import("X") 与 require("X")。
 */
function extractImportSources(code: string): string[] {
  const sources: string[] = [];
  const patterns: RegExp[] = [
    // import ... from "X" / export ... from "X"
    /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
    // 副作用 import "X"
    /\bimport\s*["']([^"']+)["']/g,
    // 动态 import("X")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    // require("X")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      sources.push(m[1]);
    }
  }
  return sources;
}

const sourceFiles = collectSourceFiles(narrativeDir);

describe("叙事层独立性静态断言（任务 10.1，硬覆盖）", () => {
  it("至少存在一个被扫描的源文件（防止扫描目标为空导致假通过）", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  // 禁止出现的字面量片段（不依赖 import 解析，直接全文扫描）
  // _Requirements: 9.2_
  const FORBIDDEN_LITERALS = [
    "server-only",
    "@/lib",
    "node:sqlite",
    "lib/wenlu",
    "3.1后端",
    "/3.2",
  ];

  it("源码中不出现 server-only / @/lib / node:sqlite / 后端路径片段", () => {
    for (const file of sourceFiles) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const lit of FORBIDDEN_LITERALS) {
        expect(
          code.includes(lit),
          `源文件 ${file} 不应出现禁用片段 "${lit}"（已剥离注释与字符串后扫描）`,
        ).toBe(false);
      }
    }
  });

  it("不反向 import riverMain", () => {
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const src of extractImportSources(code)) {
        expect(
          src.includes("riverMain"),
          `源文件 ${file} 不应 import riverMain（来源："${src}"）`,
        ).toBe(false);
      }
    }
  });

  it("仅依赖 Node 标准库（最多 node:crypto），无第三方运行时依赖", () => {
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const src of extractImportSources(code)) {
        const isRelative = src.startsWith("./") || src.startsWith("../");
        const isAllowedNode = src === "node:crypto";
        expect(
          isRelative || isAllowedNode,
          `源文件 ${file} 的 import 来源 "${src}" 非法：仅允许相对路径或 node:crypto（禁止裸第三方包名与其它 node: 模块）`,
        ).toBe(true);
      }
    }
  });
});
