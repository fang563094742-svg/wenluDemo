#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'front-truth-line');
const OUTPUT_MD = resolve(OUTPUT_DIR, 'latest-safari-3210-layered-single-card.md');
const OUTPUT_JSON = resolve(OUTPUT_DIR, 'latest-safari-3210-layered-single-card.json');

interface ProbeResult {
  frontApp: string;
  safariTabName: string;
  safariTabUrl: string;
  timestamp: string;
}

interface LayeredCard {
  generatedAt: string;
  currentTruth: {
    app: string;
    title: string;
    url: string;
    source: string;
  };
  historicalPublicCorroboration: string[];
  failedShellBoundaryHammer: {
    shellMeaning: string[];
    bodyMeaning: string[];
    forbiddenJumps: string[];
  };
  operativeRule: string;
  verifiableClosure: {
    claim: string;
    verifyCommand: string;
    passSignal: string;
  };
}

async function run(command: string): Promise<string> {
  const { stdout } = await exec(command, { cwd: ROOT, shell: '/bin/zsh', maxBuffer: 1024 * 1024 * 4 });
  return stdout.trim();
}

async function probe(): Promise<ProbeResult> {
  const [frontApp, safariTab, timestamp] = await Promise.all([
    run("osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'"),
    run("osascript -e 'tell application \"Safari\" to if it is running then get {name, URL} of current tab of front window'"),
    run("date '+%Y-%m-%d %H:%M %Z'")
  ]);
  const pieces = safariTab.split(', ');
  return {
    frontApp,
    safariTabName: pieces[0] || '',
    safariTabUrl: pieces.slice(1).join(', ') || '',
    timestamp
  };
}

function buildRecord(p: ProbeResult): LayeredCard {
  const historicalPublicCorroboration = [
    'https://web.wechat.com/',
    'https://web.okjike.com/publish',
    'https://channels.weixin.qq.com/platform/post/create',
    'https://weibo.com/',
    'https://www.xiaohongshu.com/publish/publish'
  ];

  const shellMeaning = [
    '发布壳/登录壳只证明曾进入某个平台入口或容器。',
    '壳层证据最多说明入口存在，不自动说明正文内容、发布对象或最终动作成立。'
  ];

  const bodyMeaning = [
    '正文级证据只认本轮当前前台 Safari 标签的真实标题与 URL。',
    '若当前页是 http://127.0.0.1:3210/，则正文真值仅限本地问路页面，不得外推为任何公开平台正文。'
  ];

  const forbiddenJumps = [
    '禁止把历史公开发布壳当作当前正在操作的正文页。',
    '禁止把 localhost/127.0.0.1 当前页包装成任何外部公开页面结果。',
    '禁止从“曾看到发布入口”直接跳到“当前正在该平台发布正文”。'
  ];

  const verifyCommand = `test "$(osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true')" = "Safari" && test "$(osascript -e 'tell application \"Safari\" to if it is running then get URL of current tab of front window')" = "http://127.0.0.1:3210/" && grep -F 'currentTruth.url=http://127.0.0.1:3210/' task_output/front-truth-line/latest-safari-3210-layered-single-card.md >/dev/null && grep -F 'historicalPublicCorroboration=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish' task_output/front-truth-line/latest-safari-3210-layered-single-card.md >/dev/null && grep -F '禁止从“曾看到发布入口”直接跳到“当前正在该平台发布正文”。' task_output/front-truth-line/latest-safari-3210-layered-single-card.md >/dev/null`;

  return {
    generatedAt: p.timestamp,
    currentTruth: {
      app: p.frontApp,
      title: p.safariTabName,
      url: p.safariTabUrl,
      source: 'live Safari front tab probe'
    },
    historicalPublicCorroboration,
    failedShellBoundaryHammer: {
      shellMeaning,
      bodyMeaning,
      forbiddenJumps
    },
    operativeRule: '凡引用本轮现场，先锁 Safari 3210 当前页；历史公开旁证只算壳层背景；正文级结论只认当前标签真值。',
    verifiableClosure: {
      claim: '当前前台真值是 Safari 的 http://127.0.0.1:3210/，历史公开旁证仅是壳层背景，且失败壳不得越级冒充正文结论。',
      verifyCommand,
      passSignal: '退出码 0'
    }
  };
}

function buildMarkdown(record: LayeredCard): string {
  return `# Safari 3210 当前真值 / 历史公开旁证 / 失败壳正文级补锤单卡\n\n生成时间：${record.generatedAt}\n\n## 当前真值\n- currentTruth.app=${record.currentTruth.app}\n- currentTruth.title=${record.currentTruth.title}\n- currentTruth.url=${record.currentTruth.url}\n- currentTruth.source=${record.currentTruth.source}\n\n## 历史公开旁证\n- historicalPublicCorroboration=${record.historicalPublicCorroboration.join('|')}\n\n## 失败壳正文级补锤\n- shellMeaning=${record.failedShellBoundaryHammer.shellMeaning.join('；')}\n- bodyMeaning=${record.failedShellBoundaryHammer.bodyMeaning.join('；')}\n- forbiddenJumps=${record.failedShellBoundaryHammer.forbiddenJumps.join('；')}\n\n## 唯一现行动作\n- ${record.operativeRule}\n\n## 外部可验证闭环\n- claim=${record.verifiableClosure.claim}\n- verifyCommand=${record.verifiableClosure.verifyCommand}\n- passSignal=${record.verifiableClosure.passSignal}\n`;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const probed = await probe();
  const record = buildRecord(probed);
  await writeFile(OUTPUT_MD, buildMarkdown(record), 'utf8');
  await writeFile(OUTPUT_JSON, JSON.stringify(record, null, 2), 'utf8');
  console.log(JSON.stringify({ md: OUTPUT_MD, json: OUTPUT_JSON, verifyCmd: record.verifiableClosure.verifyCommand }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
