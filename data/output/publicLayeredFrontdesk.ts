#!/usr/bin/env tsx
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'public-layered-frontdesk');
const DATA_DIR = resolve(ROOT, 'data', 'capability-line');
const JSON_PATH = resolve(DATA_DIR, 'public-platform-truth-skeleton.json');
const MD_PATH = resolve(OUTPUT_DIR, 'latest-public-layered-frontdesk.md');
const DETAIL_JSON_PATH = resolve(OUTPUT_DIR, 'latest-public-layered-frontdesk.json');
const TASK_CHAIN_PATH = resolve(ROOT, 'data', 'verifiable-task-chain', 'task-chain.json');
const VERIFY_SCRIPT_PATH = resolve(ROOT, 'task_output', 'verify_public_layered_frontdesk.sh');

interface FrontTruth {
  app: string;
  url: string;
  title: string;
  source: string;
}

interface EntryCheck {
  name: string;
  url: string;
  scope: string;
  expectedStatus: number;
  status: number;
  ok: boolean;
  verification: string;
}

interface DemandScanSummary {
  dir: string;
  source: string;
  scannedAt: string;
  totalParsed: number;
  shortlisted: number;
  topLead?: {
    title: string;
    budget: string;
    deadline: string;
    url: string;
    fit: string;
  };
}

interface LayeredReport {
  generatedAt: string;
  thesis: string;
  frontTruth: FrontTruth;
  publicEntryChecks: EntryCheck[];
  demandScan: DemandScanSummary | null;
  hardBoundaries: string[];
  reusableSkeleton: string[];
  nextVerifiableTask: {
    id: string;
    goal: string;
    verifyCmd: string;
    difficulty: number;
  };
}

const PUBLIC_ENTRIES = [
  {
    name: '微信网页版公开入口',
    url: 'https://web.wechat.com/',
    scope: '只证明公开入口可达，不等于已登录或可发送。'
  },
  {
    name: '即刻发布页公开入口',
    url: 'https://web.okjike.com/publish',
    scope: '只证明发布入口可达，不等于账号态可发布。'
  },
  {
    name: '视频号助手发帖入口',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    scope: '只证明创建页直连可达，不等于已进入可发态。'
  },
  {
    name: '微博公开首页入口',
    url: 'https://weibo.com/',
    scope: '只证明微博外网入口可达，不等于已登录或可发。'
  },
  {
    name: '小红书发布页公开入口',
    url: 'https://www.xiaohongshu.com/publish/publish',
    scope: '只证明发布壳可达，不等于已进入发布权限页。'
  }
] as const;

async function run(command: string, args: string[], timeout = 20000) {
  return execFile(command, args, {
    cwd: ROOT,
    timeout,
    maxBuffer: 1024 * 1024 * 8,
  });
}

async function getSafariTruth(): Promise<FrontTruth> {
  const frontApp = (await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], 10000)).stdout.trim();
  const url = (await run('osascript', ['-e', 'tell application "Safari" to if it is running then get URL of current tab of front window'], 10000)).stdout.trim();
  const title = (await run('osascript', ['-e', 'tell application "Safari" to if it is running then get name of current tab of front window'], 10000)).stdout.trim();
  return {
    app: frontApp,
    url,
    title,
    source: 'live Safari front tab probe',
  };
}

async function checkUrl(url: string): Promise<number> {
  const { stdout } = await run('curl', ['--noproxy', '*', '-L', '-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
  return Number(stdout.trim());
}

async function getLatestDemandScan(): Promise<DemandScanSummary | null> {
  const artifactsDir = resolve(ROOT, 'artifacts');
  const names = await readdir(artifactsDir);
  const matches = names.filter((name) => name.startsWith('public-demand-scan-')).sort().reverse();
  if (!matches.length) return null;
  const dir = matches[0];
  const scanPath = resolve(artifactsDir, dir, 'scan.json');
  const raw = JSON.parse(await readFile(scanPath, 'utf8'));
  return {
    dir: `artifacts/${dir}`,
    source: raw.source,
    scannedAt: raw.scannedAt,
    totalParsed: raw.totalParsed,
    shortlisted: raw.shortlisted,
    topLead: raw.leads?.[0]
      ? {
          title: raw.leads[0].title,
          budget: raw.leads[0].budget,
          deadline: raw.leads[0].deadline,
          url: raw.leads[0].url,
          fit: raw.leads[0].fit,
        }
      : undefined,
  };
}

async function updateTaskChain(task: LayeredReport['nextVerifiableTask']) {
  await mkdir(resolve(ROOT, 'data', 'verifiable-task-chain'), { recursive: true });
  let tasks: any[] = [];
  try {
    tasks = JSON.parse(await readFile(TASK_CHAIN_PATH, 'utf8'));
    if (!Array.isArray(tasks)) tasks = [];
  } catch {
    tasks = [];
  }
  const existing = tasks.find((item) => item.id === task.id);
  const next = {
    id: task.id,
    goal: task.goal,
    verifyCmd: task.verifyCmd,
    difficulty: task.difficulty,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const merged = tasks.filter((item) => item.id !== task.id);
  merged.push(next);
  merged.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  await writeFile(TASK_CHAIN_PATH, JSON.stringify(merged, null, 2), 'utf8');
}

async function writeVerifyScript(demandScan: DemandScanSummary | null) {
  const demandPath = demandScan ? `${demandScan.dir}/scan.json` : 'artifacts/public-demand-scan-missing/scan.json';
  const frontAppScript = `test "$(osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true')" = "Safari"`;
  const frontUrlScript = `test "$(osascript -e 'tell application \"Safari\" to if it is running then get URL of current tab of front window')" = "http://127.0.0.1:3210/"`;
  const lines = [
    '#!/bin/bash',
    'set -euo pipefail',
    frontAppScript,
    frontUrlScript,
    'for u in https://web.wechat.com/ https://web.okjike.com/publish https://channels.weixin.qq.com/platform/post/create https://weibo.com/ https://www.xiaohongshu.com/publish/publish; do',
    '  code=$(curl --noproxy "*" -L -s -o /dev/null -w "%{http_code}" "$u")',
    '  test "$code" = "200"',
    'done',
    'test -f task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md',
    'grep -F "frontTruth.url=http://127.0.0.1:3210/" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null',
    'grep -F "https://weibo.com/" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null',
    `test -f ${demandPath}`,
    'echo passed',
    ''
  ].join('\n');
  await writeFile(VERIFY_SCRIPT_PATH, lines, 'utf8');
  await run('chmod', ['+x', VERIFY_SCRIPT_PATH], 10000);
}

function renderMarkdown(report: LayeredReport): string {
  const demand = report.demandScan;
  return [
    '# 公开入口分层 × Safari 前台真值唯一现行卡',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 唯一判词：${report.thesis}`,
    '',
    '## 第一层：当前前台真值',
    `- frontTruth.app=${report.frontTruth.app}`,
    `- frontTruth.title=${report.frontTruth.title}`,
    `- frontTruth.url=${report.frontTruth.url}`,
    `- frontTruth.source=${report.frontTruth.source}`,
    '',
    '## 第二层：公开入口复核',
    ...report.publicEntryChecks.map((item) => `- ${item.name}｜${item.url}｜HTTP ${item.status}｜${item.scope}｜验证：${item.verification}`),
    '',
    '## 第三层：公开需求落盘旁证',
    demand
      ? `- demandScan=${demand.dir}｜${demand.source}｜parsed=${demand.totalParsed}｜shortlisted=${demand.shortlisted}`
      : '- demandScan=无可用扫描产物',
    ...(demand?.topLead
      ? [
          `- topLead=${demand.topLead.title}｜${demand.topLead.budget}｜${demand.topLead.deadline}｜${demand.topLead.url}｜fit=${demand.topLead.fit}`,
        ]
      : []),
    '',
    '## 分界硬规则',
    ...report.hardBoundaries.map((item) => `- ${item}`),
    '',
    '## 可复用判断骨架',
    ...report.reusableSkeleton.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 下一条更难可验证任务',
    `- id=${report.nextVerifiableTask.id}`,
    `- goal=${report.nextVerifiableTask.goal}`,
    `- verifyCmd=${report.nextVerifiableTask.verifyCmd}`,
    ''
  ].join('\n');
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const frontTruth = await getSafariTruth();
  const publicEntryChecks: EntryCheck[] = [];
  for (const entry of PUBLIC_ENTRIES) {
    const status = await checkUrl(entry.url);
    publicEntryChecks.push({
      ...entry,
      expectedStatus: 200,
      status,
      ok: status === 200,
      verification: `curl --noproxy '*' -L -s -o /dev/null -w '%{http_code}' ${entry.url}`,
    });
  }

  const demandScan = await getLatestDemandScan();
  await writeVerifyScript(demandScan);

  const report: LayeredReport = {
    generatedAt: new Date().toISOString(),
    thesis: '更强判断只在三层同时成立时有效：Safari 当前前台真值、公开入口当前可达性、以及公开需求扫描落盘旁证；任何跨层偷换都作废。',
    frontTruth,
    publicEntryChecks,
    demandScan,
    hardBoundaries: [
      '前台真值只认本轮 Safari 当前标签，不认历史记忆。',
      'HTTP 200 只证明公开入口可达，不证明登录态、发送权或发布权。',
      '公开需求扫描只证明外部样本已落盘，不等于当前前台就在该公开站点。',
      '必须把前台层、公开入口层、需求落盘层分别写明，禁止混成一句“已可用”。'
    ],
    reusableSkeleton: [
      '先取 Safari 当前前台应用、标题与 URL，锁死现场真值。',
      '再批量复核公开入口 HTTP 状态，记录边界说明与验证命令。',
      '再寻找最近一次公开需求扫描产物，确认外部样本已经结构化落盘。',
      '把三层同时压成一张卡，并附一条退出码验证脚本作为下轮真值门槛。'
    ],
    nextVerifiableTask: {
      id: 'vt-public-layered-frontdesk-3210',
      goal: 'Safari 当前前台仍是 3210，五个公开入口同时可达，且最近公开需求扫描旁证仍已落盘。',
      verifyCmd: 'bash task_output/verify_public_layered_frontdesk.sh',
      difficulty: 4,
    },
  };

  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(DETAIL_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(MD_PATH, renderMarkdown(report), 'utf8');
  await updateTaskChain(report.nextVerifiableTask);

  console.log(JSON.stringify({
    json: JSON_PATH,
    md: MD_PATH,
    verifyScript: VERIFY_SCRIPT_PATH,
    taskId: report.nextVerifiableTask.id,
    verifyCmd: report.nextVerifiableTask.verifyCmd,
  }, null, 2));
}

void main();
