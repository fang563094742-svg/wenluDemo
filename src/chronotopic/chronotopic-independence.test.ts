import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 时空校准层绝对独立性 · 静态断言测试（Task 7.1 — Property 11 独立性静态）
 *
 * 本测试用 node:fs 静态读取 `src/chronotopic/` 下的全部非测试源文件，对其内容做
 * 边界断言，确保时空层绝对独立于 3.1 / 3.2，且不新增 npm 运行时依赖。
 *
 * 关键实现说明：
 *   实现源文件的文档注释里会**字面提及**被禁 token（如 `@/lib/`、`node:sqlite`、
 *   `server-only`、`后端`、`3.1` / `3.2`）以记录边界约定。因此朴素的整文件子串扫描
 *   会产生假阳性。本测试先剥离块注释 / 行注释 / 字符串 / 模板字面量，仅对"真实代码"
 *   做断言；import / export 路径则单独抽取其模块说明符（specifier）逐条校验。
 *
 * 合法内部依赖说明：
 *   `chronotopic-signature.ts` 合法 `import "../scanner/types.js"`——这是弟弟内部
 *   既有的扫描层类型模块（弟弟内部相对路径），属于允许的内部依赖。
 *   `chronotopic-ece.ts` 合法 `import "../judgment/calibration.js"`——这是弟弟内部
 *   既有的判断力校准模块，ECE（设计 R9）复用其 `calibrationTable` 分桶，属于允许的
 *   弟弟内部依赖（非跨项目 / 非 3.1 / 非 3.2 引用）。断言逻辑允许 `node:crypto`、
 *   同目录 `./*` 相对导入，以及 `../scanner/*` / `../judgment/*` 这类弟弟内部相对路径，
 *   只禁止 3.1 / 3.2 / @别名 / server-only / node:sqlite / lib/wenlu 等跨项目引用。
 *   注意：独立性的实质约束（不碰 3.1 后端 / 3.2 / @别名 / server-only / node:sqlite）
 *   不被削弱——这些禁止项依然逐条断言。
 *
 * 绝对边界（本测试自身）：只 import vitest + node:fs / node:path / node:url。
 *
 * Validates: Requirements 14.4
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读取 src/chronotopic/ 下全部非测试 .ts 源文件。 */
function readChronotopicSources(): Array<{ file: string; code: string }> {
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
 * 返回仅含"真实代码"的文本（用于"代码中是否出现某 token"的检查）。
 *
 * import 的路径在字符串内，被替换后无法用于路径检查，所以路径检查走
 * extractImportSpecifiers；本函数产出用于 token 扫描（如 server-only / node:sqlite /
 * 后端），这些 token 不在注释 / 字符串里时才算违规。
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
      if (c === "\n") out += c; // 保留换行以维持行号语义
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
 * 抽取源码中所有 import / export ... from "specifier"、副作用 import "x" 与
 * 动态 import("x") 的模块说明符。仅扫描真实语句（注释里的不算）。
 */
function extractImportSpecifiers(src: string): string[] {
  const specifiers: string[] = [];
  const fromRe =
    /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  const sideRe = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [fromRe, sideRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      specifiers.push(m[1]);
    }
  }
  return specifiers;
}

/** 允许的裸包说明符白名单（时空层仅用 node:crypto）。 */
const ALLOWED_BARE_PACKAGES = new Set<string>(["node:crypto"]);

/**
 * 允许的弟弟内部相对路径前缀（除同目录 ./* 外的合法内部依赖）：
 *   - `../scanner/`：弟弟内部既有扫描层类型模块。
 *   - `../judgment/`：弟弟内部既有判断力校准模块；ECE（R9）复用其 calibrationTable
 *     分桶，属合法内部依赖，不是跨项目 / 3.1 / 3.2 引用。
 * 这些仅是"弟弟内部模块复用"的放行，独立性实质约束（禁 3.1 后端 / 3.2 / @别名 /
 * server-only / node:sqlite / lib/wenlu）在下方断言中保持不变。
 */
const ALLOWED_INTERNAL_RELATIVE_PREFIXES = ["../scanner/", "../judgment/"];

describe("时空校准层绝对独立性 · 静态断言 (Property 11)", () => {
  const sources = readChronotopicSources();

  it("能发现时空层源文件（非测试）", () => {
    expect(sources.length).toBeGreaterThan(0);
    const names = sources.map((s) => s.file);
    expect(names).toContain("index.ts");
    expect(names).toContain("chronotopic-signature.ts");
  });

  // ── Task 7.1: Property 11 独立性（静态） — Validates: Requirements 14.4 ──
  describe("Task 7.1 · 独立性 — Validates: Requirements 14.4", () => {
    for (const { file, code } of readChronotopicSources()) {
      const stripped = stripCommentsAndStrings(code);
      const specifiers = extractImportSpecifiers(code);

      it(`${file}: 真实代码不含 server-only / @/lib/ / node:sqlite / 后端 / 3.1 / 3.2`, () => {
        // 这些 token 只允许出现在注释 / 字符串中（文档约定），不允许出现在真实代码里。
        expect(stripped).not.toMatch(/\bserver-only\b/);
        expect(stripped).not.toMatch(/@\/lib\//);
        expect(stripped).not.toMatch(/node:sqlite/);
        expect(stripped).not.toMatch(/后端/);
        expect(stripped).not.toMatch(/3\.1|3\.2/);
        expect(stripped).not.toMatch(/lib\/wenlu/);
      });

      it(`${file}: 所有 import 路径均为 node:crypto / 同目录 ./* / ../scanner/* / ../judgment/*，无跨项目引用`, () => {
        for (const spec of specifiers) {
          // 不得引用 server-only / @/lib 别名 / node:sqlite
          expect(spec).not.toBe("server-only");
          expect(spec.startsWith("@/lib/")).toBe(false);
          expect(spec.startsWith("@/")).toBe(false);
          expect(spec).not.toBe("node:sqlite");

          // 不得包含跨项目路径迹象（3.1后端 / 3.2 / lib/wenlu 等）
          expect(spec).not.toMatch(/后端/);
          expect(spec).not.toMatch(/3\.1|3\.2/);
          expect(spec).not.toMatch(/lib\/wenlu/);

          const isNodeCrypto = ALLOWED_BARE_PACKAGES.has(spec);
          // 同目录相对导入：以 ./ 开头，且不含父目录跳转 ../
          const isSameDirRelative =
            spec.startsWith("./") && !spec.includes("../");
          // 弟弟内部相对路径（如 ../scanner/types.js、../judgment/calibration.js）——合法内部依赖
          const isAllowedInternalRelative =
            ALLOWED_INTERNAL_RELATIVE_PREFIXES.some((prefix) =>
              spec.startsWith(prefix),
            );

          expect(
            isNodeCrypto || isSameDirRelative || isAllowedInternalRelative,
            `非法 import 说明符 "${spec}"（仅允许 node:crypto / 同目录 ./* / ../scanner/* / ../judgment/* 内部相对导入）`,
          ).toBe(true);
        }
      });

      it(`${file}: 无新增 npm 运行时依赖（import 不含未知裸包名）`, () => {
        for (const spec of specifiers) {
          const isRelative = spec.startsWith("./") || spec.startsWith("../");
          if (isRelative) continue; // 相对路径不是裸包名

          // 非相对路径只能是白名单内的 node 内置（node:crypto）。
          // 任何其余裸包名（含 node: 内置之外的、第三方 npm 包）一律视为违规。
          expect(
            ALLOWED_BARE_PACKAGES.has(spec),
            `检测到未知裸包导入 "${spec}"（时空层仅允许 node:crypto，不得新增 npm 运行时依赖）`,
          ).toBe(true);
        }
      });
    }
  });
});
