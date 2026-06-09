#!/usr/bin/env tsx
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve('.');
const ARTIFACTS_DIR = resolve(ROOT, 'artifacts');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'public-layered-frontdesk');
const OUTPUT_MD = resolve(OUTPUT_DIR, 'latest-history-final-url-layered-card.md');
const OUTPUT_JSON = resolve(OUTPUT_DIR, 'latest-history-final-url-layered-card.json');
const VERIFY_SCRIPT = resolve(ROOT, 'data/output/verify_history_final_url_layered_card.sh');
const TASK_CHAIN = resolve(ROOT, 'data/verifiable-task-chain/task-chain.json');

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

interface OutputPayload {
  generatedAt: string;
  frontTruth: { app: string; url: string; title: string; source: string };
  latestScan: { dir: string; scannedAt: string; source: string; totalParsed: number; shortlisted: number };
  finalLead: Lead;
  evidence: PublicEvidence[];
  thesis: string;
  boundaries: string[];
  nextVerifiableTask: { id: string; goal: string; verifyCmd: string; difficulty: number };
}

function pick(text: string, regex: RegExp, fallback = ''): string {
  return (text.match(regex)?.[1] ?? fallback).replace(/\s+/g, ' ').trim();
}

function cleanHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippetFromHtml(html: string): string {
  const primary = html.match(/<p><p>([\s\S]*?)<\/p>/i)?.[1];
  if (primary) return cleanHtml(primary).slice(0, 160);
  const article = html.match(/<li>([\s\S]*?)文档下载<\/li>/i)?.[1];
  if (article) return cleanHtml(article).slice(0, 160);
  return cleanHtml(html).slice(0, 160);
}

async function latestScanDir(): Promise<string> {
  const entries = await readdir(ARTIFACTS_DIR, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('public-demand-scan-'))
      .map(async (entry) => {
        const fullPath = resolve(ARTIFACTS_DIR, entry.name);
        const info = await stat(fullPath);
        return { fullPath, mtimeMs: info.mtimeMs };
      }),
  );
  const latest = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) throw new Error('未找到 public-demand-scan 产物');
  return latest.fullPath;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  });
  if (!response.ok) throw new Error(`抓取失败 ${url}: ${response.status}`);
  return response.text();
}

function extractEvidence(url: string, html: string): PublicEvidence {
  const title = pick(html, /<title>([^<]+)<\/title>/i);
  const description = pick(html, /<meta name="description" content="([\s\S]*?)"\s*\/?>/i);
  const deadline = pick(html, /项目工期：<span[^>]*class="pd-l-12">([^<]+)<\/span>/i, '待商议');
  const bodySnippet = snippetFromHtml(html);
  return { url, title, description: cleanHtml(description), deadline, bodySnippet };
}

async function osa(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return stdout.trim();
}

async function safariFront(): Promise<{ app: string; url: string; title: string }> {
  const [app, url, title] = await Promise.all([
    osa('tell application "System Events" to get name of first application process whose frontmost is true'),
    osa('tell application "Safari" to if it is running then get URL of current tab of front window'),
    osa('tell application "Safari" to if it is running then get name of current tab of front window'),
  ]);
  return { app, url, title };
}

function renderMarkdown(payload: OutputPayload): string {
  const evidenceBlocks = payload.evidence.map((item, index) => [
    `### 正文证据 ${index + 1}`,
    `- URL：${item.url}`,
    `- 标题：${item.title}`,
    `- 描述：${item.description || '无'}`,
    `- 工期：${item.deadline}`,
    `- 正文摘录：${item.bodySnippet}`,
  ].join('\n')).join('\n\n');

  return [
    '# 前台真值与历史旁证分层正文级证据卡',
    '',
    `生成时间：${payload.generatedAt}`,
    `总论：${payload.thesis}`,
    '',
    '## 第一层：当前前台真值',
    `- frontTruth.app=${payload.frontTruth.app}`,
    `- frontTruth.url=${payload.frontTruth.url}`,
    `- frontTruth.title=${payload.frontTruth.title}`,
    `- source=${payload.frontTruth.source}`,
    '',
    '## 第二层：历史旁证的正文级证据',
    `- 最新公开需求扫描目录：${payload.latestScan.dir}`,
    `- 扫描时间：${payload.latestScan.scannedAt}`,
    `- 来源站点：${payload.latestScan.source}`,
    `- 总解析数：${payload.latestScan.totalParsed}`,
    `- 入选数：${payload.latestScan.shortlisted}`,
    `- 最终指向 URL：${payload.finalLead.url}`,
    `- 最终指向标题：${payload.finalLead.title}`,
    '',
    evidenceBlocks,
    '',
    '## 第三层：闭环硬边界',
    ...payload.boundaries.map((line) => `- ${line}`),
    '',
    '## 下一条外部可验证任务',
    `- id=${payload.nextVerifiableTask.id}`,
    `- goal=${payload.nextVerifiableTask.goal}`,
    `- verifyCmd=${payload.nextVerifiableTask.verifyCmd}`,
    `- difficulty=${payload.nextVerifiableTask.difficulty}`,
    '',
  ].join('\n');
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const scanDir = await latestScanDir();
  const scan = JSON.parse(await readFile(resolve(scanDir, 'scan.json'), 'utf8')) as ScanPayload;
  if (!scan.leads?.length) throw new Error('扫描结果为空，无法生成正文级证据');

  const finalLead = scan.leads[0];
  const evidenceUrls = [
    finalLead.url,
    ...scan.leads.slice(1, 3).map((lead) => lead.url),
  ];

  const evidence = await Promise.all(evidenceUrls.map(async (url) => extractEvidence(url, await fetchText(url))));
  const front = await safariFront();
  const taskChain = JSON.parse(await readFile(TASK_CHAIN, 'utf8')) as Array<{ id: string; goal: string; verifyCmd: string; difficulty: number }>;
  const nextTask = taskChain.find((item) => item.id === 'vt1780949959328') ?? {
    id: 'vt1780949959328',
    goal: 'Safari 前台真值、五个公开入口 HTTP 200、以及最新公开需求扫描目录必须彼此一致并由单脚本复核通过。',
    verifyCmd: 'bash data/output/verify_front_truth_boundary_chain.sh',
    difficulty: 5,
  };

  const payload: OutputPayload = {
    generatedAt: new Date().toISOString(),
    frontTruth: { ...front, source: 'live Safari front tab probe' },
    latestScan: {
      dir: `artifacts/${basename(scanDir)}`,
      scannedAt: scan.scannedAt,
      source: scan.source,
      totalParsed: scan.totalParsed,
      shortlisted: scan.shortlisted,
    },
    finalLead,
    evidence,
    thesis: '只有把 Safari 当前前台真值、公开扫描最终指向 URL、以及对应正文摘录同时落盘，才算拿到正文级证据；任何只报标题或只报历史目录都不够。',
    boundaries: [
      '前台真值只认本轮 Safari 当前标签，不认历史记忆。',
      '历史旁证必须落到具体公开 URL 与正文摘录，不能只写“扫过了”。',
      '正文级证据证明的是公开页面曾被抓取并落盘，不等于当前前台就在该公开页。',
      '最终是否成立仍以外部可执行 verify 脚本退出码为准。',
    ],
    nextVerifiableTask: nextTask,
  };

  await writeFile(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(OUTPUT_MD, `${renderMarkdown(payload)}\n`, 'utf8');
  await writeFile(
    VERIFY_SCRIPT,
    `#!/bin/bash\nset -euo pipefail\nROOT=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"\ncd \"$ROOT\"\nnode_modules/.bin/tsx data/output/historyFinalUrlLayeredCard.ts >/dev/null\ntest -f task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md\ntest -f task_output/public-layered-frontdesk/latest-history-final-url-layered-card.json\ngrep -F \"## 第一层：当前前台真值\" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null\ngrep -F \"## 第二层：历史旁证的正文级证据\" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null\ngrep -F \"## 第三层：闭环硬边界\" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null\ngrep -F \"frontTruth.url=http://127.0.0.1:3210/\" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null\nlatest_scan=\"$(ls -dt artifacts/public-demand-scan-* | head -n 1)\"\ngrep -F \"$(basename \"$latest_scan\")\" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null\nnode -e 'const fs=require("fs");const p="task_output/public-layered-frontdesk/latest-history-final-url-layered-card.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.frontTruth.url!=="http://127.0.0.1:3210/")process.exit(1);if(!Array.isArray(j.evidence)||j.evidence.length<3)process.exit(1);if(!j.evidence.every(x=>x.url.startsWith("https://sxsapi.com/post/")&&x.title&&x.bodySnippet))process.exit(1);if(j.finalLead.url!==j.evidence[0].url)process.exit(1);'\necho passed\n`,
    'utf8',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
