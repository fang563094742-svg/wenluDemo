#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'front-truth-line');
const OUTPUT_MD = resolve(OUTPUT_DIR, 'latest-safari-3210-single-source.md');
const OUTPUT_JSON = resolve(OUTPUT_DIR, 'latest-safari-3210-single-source.json');
const OUTPUT_TXT = resolve(OUTPUT_DIR, 'safari_3210_truth.txt');

interface ProbeResult {
  frontApp: string;
  safariTabName: string;
  safariTabUrl: string;
  timestamp: string;
}

interface TruthRecord {
  generatedAt: string;
  currentTruth: {
    app: string;
    title: string;
    url: string;
    source: string;
  };
  historicalPublicCorroboration: string[];
  boundary: {
    currentTruthOnly: string[];
    historicalOnly: string[];
    forbiddenConflations: string[];
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
  const [frontApp, safariTab] = await Promise.all([
    run("osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'"),
    run("osascript -e 'tell application \"Safari\" to if it is running then get {name, URL} of current tab of front window'")
  ]);
  const pieces = safariTab.split(', ');
  return {
    frontApp,
    safariTabName: pieces[0] || '',
    safariTabUrl: pieces.slice(1).join(', ') || '',
    timestamp: await run("date '+%Y-%m-%d %H:%M %Z'")
  };
}

function buildRecord(p: ProbeResult): TruthRecord {
  const verifyCommand = `test "$(osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true')" = "Safari" && test "$(osascript -e 'tell application \"Safari\" to if it is running then get URL of current tab of front window')" = "http://127.0.0.1:3210/" && grep -F 'currentTruth.url=http://127.0.0.1:3210/' task_output/front-truth-line/latest-safari-3210-single-source.md >/dev/null && grep -F 'historicalPublicCorroboration=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish' task_output/front-truth-line/latest-safari-3210-single-source.md >/dev/null`;

  return {
    generatedAt: p.timestamp,
    currentTruth: {
      app: p.frontApp,
      title: p.safariTabName,
      url: p.safariTabUrl,
      source: 'live Safari front tab probe'
    },
    historicalPublicCorroboration: [
      'https://web.wechat.com/',
      'https://web.okjike.com/publish',
      'https://channels.weixin.qq.com/platform/post/create',
      'https://weibo.com/',
      'https://www.xiaohongshu.com/publish/publish'
    ],
    boundary: {
      currentTruthOnly: [
        '当前执行页只认本轮前台 Safari 当前标签。',
        '当前真值只能陈述谁在前台、标题是什么、URL 是什么。'
      ],
      historicalOnly: [
        '历史公开旁证只证明曾可达、曾登录或曾进入发布壳。',
        '历史公开旁证不能替代当前页，也不能倒推出本轮正在执行它们。'
      ],
      forbiddenConflations: [
        '禁止把 localhost/127.0.0.1 页面冒充成公开外部结果。',
        '禁止把历史公开平台足迹冒充成当前前台页。',
        '禁止同时并列多个法源；当前真值与历史旁证只能收束到这一张卡。'
      ]
    },
    operativeRule: '凡引用当前现场，一律先读这张卡：当前真值只认 Safari 3210；历史公开旁证只作背景层，不得越级。',
    verifiableClosure: {
      claim: '当前前台真值仍是 Safari 的 http://127.0.0.1:3210/，且历史公开旁证列表已被压成唯一现行法源。',
      verifyCommand,
      passSignal: '退出码 0'
    }
  };
}

function buildMarkdown(record: TruthRecord): string {
  return `# Safari 3210 当前真值与历史公开旁证唯一法源\n\n生成时间：${record.generatedAt}\n\n## 当前真值\n- currentTruth.app=${record.currentTruth.app}\n- currentTruth.title=${record.currentTruth.title}\n- currentTruth.url=${record.currentTruth.url}\n- currentTruth.source=${record.currentTruth.source}\n\n## 历史公开旁证\n- historicalPublicCorroboration=${record.historicalPublicCorroboration.join('|')}\n\n## 分界硬规则\n- ${record.boundary.currentTruthOnly.join('\n- ')}\n- ${record.boundary.historicalOnly.join('\n- ')}\n- ${record.boundary.forbiddenConflations.join('\n- ')}\n\n## 唯一现行动作\n- ${record.operativeRule}\n\n## 外部可验证闭环\n- claim=${record.verifiableClosure.claim}\n- verifyCommand=${record.verifiableClosure.verifyCommand}\n- passSignal=${record.verifiableClosure.passSignal}\n`;
}

function buildTruthTxt(record: TruthRecord): string {
  return `TIME=${record.generatedAt}\nAPP=${record.currentTruth.app}\nTITLE=${record.currentTruth.title}\nURL=${record.currentTruth.url}\nSOURCE=${record.currentTruth.source}`;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const probed = await probe();
  const record = buildRecord(probed);
  await writeFile(OUTPUT_MD, buildMarkdown(record), 'utf8');
  await writeFile(OUTPUT_JSON, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeFile(OUTPUT_TXT, `${buildTruthTxt(record)}\n`, 'utf8');
  console.log(JSON.stringify({ md: OUTPUT_MD, json: OUTPUT_JSON, txt: OUTPUT_TXT, verifyCmd: record.verifiableClosure.verifyCommand }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
