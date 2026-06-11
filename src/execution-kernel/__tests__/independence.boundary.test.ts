/**
 * 独立性静态断言 — Task 8.1（最高约束·不可跳过）
 * P13 独立性：扫描 src/execution-kernel/** 全部源码，断言：
 *  - 不含 3.1后端/3.2 路径 import；不含 server-only / node:sqlite / @/lib
 *  - 不反向 import riverMain.ts
 *  - 仅相对导入（带 .js）或 node:crypto
 *  - 跨模块引用只经对应 barrel（cognitive-core/index.js）
 * Validates: Requirements 7.1
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, ".."); // src/execution-kernel

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "__tests__") continue; // 只扫源码，不扫测试
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importSources(code: string): string[] {
  const srcs: string[] = [];
  const patterns = [
    /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) srcs.push(m[1]);
  }
  return srcs;
}

describe("execution-kernel 独立性静态断言 (P13, Req 7.1)", () => {
  const files = listTsFiles(srcDir);

  it("能扫到源码文件（防空目标假通过）", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("所有源码：无禁用 import，仅相对(.js)/node:crypto，不反向 import riverMain", () => {
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      const code = stripComments(raw);

      expect(/3\.1后端|3\.1\/|\/3\.2\/|3\.2后端/.test(code), `${f} 含 3.1/3.2 路径`).toBe(false);
      expect(/["']server-only["']/.test(code), `${f} 含 server-only`).toBe(false);
      expect(/["']node:sqlite["']/.test(code), `${f} 含 node:sqlite`).toBe(false);
      expect(/["']@\/lib/.test(code), `${f} 含 @/lib 别名`).toBe(false);
      expect(/riverMain/.test(code), `${f} 反向引用 riverMain`).toBe(false);

      for (const src of importSources(code)) {
        const ok = src === "node:crypto" || (src.startsWith(".") && src.endsWith(".js"));
        expect(ok, `${f} 非法 import 源: "${src}"`).toBe(true);
      }
    }
  });

  it("跨模块引用只经对应 barrel（cognitive-core/index.js），不深入内部相对路径", () => {
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      const cc = importSources(code).filter((s) => s.includes("cognitive-core"));
      for (const s of cc) {
        expect(s, `${f} 应只从 cognitive-core barrel 导入，发现: ${s}`).toBe("../cognitive-core/index.js");
      }
    }
  });
});
