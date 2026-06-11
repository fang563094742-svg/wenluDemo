/**
 * 认知核三段脊柱 · 焊接复用验证断言（任务 7.4，最高约束 · 不带 * · 不可跳过）
 * ------------------------------------------------------------------------------
 * 用 fs.readFileSync **只读** 扫描 `src/riverMain.ts` 源码字符串，断言三段脊柱的接线点
 * 复用既有引擎、而非重造同等功能。本测试**绝不修改** riverMain.ts（其他任务正在并行处理它），
 * 只新建本测试文件，仅做字符串/正则断言。
 *
 *  - 调度核落地走**既有** spawnTask：enforce 调度落地段调用 `spawnTask(line.goal)`，
 *    遍历 `plan.waves` 的每条 line；且落地段内**不自造并行执行器**
 *    （不写 Promise.all / new Worker / new Promise 执行循环）。
 *  - 输出核凝练文本最终经**既有出口** `emit({ kind: "say" })`；`condense` 接线段存在，
 *    且 dry-run 下逐字节沿用原 text（`output.status==="suppressed"` 时不替换）。
 *  - 方向分调既有 `inspectGoalMonitor`（输出核接线段构造 northStarGap 时调用），
 *    时机判定复用既有 prefrontal（`onSayToUser` 等）。
 *  - 认知核接线只从 barrel `./cognitive-core/index.js` 导入（不出现内部相对路径
 *    import 如 `./cognitive-core/plan-kernel.js`）。
 *    _Requirements: 7.2, 7.3, 7.4, 9.2_
 *
 * 绝对边界：本测试仅 import vitest / node:fs / node:path / node:url；
 * 绝不 import 被测实现、不 import 3.1/3.2 后端、不跑/不读后端任何文件。
 * 路径解析用 import.meta.url 推导，指向 src/riverMain.ts（相对本文件 ../../riverMain.ts）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本测试位于 src/cognitive-core/__tests__/；riverMain.ts 在 src/ 下 → ../../riverMain.ts
const testsDir = dirname(fileURLToPath(import.meta.url));
const riverMainPath = resolve(testsDir, "../../riverMain.ts");

/** 只读读取 riverMain.ts 源码（UTF-8），绝不写回。 */
function readRiverMain(): string {
  return readFileSync(riverMainPath, "utf8");
}

/** 仅剥离注释（保留字符串字面量），用于在"真实代码"上做模式匹配，避免注释里的描述误命中。 */
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

/** 提取所有 import/export ... from "X" 与 import "X" 的模块来源 X（在仅剥离注释的代码上跑）。 */
function extractImportSources(code: string): string[] {
  const sources: string[] = [];
  const patterns: RegExp[] = [
    /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) sources.push(m[1]);
  }
  return sources;
}

/**
 * 提取从 `markerStart` 锚点起、长度 windowChars 的源码窗口（在已剥离注释的代码上定位锚点
 * 不可行——锚点本身是注释，因此对 raw 源码定位 marker，但窗口内的模式匹配再各自 stripComments）。
 */
function sliceFrom(raw: string, markerStart: string, windowChars: number): string {
  const idx = raw.indexOf(markerStart);
  if (idx < 0) return "";
  return raw.slice(idx, idx + windowChars);
}

describe("认知核焊接复用验证断言（任务 7.4，最高约束 · 硬覆盖）", () => {
  it("能只读读取到 riverMain.ts 源码（防止扫描目标为空导致假通过）", () => {
    const src = readRiverMain();
    expect(src.length).toBeGreaterThan(1000);
    // 确认这是弟弟主文件（含三段脊柱 barrel 导入注释锚点）
    expect(src.includes("认知核三段脊柱")).toBe(true);
  });

  // ── 调度核落地走既有 spawnTask（R7.2）────────────────────────────────────
  it("调度核 enforce 落地段调用既有 spawnTask(line.goal) 并遍历 plan.waves", () => {
    const raw = readRiverMain();
    // 锚点：调度核落地注释段
    const block = sliceFrom(raw, "认知核·调度核落地", 1200);
    expect(block.length, "未找到调度核落地接线段锚点").toBeGreaterThan(0);
    const code = stripComments(block);
    // 复用既有 spawnTask：落地每条 line 调既有 spawnTask(line.goal)
    expect(
      /spawnTask\s*\(\s*line\.goal\s*\)/.test(code),
      "调度落地段应调用既有 spawnTask(line.goal)",
    ).toBe(true);
    // 遍历 DispatchPlan 的 waves（编排计划落地，不自造任务系统）
    expect(
      /for\s*\(\s*const\s+wave\s+of\s+plan\.waves\s*\)/.test(code),
      "调度落地段应遍历 plan.waves",
    ).toBe(true);
    // 计划来自既有 dispatchSafe，受 MAX_PARALLEL 约束（不重造调度器）
    expect(
      /dispatchSafe\s*\(\s*intent\s*,\s*\{\s*maxParallel:\s*MAX_PARALLEL\s*\}\s*\)/.test(code),
      "调度计划应由 dispatchSafe(intent,{maxParallel:MAX_PARALLEL}) 产出",
    ).toBe(true);
  });

  it("调度落地段不自造并行执行循环（无 Promise.all / new Worker / new Promise 执行器）", () => {
    const raw = readRiverMain();
    const block = sliceFrom(raw, "认知核·调度核落地", 1200);
    const code = stripComments(block);
    expect(/Promise\s*\.\s*all/.test(code), "调度落地段不应自造 Promise.all 并行执行器").toBe(false);
    expect(/new\s+Worker/.test(code), "调度落地段不应自造 Worker 执行器").toBe(false);
    expect(/new\s+Promise/.test(code), "调度落地段不应自造 new Promise 执行循环").toBe(false);
  });

  // ── 输出核凝练经既有 emit 出口 + dry-run 沿用原 text（R7.3 / R9.2）────────
  it("输出核接线段存在 condense 调用，且最终经既有出口 emit({kind:\"say\"})", () => {
    const raw = readRiverMain();
    const block = sliceFrom(raw, "认知核·输出核接线", 5200);
    expect(block.length, "未找到输出核接线段锚点").toBeGreaterThan(0);
    const code = stripComments(block);
    // condense 接线段存在
    expect(
      /\bcondense\s*\(/.test(code),
      "输出核接线段应调用既有 condense() 凝练",
    ).toBe(true);
    // 最终经既有唯一出口 emit({ kind: "say", ... })
    expect(
      /emit\s*\(\s*\{\s*kind:\s*["']say["']/.test(code),
      "凝练文本最终应经既有出口 emit({kind:\"say\"})",
    ).toBe(true);
  });

  it("dry-run 下逐字节沿用原 text：suppressed 时不替换，仅 enforce 采用凝练文本", () => {
    const raw = readRiverMain();
    const block = sliceFrom(raw, "认知核·输出核接线", 5200);
    const code = stripComments(block);
    // 初始 outText = text（红线：缺省沿用原文）
    expect(
      /outText\s*=\s*text/.test(code),
      "输出核接线段应以 outText = text 作为逐字节沿用原文的兜底",
    ).toBe(true);
    // 仅 enforce 且非 suppressed 才替换为凝练文本
    expect(
      /mode\s*===\s*["']enforce["']/.test(code) &&
        /output\.status\s*!==\s*["']suppressed["']/.test(code),
      "仅 enforce 且 output.status!=='suppressed' 时才采用凝练后的 text",
    ).toBe(true);
  });

  // ── 方向分调既有 inspectGoalMonitor + 时机复用既有 prefrontal（R7.3 / R9.2）──
  it("输出核接线段构造 northStarGap 时调用既有 inspectGoalMonitor", () => {
    const raw = readRiverMain();
    const block = sliceFrom(raw, "认知核·输出核接线", 5200);
    const code = stripComments(block);
    expect(
      /inspectGoalMonitor\s*\(/.test(code),
      "输出核接线段应调用既有 inspectGoalMonitor 计算方向差距",
    ).toBe(true);
    expect(
      /northStarGap/.test(code),
      "输出核接线段应据差距信号构造 northStarGap 传入 OutputContext",
    ).toBe(true);
  });

  it("say 路径时机判定复用既有 prefrontal（onSayToUser 落地记录）", () => {
    const raw = readRiverMain();
    const code = stripComments(raw);
    // onSayToUser 从既有 prefrontal 模块导入
    expect(
      /import\s*\{[^}]*\bonSayToUser\b[^}]*\}\s*from\s*["']\.\/prefrontal[^"']*["']/.test(code),
      "onSayToUser 应从既有 ./prefrontal 模块导入（复用时机肌肉）",
    ).toBe(true);
    // say 落地后调用既有 onSayToUser 记录时机
    expect(
      /onSayToUser\s*\(/.test(code),
      "say 路径应调用既有 onSayToUser 记录对用户说话的时机",
    ).toBe(true);
  });

  // ── 认知核接线只从 barrel ./cognitive-core/index.js 导入（R9.2）───────────
  it("cognitive-core 接线只从 barrel index.js 导入，无内部相对路径 import", () => {
    const raw = readRiverMain();
    const code = stripComments(raw);
    const cogSources = extractImportSources(code).filter((s) => s.includes("cognitive-core"));
    // 至少存在一处 cognitive-core 导入（接线确实接上了）
    expect(cogSources.length, "应至少从 cognitive-core 导入一次（接线存在）").toBeGreaterThan(0);
    for (const src of cogSources) {
      expect(
        src === "./cognitive-core/index.js",
        `cognitive-core 接线只能从 barrel "./cognitive-core/index.js" 导入，发现内部相对路径："${src}"`,
      ).toBe(true);
    }
    // 双保险：不出现任何具体内部模块文件名的相对 import
    expect(
      /["']\.\/cognitive-core\/(plan-kernel|dispatch-kernel|output-kernel|cognitive-config|cognitive-registry|types|models)\.js["']/.test(
        code,
      ),
      "不应出现 cognitive-core 内部模块的相对路径 import",
    ).toBe(false);
  });
});
