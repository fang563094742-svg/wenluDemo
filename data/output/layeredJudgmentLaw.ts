#!/usr/bin/env tsx
import { execFile as execFileCb } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "layered-judgment-law");
const MD_PATH = resolve(OUTPUT_DIR, "latest-layered-judgment-law.md");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-layered-judgment-law.json");
const VERIFY_PATH = resolve(OUTPUT_DIR, "verify_layered_judgment_law.sh");
const TASK_CHAIN_PATH = resolve(ROOT, "data", "verifiable-task-chain", "task-chain.json");
const FRONT_SNAPSHOT_SCRIPT = resolve(ROOT, "tools", "front_snapshot", "safari_front_snapshot.sh");

interface FrontTruth {
  app: string;
  url: string;
  title: string;
  http: string;
  keyword: string;
  source: string;
}

interface PublicEvidence {
  url: string;
  title: string;
  description: string;
  deadline: string;
  bodySnippet: string;
}

interface ScanLead {
  title: string;
  budget: string;
  deadline: string;
  url: string;
  fit?: string;
}

interface ScanPayload {
  scannedAt: string;
  source: string;
  totalParsed: number;
  shortlisted: number;
  leads: ScanLead[];
}

interface LayeredJudgmentLaw {
  generatedAt: string;
  thesis: string;
  law: string[];
  frontTruth: FrontTruth;
  latestScan: {
    dir: string;
    source: string;
    scannedAt: string;
    totalParsed: number;
    shortlisted: number;
    topLead: ScanLead | null;
  };
  historicalEvidence: PublicEvidence[];
  verification: {
    command: string;
    checks: string[];
  };
}

function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function pick(text: string, regex: RegExp, fallback = ""): string {
  return (text.match(regex)?.[1] ?? fallback).replace(/\s+/g, " ").trim();
}

function cleanHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetFromHtml(html: string): string {
  const primary = html.match(/<p><p>([\s\S]*?)<\/p>/i)?.[1];
  if (primary) return cleanHtml(primary).slice(0, 160);
  const article = html.match(/<li>([\s\S]*?)文档下载<\/li>/i)?.[1];
  if (article) return cleanHtml(article).slice(0, 160);
  return "";
}

async function run(command: string, args: string[], timeout = 20000): Promise<string> {
  const { stdout } = await execFile(command, args, {
    cwd: ROOT,
    timeout,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout.trim();
}

async function getFrontTruth(): Promise<FrontTruth> {
  const snapshot = parseKeyValue(await run("bash", [FRONT_SNAPSHOT_SCRIPT], 15000));
  return {
    app: snapshot.frontApp || "",
    url: snapshot.url || "",
    title: snapshot.title || "",
    http: snapshot.http || "",
    keyword: snapshot.keyword || "",
    source: "tools/front_snapshot/safari_front_snapshot.sh",
  };
}

async function latestScanDir(): Promise<string> {
  const artifactsDir = resolve(ROOT, "artifacts");
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("public-demand-scan-"))
      .map(async (entry) => {
        const fullPath = resolve(artifactsDir, entry.name);
        const info = await stat(fullPath);
        return { fullPath, mtimeMs: info.mtimeMs };
      }),
  );
  const latest = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) throw new Error("未找到 public-demand-scan 产物");
  return latest.fullPath;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  if (!response.ok) throw new Error(`抓取失败 ${url}: ${response.status}`);
  return response.text();
}

function extractEvidence(url: string, html: string): PublicEvidence {
  const title = pick(html, /<title>([^<]+)<\/title>/i);
  const description = cleanHtml(pick(html, /<meta name="description" content="([\s\S]*?)"\s*\/?/i));
  const deadline = pick(html, /项目工期：<span[^>]*class="pd-l-12">([^<]+)<\/span>/i, "待商议");
  const bodySnippet = snippetFromHtml(html) || description.slice(0, 160);
  return { url, title, description, deadline, bodySnippet };
}

function renderMarkdown(model: LayeredJudgmentLaw): string {
  const evidenceLines = model.historicalEvidence
    .map((item, index) => [
      `### 历史旁证 ${index + 1}`,
      `- URL：${item.url}`,
      `- 标题：${item.title}`,
      `- 描述：${item.description}`,
      `- 工期：${item.deadline}`,
      `- 正文摘录：${item.bodySnippet}`,
    ].join("\n"))
    .join("\n\n");

  const topLead = model.latestScan.topLead;
  return [
    "# 前台真值与历史旁证分层闭环｜单文件最小判断法源",
    "",
    `生成时间：${model.generatedAt}`,
    `总判词：${model.thesis}`,
    "",
    "## 第一层：当前前台真值",
    `- frontTruth.app=${model.frontTruth.app}`,
    `- frontTruth.url=${model.frontTruth.url}`,
    `- frontTruth.title=${model.frontTruth.title}`,
    `- frontTruth.http=${model.frontTruth.http}`,
    `- frontTruth.keyword=${model.frontTruth.keyword || ""}`,
    `- source=${model.frontTruth.source}`,
    "",
    "## 第二层：历史公开旁证",
    `- latestScan.dir=${model.latestScan.dir}`,
    `- latestScan.source=${model.latestScan.source}`,
    `- latestScan.scannedAt=${model.latestScan.scannedAt}`,
    `- latestScan.totalParsed=${model.latestScan.totalParsed}`,
    `- latestScan.shortlisted=${model.latestScan.shortlisted}`,
    topLead ? `- latestScan.topLead=${topLead.title}｜${topLead.budget}｜${topLead.deadline}｜${topLead.url}` : "- latestScan.topLead=none",
    "",
    evidenceLines,
    "",
    "## 第三层：现行闭环边界",
    ...model.law.map((item) => `- ${item}`),
    "",
    "## 第四层：外部可验证闭环",
    `- verify.command=${model.verification.command}`,
    ...model.verification.checks.map((item) => `- ${item}`),
    "",
    "## 当前结论",
    "- 当前前台只认 Safari 前台快照，不认旧卡与历史记忆。",
    "- 历史旁证只证明公开页面正文与需求样本曾被真实抓到，不得冒充当前前台页。",
    "- 只有当前前台、历史旁证、验证脚本三者同时成立，才允许输出‘闭环成立’。",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const frontTruth = await getFrontTruth();
  const scanDir = await latestScanDir();
  const scanPath = resolve(scanDir, "scan.json");
  const scan = JSON.parse(await readFile(scanPath, "utf8")) as ScanPayload;
  const evidenceUrls = scan.leads.slice(0, 3).map((lead) => lead.url);
  const evidence = await Promise.all(
    evidenceUrls.map(async (url) => extractEvidence(url, await fetchText(url))),
  );

  const verificationCommand = `bash ${VERIFY_PATH}`;
  const latestScanName = scanDir.split("/").pop() ?? scanDir;
  const checks = [
    "前台快照必须返回 Safari 且 URL 等于 http://127.0.0.1:3210/。",
    "最新 public-demand-scan 目录必须存在且 scan.json 可读。",
    "单文件法源必须写出三层标题与最新扫描目录名。",
    "JSON 法源必须包含 frontTruth.url 与至少 3 条历史旁证。",
  ];

  const model: LayeredJudgmentLaw = {
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    thesis: "把当前前台真值与历史公开旁证强制分层，再用一条退出码脚本绑定成外部可验证闭环。",
    law: [
      "第一层只记当前前台真值：是谁在前台、当前 URL 是什么、当前标题是什么。",
      "第二层只记历史公开旁证：外部帖子正文、标题、工期、扫描目录，不得写成当前正在前台。",
      "任何‘已到执行位’口径，必须同时引用前台快照与历史旁证，缺一作废。",
      "验证失败时，一律回退为‘前台未知或旁证失效’，禁止凭记忆续判。",
    ],
    frontTruth,
    latestScan: {
      dir: scanDir.replace(`${ROOT}/`, ""),
      source: scan.source,
      scannedAt: scan.scannedAt,
      totalParsed: scan.totalParsed,
      shortlisted: scan.shortlisted,
      topLead: scan.leads[0] ?? null,
    },
    historicalEvidence: evidence,
    verification: {
      command: verificationCommand,
      checks,
    },
  };

  const markdown = renderMarkdown(model);
  const verifyScript = `#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
front_raw=$(bash tools/front_snapshot/safari_front_snapshot.sh)
printf '%s\n' "$front_raw" | grep -F 'frontApp=Safari' >/dev/null
printf '%s\n' "$front_raw" | grep -F 'url=http://127.0.0.1:3210/' >/dev/null
latest_scan=$(find artifacts -maxdepth 1 -type d -name 'public-demand-scan-*' | sort | tail -n 1)
test -n "$latest_scan"
test -f "$latest_scan/scan.json"
test -f task_output/layered-judgment-law/latest-layered-judgment-law.md
test -f task_output/layered-judgment-law/latest-layered-judgment-law.json
grep -F '## 第一层：当前前台真值' task_output/layered-judgment-law/latest-layered-judgment-law.md >/dev/null
grep -F '## 第二层：历史公开旁证' task_output/layered-judgment-law/latest-layered-judgment-law.md >/dev/null
grep -F '## 第三层：现行闭环边界' task_output/layered-judgment-law/latest-layered-judgment-law.md >/dev/null
grep -F '## 第四层：外部可验证闭环' task_output/layered-judgment-law/latest-layered-judgment-law.md >/dev/null
grep -F "$(basename "$latest_scan")" task_output/layered-judgment-law/latest-layered-judgment-law.md >/dev/null
node -e 'const fs=require("fs");const p="task_output/layered-judgment-law/latest-layered-judgment-law.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.frontTruth?.url!=="http://127.0.0.1:3210/")process.exit(1);if(!Array.isArray(j.historicalEvidence)||j.historicalEvidence.length<3)process.exit(1);if(!j.historicalEvidence.every(x=>x.url&&x.title&&x.bodySnippet))process.exit(1);'
echo passed
`;

  await writeFile(MD_PATH, `${markdown}\n`, "utf8");
  await writeFile(JSON_PATH, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  await writeFile(VERIFY_PATH, verifyScript, { encoding: "utf8", mode: 0o755 });

  let taskChain: Array<Record<string, unknown>> = [];
  try {
    taskChain = JSON.parse(await readFile(TASK_CHAIN_PATH, "utf8"));
  } catch {
    taskChain = [];
  }
  const taskId = "vt-layered-judgment-law-min-source";
  const nextTask = {
    id: taskId,
    goal: "当前前台真值、历史公开旁证与单文件最小判断法源必须由同一验证脚本同时复核通过。",
    verifyCmd: `bash task_output/layered-judgment-law/verify_layered_judgment_law.sh`,
    difficulty: 4,
    createdAt: new Date().toISOString(),
  };
  const existingIndex = taskChain.findIndex((item) => item.id === taskId);
  if (existingIndex >= 0) taskChain[existingIndex] = nextTask;
  else taskChain.push(nextTask);
  await writeFile(TASK_CHAIN_PATH, `${JSON.stringify(taskChain, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ md: MD_PATH, json: JSON_PATH, verify: VERIFY_PATH, latestScan: latestScanName }, null, 2));
}

void main();
