/**
 * 独立性静态断言 + barrel 契约 — P10（最高约束·不可跳过）
 * Validates: Requirements 7.1, 6.4
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as SF from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "__tests__") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function imports(code: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

describe("skill-flywheel 独立性静态断言 (P10, Req 7.1)", () => {
  const files = listTs(srcDir);
  it("能扫到源码文件", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
  it("无禁用 import、不反向 import riverMain、仅相对(.js)/node:crypto/既有 barrel", () => {
    for (const f of files) {
      const code = strip(readFileSync(f, "utf8"));
      expect(/3\.1后端|3\.2后端|\/3\.2\//.test(code), `${f} 含 3.1/3.2`).toBe(false);
      expect(/["']server-only["']/.test(code), `${f} server-only`).toBe(false);
      expect(/["']node:sqlite["']/.test(code), `${f} node:sqlite`).toBe(false);
      expect(/["']@\/lib/.test(code), `${f} @/lib`).toBe(false);
      expect(/riverMain/.test(code), `${f} 反向 import riverMain`).toBe(false);
      for (const src of imports(code)) {
        const ok =
          src === "node:crypto" ||
          (src.startsWith(".") && src.endsWith(".js")) ||
          src === "../execution-kernel/index.js";
        expect(ok, `${f} 非法 import: ${src}`).toBe(true);
      }
    }
  });
});

describe("skill-flywheel barrel 契约 (Req 6.4)", () => {
  it("导出预期公共符号", () => {
    for (const n of [
      "DEFAULT_FLYWHEEL", "resolveFlywheelConfig",
      "newSkillId", "scanResidualPrivacy", "skillMatches", "isReshareReady",
      "emptyKB", "addSkill", "reputationOf", "searchSkills", "recordSkillOutcome",
      "routeTask",
      "distillSkill",
    ]) {
      expect((SF as Record<string, unknown>)[n], n).toBeDefined();
    }
  });
});
