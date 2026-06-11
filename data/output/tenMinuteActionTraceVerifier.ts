#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface Checkpoint {
  checkedAt: string;
  hasVisibleTrace: boolean;
  traceCountWithinWindow: number;
  latestTraceAt?: string;
}

interface TraceLedger {
  title: string;
  generatedAt: string;
  windowMinutes: number;
  traces: Array<{
    id: string;
    createdAt: string;
    actor: "user" | "agent" | "system";
    surface: "control" | "evidence" | "delivery" | "verification";
    action: string;
    summary: string;
    proofPaths: string[];
    visibleBefore: string;
  }>;
  latestCheckpoint: Checkpoint;
}

interface VerificationReport {
  generatedAt: string;
  goal: string;
  verifyCommand: string;
  passed: boolean;
  checkpoint: Checkpoint;
  supportingFiles: string[];
}

const ROOT = resolve(".");
const DATA_DIR = resolve(ROOT, "data", "verifiable-task-chain");
const LEDGER_PATH = resolve(DATA_DIR, "ten-minute-action-trace-ledger.json");
const REPORT_PATH = resolve(DATA_DIR, "ten-minute-action-trace-verification.json");
const REPORT_MD_PATH = resolve(DATA_DIR, "ten-minute-action-trace-verification.md");
const VERIFY_COMMAND = "node -e \"const fs=require('fs');const p='data/verifiable-task-chain/ten-minute-action-trace-ledger.json';const data=JSON.parse(fs.readFileSync(p,'utf8'));process.exit(data.latestCheckpoint?.hasVisibleTrace?0:1)\"";

function renderMarkdown(report: VerificationReport): string {
  return [
    "# 10分钟动作痕迹验证结果",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 目标：${report.goal}`,
    `- 验证命令：\`${report.verifyCommand}\``,
    `- 结果：${report.passed ? "PASS" : "FAIL"}`,
    `- 检查时间：${report.checkpoint.checkedAt}`,
    `- 窗口内痕迹数：${report.checkpoint.traceCountWithinWindow}`,
    `- 最近痕迹时间：${report.checkpoint.latestTraceAt ?? "无"}`,
    "",
    "## 支撑文件",
    "",
    ...report.supportingFiles.map((item) => `- ${item}`)
  ].join("\n");
}

void main();

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(LEDGER_PATH)) {
    throw new Error("缺少动作痕迹账本，请先运行 tenMinuteActionTraceLedger.ts");
  }

  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as TraceLedger;
  const checkpoint = ledger.latestCheckpoint;
  const report: VerificationReport = {
    generatedAt: new Date().toISOString(),
    goal: "控制层与证据链具备 10 分钟内可见动作痕迹的可验证闭环",
    verifyCommand: VERIFY_COMMAND,
    passed: checkpoint.hasVisibleTrace,
    checkpoint,
    supportingFiles: [
      "data/verifiable-task-chain/ten-minute-action-trace-ledger.json",
      "data/verifiable-task-chain/ten-minute-action-trace-ledger.md"
    ]
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(REPORT_MD_PATH, renderMarkdown(report), "utf8");
  if (!report.passed) process.exitCode = 1;
  console.log(`10分钟动作痕迹验证已生成: ${REPORT_PATH}`);
}
