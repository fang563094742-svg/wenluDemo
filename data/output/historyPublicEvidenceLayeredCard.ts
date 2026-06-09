#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Lead {
  title: string;
  budget: string;
  deadline: string;
  url: string;
  fit?: string;
  confidence?: number;
}

interface ScanPayload {
  scannedAt: string;
  source: string;
  totalParsed: number;
  shortlisted: number;
  leads: Lead[];
}

interface PublicEvidence {
  url: string;
  title: string;
  description: string;
  deadline: string;
  bodySnippet: string;
}

const ROOT = resolve(".");
const ARTIFACTS_DIR = resolve(ROOT, "artifacts");
const OUTPUT_DIR = resolve(ROOT, "task_output", "public-layered-frontdesk");
const OUTPUT_FILE = resolve(OUTPUT_DIR, "latest-public-layered-frontdesk.md");
const JSON_FILE = resolve(OUTPUT_DIR, "latest-public-layered-frontdesk.json");

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
  if (primary) return cleanHtml(primary).slice(0, 140);

  const article = html.match(/<li>([\s\S]*?)文档下载<\/li>/i)?.[1];
  if (article) return cleanHtml(article).slice(0, 140);

  return "";
}

async function latestScanDir(): Promise<string> {
  const entries = await readdir(ARTIFACTS_DIR, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("public-demand-scan-"))
      .map(async (entry) => {
        const fullPath = resolve(ARTIFACTS_DIR, entry.name);
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
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
  });
  if (!response.ok) throw new Error(`抓取失败 ${url}: ${response.status}`);
  return response.text();
}

function extractEvidence(url: string, html: string): PublicEvidence {
  const title = pick(html, /<title>([^<]+)<\/title>/i);
  const description = pick(html, /<meta name="description" content="([\s\S]*?)"\s*\/?/i);
  const deadline = pick(html, /项目工期：<span[^>]*class="pd-l-12">([^<]+)<\/span>/i, "待商议");
  const bodySnippet = snippetFromHtml(html) || cleanHtml(description).slice(0, 140);
  return { url, title, description: cleanHtml(description), deadline, bodySnippet };
}

async function osa(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.trim();
}

async function safariFront(): Promise<{ app: string; url: string; title: string }> {
  const [app, url, title] = await Promise.all([
    osa('tell application "System Events" to get name of first application process whose frontmost is true'),
    osa('tell application "Safari" to if it is running then get URL of current tab of front window'),
    osa('tell application "Safari" to if it is running then get name of front window'),
  ]);

  return { app, url, title };
}

function renderMarkdown(input: {
  front: { app: string; url: string; title: string };
  scanDir: string;
  scan: ScanPayload;
  evidence: PublicEvidence[];
}): string {
  const top = input.scan.leads[0];
  const evidenceBlocks = input.evidence
    .map((item, index) => [
      `### 历史公开页 ${index + 1}`,
      `- URL：${item.url}`,
      `- 标题证据：${item.title}`,
      `- 正文摘要证据：${item.description || item.bodySnippet}`,
      `- 工期证据：${item.deadline}`,
      `- 正文片段：${item.bodySnippet}`,
    ].join("\n"))
    .join("\n\n");

  return [
    "# 最小三层分界现行卡",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "## 第一层：当前前台真值",
    `- frontTruth.app=${input.front.app}`,
    `- frontTruth.url=${input.front.url}`,
    `- frontTruth.title=${input.front.title}`,
    "- 判词：当前前台只认此刻 Safari 前台标签，不认历史页面。",
    "",
    "## 第二层：历史公开页正文级证据",
    `- 旁证来源=${input.scan.source}`,
    `- 最近扫描目录=${basename(input.scanDir)}`,
    `- 扫描时间=${input.scan.scannedAt}`,
    `- 入围条数=${input.scan.shortlisted}`,
    evidenceBlocks,
    "",
    "## 第三层：现行闭环边界",
    "- 边界1：前台真值只证明当前正在看的页。",
    "- 边界2：历史公开页正文证据只证明外部需求样本真实存在且正文可读，不等于当前前台就在该站。",
    "- 边界3：结构化扫描落盘只证明样本已被程序化抽取，可作为后续追单入口。",
    top
      ? `- 当前最强样本=${top.title}｜${top.budget}｜${top.deadline}｜${top.url}`
      : "- 当前最强样本=无",
    "",
    "## 一键验证",
    "- `bash data/output/verify_history_public_evidence_and_layered_card.sh`",
  ].join("\n");
}

async function main(): Promise<void> {
  const scanDir = await latestScanDir();
  const scanPath = resolve(scanDir, "scan.json");
  const scan = JSON.parse(await readFile(scanPath, "utf8")) as ScanPayload;
  const leads = scan.leads.slice(0, 3);
  const evidence = await Promise.all(leads.map(async (lead) => extractEvidence(lead.url, await fetchText(lead.url))));
  const front = await safariFront();

  await mkdir(OUTPUT_DIR, { recursive: true });
  const markdown = renderMarkdown({ front, scanDir, scan, evidence });
  await writeFile(OUTPUT_FILE, markdown, "utf8");
  await writeFile(
    JSON_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        frontTruth: front,
        scanDir: basename(scanDir),
        source: scan.source,
        shortlisted: scan.shortlisted,
        evidence,
        topLead: leads[0] ?? null,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(OUTPUT_FILE);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
