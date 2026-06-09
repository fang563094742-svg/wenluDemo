#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "capability-frontdesk");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-capability-frontdesk.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-capability-frontdesk.md");

interface CapabilityStep {
  id: string;
  title: string;
  command: string;
  proof: string[];
}

interface CapabilityStepRun extends CapabilityStep {
  status: "passed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
}

const STEPS: CapabilityStep[] = [
  {
    id: "capability-report",
    title: "刷新能力总表",
    command: "npm run capability:report",
    proof: [
      "task_output/capability-line/latest-capability-report.md",
      "task_output/capability-line/latest-capability-report.json"
    ]
  },
  {
    id: "learning-line",
    title: "刷新学习线验尸卡",
    command: "npm run learning:line",
    proof: [
      "task_output/learning-line/latest-learning-line.md",
      "task_output/learning-line/latest-learning-line.json"
    ]
  },
  {
    id: "tool-dominance",
    title: "刷新工具统治前台卡",
    command: "npx tsx data/output/toolDominanceLine.ts",
    proof: [
      "task_output/tool-dominance-line/latest-tool-dominance-frontdesk-card.md",
      "task_output/tool-dominance-line/latest-tool-dominance-run.json"
    ]
  }
];

void main();

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const runs: CapabilityStepRun[] = [];

  for (const step of STEPS) {
    runs.push(await runStep(step));
  }

  const passed = runs.filter((run) => run.status === "passed").length;
  const failed = runs.length - passed;
  const report = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    capabilityName: "capability:frontdesk",
    mission: "一条命令批量复跑核心能力链，并把用途、命令、证据前台化。",
    rerunCommand: "npm run capability:frontdesk",
    summary: `通过 ${passed}/${runs.length}，失败 ${failed}`,
    learned: [
      "把核心能力链压成单条命令，比逐个回忆脚本更稳定。",
      "每步都绑定命令与证据文件，才算真正可复跑。",
      "前台卡应直接回答：这条能力能干什么、怎么跑、跑完看哪里。"
    ],
    uses: [
      "开工前一键刷新当前能力面板。",
      "给主人显性汇报最新可复跑能力与证据。",
      "发现某条链失败时，快速定位是能力盘点、学习线还是统治线出问题。"
    ],
    runs
  };

  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(report), "utf8");
  console.log(`能力前台卡已生成: ${relative(ROOT, MD_PATH)}`);
}

async function runStep(step: CapabilityStep): Promise<CapabilityStepRun> {
  try {
    const { stdout, stderr } = await exec(step.command, { cwd: ROOT, maxBuffer: 1024 * 1024 * 8 });
    return { ...step, status: "passed", exitCode: 0, stdout: trim(stdout), stderr: trim(stderr) };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ...step,
      status: "failed",
      exitCode: failed.code ?? 1,
      stdout: trim(failed.stdout ?? ""),
      stderr: trim(failed.stderr ?? failed.message ?? "")
    };
  }
}

function trim(value: string): string {
  return value.trim().slice(0, 4000);
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(ROOT, relPath));
}

function renderMarkdown(report: {
  generatedAt: string;
  root: string;
  capabilityName: string;
  mission: string;
  rerunCommand: string;
  summary: string;
  learned: string[];
  uses: string[];
  runs: CapabilityStepRun[];
}): string {
  const lines: string[] = [];
  lines.push("# 能力前台卡");
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 项目根目录：${report.root}`);
  lines.push(`- 能力名：${report.capabilityName}`);
  lines.push(`- 任务：${report.mission}`);
  lines.push(`- 复跑命令：\`${report.rerunCommand}\``);
  lines.push(`- 汇总：${report.summary}`);
  lines.push("");
  lines.push("## 这条能力能干什么");
  lines.push("");
  for (const item of report.uses) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 本轮学到");
  lines.push("");
  for (const item of report.learned) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 复跑结果");
  lines.push("");
  for (const run of report.runs) {
    lines.push(`### ${run.title}`);
    lines.push(`- 命令：\`${run.command}\``);
    lines.push(`- 状态：${run.status.toUpperCase()}（exit=${run.exitCode}）`);
    lines.push(`- 证据：${run.proof.map((item) => fileExists(item) ? `\`${item}\`` : `\`${item}\`(缺失)`).join("、")}`);
    if (run.stdout) {
      lines.push("- stdout：");
      lines.push("```text");
      lines.push(run.stdout);
      lines.push("```");
    }
    if (run.stderr) {
      lines.push("- stderr：");
      lines.push("```text");
      lines.push(run.stderr);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
