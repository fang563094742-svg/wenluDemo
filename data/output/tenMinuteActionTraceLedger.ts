#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface ActionTraceEntry {
  id: string;
  createdAt: string;
  actor: "user" | "agent" | "system";
  surface: "control" | "evidence" | "delivery" | "verification";
  action: string;
  summary: string;
  proofPaths: string[];
  visibleBefore: string;
}

interface TraceLedger {
  title: string;
  generatedAt: string;
  windowMinutes: number;
  traces: ActionTraceEntry[];
  latestCheckpoint: {
    checkedAt: string;
    hasVisibleTrace: boolean;
    traceCountWithinWindow: number;
    latestTraceAt?: string;
  };
}

const ROOT = resolve(".");
const DATA_DIR = resolve(ROOT, "data", "verifiable-task-chain");
const JSON_PATH = resolve(DATA_DIR, "ten-minute-action-trace-ledger.json");
const MD_PATH = resolve(DATA_DIR, "ten-minute-action-trace-ledger.md");
const WINDOW_MINUTES = 10;

function nowIso(): string {
  return new Date().toISOString();
}

function plusMinutes(baseIso: string, minutes: number): string {
  return new Date(Date.parse(baseIso) + minutes * 60_000).toISOString();
}

function withinWindow(entries: ActionTraceEntry[], now: number): ActionTraceEntry[] {
  const cutoff = now - WINDOW_MINUTES * 60_000;
  return entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff);
}

async function loadExisting(): Promise<TraceLedger | null> {
  if (!existsSync(JSON_PATH)) return null;
  const raw = await readFile(JSON_PATH, "utf8");
  return JSON.parse(raw) as TraceLedger;
}

function buildSeedTrace(existing: TraceLedger | null): ActionTraceEntry[] {
  if (existing?.traces?.length) return existing.traces;

  const createdAt = nowIso();
  return [
    {
      id: `trace-${Date.now()}`,
      createdAt,
      actor: "agent",
      surface: "control",
      action: "task-line-started",
      summary: "任务线已启动，并开始补齐控制层与证据链的可验证闭环。",
      proofPaths: ["task_output", "data/verifiable-task-chain"],
      visibleBefore: plusMinutes(createdAt, WINDOW_MINUTES)
    }
  ];
}

function renderMarkdown(ledger: TraceLedger): string {
  const lines: string[] = [];
  lines.push("# 10分钟动作痕迹账本", "");
  lines.push(`- 生成时间：${ledger.generatedAt}`);
  lines.push(`- 判定窗口：${ledger.windowMinutes} 分钟`);
  lines.push(`- 窗口内可见痕迹：${ledger.latestCheckpoint.hasVisibleTrace ? "是" : "否"}`);
  lines.push(`- 窗口内痕迹数：${ledger.latestCheckpoint.traceCountWithinWindow}`);
  lines.push(`- 最近痕迹时间：${ledger.latestCheckpoint.latestTraceAt ?? "无"}`);
  lines.push("");
  lines.push("## 判定纪律", "");
  lines.push("- 每次真实动作都要留下可点击路径或文件证据。");
  lines.push("- 每次刷新账本都会重算最近 10 分钟内是否出现可见动作痕迹。");
  lines.push("- 没有窗口内痕迹，就不算闭环成立。");
  lines.push("");
  lines.push("## 痕迹清单", "");

  for (const trace of ledger.traces.slice().reverse()) {
    lines.push(`- ${trace.createdAt}｜${trace.actor}｜${trace.surface}｜${trace.action}｜${trace.summary}`);
    lines.push(`  证据：${trace.proofPaths.join(", ")}`);
    lines.push(`  最晚可见：${trace.visibleBefore}`);
  }

  return lines.join("\n");
}

void main();

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const existing = await loadExisting();
  const traces = buildSeedTrace(existing);
  const checkpointTraces = withinWindow(traces, Date.now());
  const latestTraceAt = checkpointTraces.map((entry) => entry.createdAt).sort().at(-1);
  const generatedAt = nowIso();

  const ledger: TraceLedger = {
    title: "10分钟动作痕迹账本",
    generatedAt,
    windowMinutes: WINDOW_MINUTES,
    traces,
    latestCheckpoint: {
      checkedAt: generatedAt,
      hasVisibleTrace: checkpointTraces.length > 0,
      traceCountWithinWindow: checkpointTraces.length,
      ...(latestTraceAt ? { latestTraceAt } : {})
    }
  };

  await writeFile(JSON_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(ledger), "utf8");
  console.log(`10分钟动作痕迹账本已生成: ${JSON_PATH}`);
}
