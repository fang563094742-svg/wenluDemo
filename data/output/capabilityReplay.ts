#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";

interface StepResult {
  name: string;
  command: string;
  ok: boolean;
  code: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface CapabilityReplayReport {
  generatedAt: string;
  root: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  steps: StepResult[];
  conclusion: string[];
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "capability-replay");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-capability-replay.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-capability-replay.md");

const STEPS = [
  { name: "能力盘点刷新", command: "npm run capability:report" },
  { name: "学习线刷新", command: "npx tsx scripts/learningLine.ts" },
  { name: "遗忘模块邻近测试", command: "npx tsx tests/forgetting.test.ts" }
];

void main();

async function main() {
  const steps: StepResult[] = [];
  for (const step of STEPS) {
    steps.push(await runStep(step.name, step.command));
  }

  const passed = steps.filter((step) => step.ok).length;
  const failed = steps.length - passed;
  const report: CapabilityReplayReport = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    summary: {
      total: steps.length,
      passed,
      failed,
    },
    steps,
    conclusion: [
      failed === 0
        ? "本轮关键能力已被真实复跑：能力盘点、学习线汇总、邻近测试三条链都成功执行。"
        : "本轮存在失败步骤，但每一步都有命令、退出码和日志留痕，可直接定位卡点。",
      `证据文件固定输出到 ${relative(ROOT, MD_PATH)} 与 ${relative(ROOT, JSON_PATH)}，下一轮可直接复跑对比。`,
      "如需扩展覆盖面，可继续把 API 健康检查、probeProvider、更多 vitest 用例加入步骤列表。"
    ]
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(report), "utf8");

  console.log(`能力复跑证据已生成: ${relative(ROOT, MD_PATH)}`);
  if (failed > 0) process.exitCode = 1;
}

function runStep(name: string, command: string): Promise<StepResult> {
  const startedAt = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd: ROOT,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      resolveResult({
        name,
        command,
        ok: code === 0,
        code,
        durationMs: Date.now() - startedAt,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function renderMarkdown(report: CapabilityReplayReport): string {
  const lines: string[] = [];
  lines.push("# 能力复跑证据");
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 项目根目录：${report.root}`);
  lines.push(`- 通过情况：${report.summary.passed}/${report.summary.total} 通过，${report.summary.failed} 失败`);
  lines.push("");
  lines.push("## 步骤结果");
  lines.push("");

  for (const step of report.steps) {
    lines.push(`### ${step.name}`);
    lines.push(`- 命令：\`${step.command}\``);
    lines.push(`- 结果：${step.ok ? "PASS" : "FAIL"}（exit=${step.code ?? "null"}，${step.durationMs}ms）`);
    lines.push(`- stdout：`);
    lines.push("```text");
    lines.push(step.stdout || "<empty>");
    lines.push("```");
    if (step.stderr) {
      lines.push(`- stderr：`);
      lines.push("```text");
      lines.push(step.stderr);
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## 收口");
  lines.push("");
  for (const item of report.conclusion) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}
