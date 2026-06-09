#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "tool-dominance-line");
const DATA_DIR = resolve(ROOT, "data", "capability-line");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-tool-dominance-run.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-tool-dominance-frontdesk-card.md");

interface StepResult {
  id: string;
  title: string;
  command: string;
  status: "passed" | "failed";
  stdout: string;
  stderr: string;
  outputFiles: string[];
  autopsy: string[];
}

interface DominanceRun {
  generatedAt: string;
  mission: string;
  rerunCommand: string;
  steps: StepResult[];
  autopsyChain: string[];
  frontdeskRules: string[];
  proofBundle: string[];
  nextActions: string[];
}

const STEPS: Array<Pick<StepResult, "id" | "title" | "command" | "outputFiles">> = [
  {
    id: "capability-report",
    title: "刷新可复跑能力总表",
    command: "npm run capability:report",
    outputFiles: [
      "task_output/capability-line/latest-capability-report.md",
      "task_output/capability-line/latest-capability-report.json",
      "data/capability-line/capability-methods.json"
    ]
  },
  {
    id: "learning-line",
    title: "刷新验尸链与复跑检查清单",
    command: "npx tsx scripts/learningLine.ts",
    outputFiles: [
      "task_output/learning-line/latest-learning-line.md",
      "task_output/learning-line/latest-learning-line.json",
      "data/capability-line/learning-line.json"
    ]
  },
  {
    id: "response-strategy",
    title: "刷新阻塞识别与收口法源",
    command: "npx tsx scripts/responseStrategyLine.ts",
    outputFiles: [
      "task_output/response-strategy-line/latest-response-strategy-line.md",
      "data/capability-line/response-strategy-line.json"
    ]
  },
  {
    id: "tool-judgment",
    title: "刷新四类对象现行判词法源",
    command: "npm run tool:judgment",
    outputFiles: [
      "task_output/tool-judgment-line/latest-tool-judgment-law.md",
      "data/capability-line/tool-judgment-law.json"
    ]
  },
  {
    id: "cognitive-upgrade",
    title: "刷新判断升级法源",
    command: "npm run cognitive:upgrade",
    outputFiles: [
      "task_output/cognitive-upgrade-line/latest-cognitive-upgrade-law.md",
      "data/capability-line/cognitive-upgrade-law.json"
    ]
  }
];

void main();

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const steps: StepResult[] = [];
  for (const step of STEPS) {
    steps.push(await runStep(step));
  }

  const run: DominanceRun = {
    generatedAt: new Date().toISOString(),
    mission: "把工具统治线沉淀成可复跑脚本、验尸链和前台总控卡，避免再次回滑到口头成功。",
    rerunCommand: "npm run tool:dominance",
    steps,
    autopsyChain: buildAutopsyChain(steps),
    frontdeskRules: buildFrontdeskRules(steps),
    proofBundle: unique(steps.flatMap((step) => step.outputFiles).filter(fileExistsRelative)),
    nextActions: buildNextActions(steps)
  };

  await writeFile(JSON_PATH, JSON.stringify(run, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(run), "utf8");

  console.log(`工具统治总控卡已生成: ${relative(ROOT, MD_PATH)}`);
}

async function runStep(step: Pick<StepResult, "id" | "title" | "command" | "outputFiles">): Promise<StepResult> {
  try {
    const { stdout, stderr } = await exec(step.command, { cwd: ROOT, maxBuffer: 1024 * 1024 * 8 });
    return {
      ...step,
      status: "passed",
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr),
      autopsy: buildStepAutopsy(step, "passed", stdout, stderr)
    };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ...step,
      status: "failed",
      stdout: trimOutput(failed.stdout ?? ""),
      stderr: trimOutput(failed.stderr ?? failed.message ?? ""),
      autopsy: buildStepAutopsy(step, "failed", failed.stdout ?? "", failed.stderr ?? failed.message ?? "")
    };
  }
}

function buildStepAutopsy(step: Pick<StepResult, "id" | "title" | "command" | "outputFiles">, status: StepResult["status"], stdout: string, stderr: string): string[] {
  const proofs = step.outputFiles.filter(fileExistsRelative);
  const lines = [
    `命令：${step.command}`,
    status === "passed" ? "结果：命令执行完成。" : "结果：命令执行失败，需要按 stderr 优先验尸。",
    proofs.length > 0 ? `留证：${proofs.join("；")}` : "留证：本步未生成预期文件，先核对入口、依赖与环境。"
  ];

  const signal = trimOutput(stderr || stdout).split("\n").find(Boolean);
  if (signal) lines.push(`首信号：${signal.slice(0, 180)}`);
  return lines;
}

function buildAutopsyChain(steps: StepResult[]): string[] {
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length === 0) {
    return [
      "先跑 npm run tool:dominance，不靠口述确认状态。",
      "若四步全过，以 frontdesk card 为唯一前台口径。",
      "若有任一步失败，先读该步 stderr 首信号，再核对对应 outputFiles 是否存在。",
      "连续两次同命令失败且无新证据时，停止重复执行，切到依赖/环境/输入三分诊。"
    ];
  }

  return failed.map((step) => `失败步 ${step.id}：先看 stderr 首信号，再复核 ${step.command} 依赖的输入文件与环境变量。`);
}

function buildFrontdeskRules(steps: StepResult[]): string[] {
  const passedCount = steps.filter((step) => step.status === "passed").length;
  return [
    "唯一复跑入口：npm run tool:dominance。",
    "唯一验尸顺序：先看总控 JSON，再看失败步 stderr，再看对应产物文件是否落盘。",
    `当前通过步数：${passedCount}/${steps.length}，禁止把未落盘产物说成已完成。`,
    "前台汇报只允许引用 task_output/ 下最新卡片与 data/capability-line/ 下方法文件。"
  ];
}

function buildNextActions(steps: StepResult[]): string[] {
  if (steps.every((step) => step.status === "passed")) {
    return [
      "每次新增/修改能力脚本后先复跑 npm run tool:dominance。",
      "对外或对上汇报前先打开 task_output/tool-dominance-line/latest-tool-dominance-frontdesk-card.md。",
      "若要扩展验证，可把 npm test 接入本总控链。"
    ];
  }

  return steps
    .filter((step) => step.status === "failed")
    .map((step) => `优先修复 ${step.id}，再复跑 npm run tool:dominance 验证总链恢复。`);
}

function renderMarkdown(run: DominanceRun): string {
  const lines: string[] = [];
  lines.push("# 工具统治线前台总控卡");
  lines.push("");
  lines.push(`- 更新时间：${run.generatedAt}`);
  lines.push(`- 任务目标：${run.mission}`);
  lines.push(`- 一键复跑：\`${run.rerunCommand}\``);
  lines.push("");
  lines.push("## 总控状态");
  for (const step of run.steps) {
    lines.push(`- [${step.status === "passed" ? "x" : " "}] ${step.title}｜\`${step.command}\``);
  }
  lines.push("");
  lines.push("## 验尸链");
  for (const item of run.autopsyChain) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 前台口径");
  for (const item of run.frontdeskRules) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 证据包");
  for (const item of run.proofBundle) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 分步留证");
  for (const step of run.steps) {
    lines.push(`### ${step.title}`);
    for (const item of step.autopsy) lines.push(`- ${item}`);
    if (step.stdout) lines.push(`- stdout 摘要：${step.stdout.split("\n")[0]?.slice(0, 180)}`);
    if (step.stderr) lines.push(`- stderr 摘要：${step.stderr.split("\n")[0]?.slice(0, 180)}`);
    lines.push("");
  }
  lines.push("## 下一跳");
  for (const item of run.nextActions) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}

function fileExistsRelative(relPath: string): boolean {
  return existsSync(resolve(ROOT, relPath));
}

function trimOutput(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
