import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 河床绝对独立性 · 静态断言测试（Task 18.1 / 18.2）
 *
 * 本测试用 node:fs 静态读取 `src/riverbed/` 下的全部非测试源文件，
 * 对其内容做边界断言，确保河床绝对独立于 3.1 / 3.2，且无任何副作用来源。
 *
 * 关键实现说明：
 *   实现源文件的文档注释里会**字面提及**被禁 token（如 `@/lib/`、`node:sqlite`、
 *   `server-only`、`process.env`）以记录边界约定。因此朴素的整文件子串扫描会产生
 *   假阳性。本测试先剥离块注释 / 行注释 / 字符串字面量，仅对"真实代码"做断言；
 *   import / export 路径则单独抽取其模块说明符（specifier）逐条校验。
 *
 * 绝对边界（本测试自身）：只 import vitest + node:fs / node:path / node:url。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读取 src/riverbed/ 下全部非测试 .ts 源文件。 */
function readRiverbedSources(): Array<{ file: string; code: string }> {
  const entries = readdirSync(HERE, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts"),
    )
    .map((e) => ({
      file: e.name,
      code: readFileSync(join(HERE, e.name), "utf8"),
    }));
}

/**
 * 剥离 TypeScript 源码中的块注释、行注释与字符串 / 模板字面量，
 * 返回仅含"真实代码"的文本（保留 import 路径，因为它们是带引号的 specifier，
 * 我们用单独的抽取函数处理 import；这里把字符串内容替换为空串以消除假阳性）。
 *
 * 注意：import 的路径在字符串内，被替换后无法用于路径检查，所以路径检查走
 * extractImportSpecifiers；而本函数产出用于"代码中是否出现某 token"的检查
 * （如 process.env / child_process），这些 token 不在字符串里时才算违规。
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : "";

    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = "single";
        i += 1;
        continue;
      }
      if (c === '"') {
        mode = "double";
        i += 1;
        continue;
      }
      if (c === "`") {
        mode = "template";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      // 保留换行以维持行号语义（非必需，但更友好）
      if (c === "\n") out += c;
      i += 1;
      continue;
    }

    // 字符串 / 模板：跳过转义并消除内容
    if (mode === "single" || mode === "double" || mode === "template") {
      if (c === "\\") {
        i += 2; // 跳过转义字符
        continue;
      }
      if (
        (mode === "single" && c === "'") ||
        (mode === "double" && c === '"') ||
        (mode === "template" && c === "`")
      ) {
        mode = "code";
      }
      i += 1;
      continue;
    }
  }

  return out;
}

/**
 * 抽取源码中所有 import / export ... from "specifier" 与 import("specifier")
 * 的模块说明符。仅扫描真实的 import / export 语句（注释里的不算）。
 */
function extractImportSpecifiers(src: string): string[] {
  const specifiers: string[] = [];
  // import ... from "x" / export ... from "x"
  const fromRe =
    /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  // 副作用 import "x"
  const sideRe = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
  // 动态 import("x")
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [fromRe, sideRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      specifiers.push(m[1]);
    }
  }
  return specifiers;
}

/** 允许的包说明符白名单（裸包名，仅测试文件用到的也在此，源文件理论不用）。 */
const ALLOWED_BARE_PACKAGES = new Set<string>([
  "node:crypto",
]);

describe("河床绝对独立性 · 静态断言 (Property 11)", () => {
  const sources = readRiverbedSources();

  it("能发现河床源文件（非测试）", () => {
    expect(sources.length).toBeGreaterThan(0);
    // 至少包含核心模块
    const names = sources.map((s) => s.file);
    expect(names).toContain("index.ts");
    expect(names).toContain("domain-judgement-packet.ts");
  });

  // ── Task 18.1: Property 11 独立性（静态） — Validates: Requirements 14.4 ──
  describe("Task 18.1 · 独立性 — Validates: Requirements 14.4", () => {
    for (const { file, code } of readRiverbedSources()) {
      const stripped = stripCommentsAndStrings(code);
      const specifiers = extractImportSpecifiers(code);

      it(`${file}: 真实代码不含 server-only / @/lib/ / node:sqlite`, () => {
        // 这些 token 只允许出现在注释/字符串中（文档约定），不允许出现在真实代码里。
        expect(stripped).not.toMatch(/\bserver-only\b/);
        expect(stripped).not.toMatch(/@\/lib\//);
        expect(stripped).not.toMatch(/node:sqlite/);
      });

      it(`${file}: 所有 import 路径均为 node:crypto / 同目录相对 ./*，无 3.1/3.2 跨项目引用`, () => {
        for (const spec of specifiers) {
          // 不得引用 server-only / @/lib 别名 / node:sqlite
          expect(spec).not.toBe("server-only");
          expect(spec.startsWith("@/lib/")).toBe(false);
          expect(spec).not.toBe("node:sqlite");

          // 不得包含跨项目路径迹象（3.1后端 / 3.2 / lib/wenlu 等）
          expect(spec).not.toMatch(/后端/);
          expect(spec).not.toMatch(/3\.1|3\.2/);
          expect(spec).not.toMatch(/lib\/wenlu/);

          const isNodeCrypto = ALLOWED_BARE_PACKAGES.has(spec);
          // 同目录相对导入：以 ./ 开头，且不含父目录跳转 ../
          const isSameDirRelative =
            spec.startsWith("./") && !spec.includes("../");

          expect(
            isNodeCrypto || isSameDirRelative,
            `非法 import 说明符 "${spec}"（仅允许 node:crypto 或同目录 ./* 相对导入）`,
          ).toBe(true);
        }
      });
    }
  });

  // ── Task 18.2: 无副作用来源 — Requirements 14.1, 14.2, 14.3, 14.5, 14.7 ──
  describe("Task 18.2 · 无副作用来源 — Requirements 14.1, 14.2, 14.3, 14.5, 14.7", () => {
    for (const { file, code } of readRiverbedSources()) {
      const stripped = stripCommentsAndStrings(code);
      const specifiers = extractImportSpecifiers(code);

      it(`${file}: 不读取环境变量 (无 process.env) — Req 14.5/14.7`, () => {
        expect(stripped).not.toMatch(/\bprocess\s*\.\s*env\b/);
      });

      it(`${file}: 不执行命令 (无 child_process) — Req 14.5`, () => {
        expect(stripped).not.toMatch(/\bchild_process\b/);
        for (const spec of specifiers) {
          expect(spec).not.toBe("child_process");
          expect(spec).not.toBe("node:child_process");
        }
      });

      it(`${file}: 不开放网络端点 (无 net/http/express import) — Req 14.5`, () => {
        for (const spec of specifiers) {
          expect(spec).not.toBe("node:net");
          expect(spec).not.toBe("net");
          expect(spec).not.toBe("node:http");
          expect(spec).not.toBe("http");
          expect(spec).not.toBe("node:https");
          expect(spec).not.toBe("https");
          expect(spec).not.toBe("express");
        }
      });

      it(`${file}: 河床纯内存，不碰文件系统 (无 fs import) — Req 14.1/14.2/14.3`, () => {
        for (const spec of specifiers) {
          expect(spec).not.toBe("node:fs");
          expect(spec).not.toBe("fs");
          expect(spec).not.toBe("node:fs/promises");
          expect(spec).not.toBe("fs/promises");
        }
      });
    }
  });
});
