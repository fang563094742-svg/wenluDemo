#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "control-surface-verifier");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-control-surface-verification.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-control-surface-verification.md");

interface CheckSpec {
  id: string;
  title: string;
  command: string;
  proves: string;
}

interface CheckResult extends CheckSpec {
  ok: boolean;
  signal: string;
}

const CHECKS: CheckSpec[] = [
  {
    id: "codex-cli",
    title: "Codex CLI 可调用",
    command: "codex --help >/dev/null",
    proves: "主执行器 CLI 存在"
  },
  {
    id: "kiro-cli",
    title: "Kiro CLI 可调用",
    command: "kiro --help >/dev/null",
    proves: "辅助编辑器 CLI 存在"
  },
  {
    id: "claude-app",
    title: "Claude 应用可拉起",
    command: "open -a Claude",
    proves: "备用对话脑可前台化"
  },
  {
    id: "safari-driver",
    title: "Safari WebDriver 可调用",
    command: "safaridriver --version >/dev/null",
    proves: "浏览器自动化入口存在"
  },
  {
    id: "chrome-activate",
    title: "Chrome 可前台激活",
    command: "osascript -e 'tell application \"Google Chrome\" to activate'",
    proves: "浏览器备胎可调起"
  },
  {
    id: "surface-artifact",
    title: "控制面产物可落盘",
    command: "test -f task_output/tool-dominance-line/latest-executor-control-surface.json",
    proves: "执行者可控面已有最新证据文件"
  },
  {
    id: "frontdesk-artifact",
    title: "前台卡产物可落盘",
    command: "test -f task_output/capability-frontdesk/latest-capability-frontdesk.json",
    proves: "能力前台卡已有最新证据文件"
  }
];

void main();

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    results.push(await runCheck(check));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mission: "把当前工具/应用控制面压成客观可复跑的验真卡，避免只凭主观口头判断。",
    rerunCommand: "npx tsx scripts/controlSurfaceVerifier.ts",
    passed: results.filter((item) => item.ok).length,
    total: results.length,
    results
  };

  await writeFile(JSON_PATH, JSON.stringify(summary, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(summary), "utf8");
  console.log(`控制面验真卡已生成: ${relative(ROOT, MD_PATH)}`);
}

async function runCheck(check: CheckSpec): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await exec(check.command, {
      cwd: ROOT,
      shell: "/bin/zsh",
      maxBuffer: 1024 * 1024 * 4
    });
    const signal = firstSignal(stdout, stderr, "OK");
    return { ...check, ok: true, signal };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const signal = firstSignal(failed.stdout, failed.stderr, failed.message ?? "FAILED");
    return { ...check, ok: false, signal };
  }
}

function firstSignal(...parts: Array<string | undefined>): string {
  for (const part of parts) {
    const line = part?.split("\n").map((item) => item.trim()).find(Boolean);
    if (line) return line;
  }
  return "OK";
}

function renderMarkdown(summary: {
  generatedAt: string;
  mission: string;
  rerunCommand: string;
  passed: number;
  total: number;
  results: CheckResult[];
}): string {
  const lines: string[] = [];
  lines.push("# 控制面验真卡", "");
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(`- 任务：${summary.mission}`);
  lines.push(`- 复跑命令：\`${summary.rerunCommand}\``);
  lines.push(`- 通过率：${summary.passed}/${summary.total}`);
  lines.push("");
  lines.push("## 验真结果", "");

  for (const result of summary.results) {
    lines.push(`- [${result.ok ? "PASS" : "FAIL"}] ${result.title}｜证明：${result.proves}｜信号：${result.signal}`);
  }

  lines.push("", "## 证据文件", "");
  if (existsSync(resolve(ROOT, "task_output/tool-dominance-line/latest-executor-control-surface.json"))) {
    lines.push("- task_output/tool-dominance-line/latest-executor-control-surface.json");
  }
  if (existsSync(resolve(ROOT, "task_output/capability-frontdesk/latest-capability-frontdesk.json"))) {
    lines.push("- task_output/capability-frontdesk/latest-capability-frontdesk.json");
  }
  return lines.join("\n");
}
