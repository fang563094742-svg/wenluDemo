#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "public-truth-skeleton");
const DATA_DIR = resolve(ROOT, "data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "public-platform-truth-skeleton.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-public-platform-truth-skeleton.md");

interface PlatformCheck {
  name: string;
  url: string;
  expectedStatus: number;
  status: number;
  ok: boolean;
  scope: string;
  verification: string;
}

interface TruthSkeleton {
  generatedAt: string;
  thesis: string;
  currentFrontdesk: {
    app: string;
    url: string;
    verification: string;
  };
  checks: PlatformCheck[];
  defaultActionRewrite: string[];
  hardBoundaries: string[];
  reusableJudgmentSkeleton: string[];
  nextVerifiableTask: {
    goal: string;
    verifyCmd: string;
  };
}

const PLATFORMS = [
  {
    name: "微信网页版公开入口",
    url: "https://web.wechat.com/",
    scope: "只证明公开入口当前可达，不等于已登录或可发送"
  },
  {
    name: "即刻发布页公开入口",
    url: "https://web.okjike.com/publish",
    scope: "只证明发布入口外网页可达，不等于账号态可发布"
  },
  {
    name: "视频号助手发帖入口",
    url: "https://channels.weixin.qq.com/platform/post/create",
    scope: "只证明平台创建页当前直连可达，不等于已进入可发态"
  }
] as const;

async function checkUrl(url: string): Promise<number> {
  const { stdout } = await execFile("curl", ["--noproxy", "*", "-L", "-s", "-o", "/dev/null", "-w", "%{http_code}", url], {
    cwd: ROOT,
    timeout: 20000,
    maxBuffer: 1024 * 1024
  });
  return Number(stdout.trim());
}

async function getChromeUrl(): Promise<string> {
  const { stdout } = await execFile("osascript", ["-e", 'tell application "Google Chrome" to if it is running then get URL of active tab of front window'], {
    cwd: ROOT,
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

function renderMarkdown(skeleton: TruthSkeleton): string {
  return [
    "# 公开平台历史旁证真值骨架",
    "",
    `- 更新时间：${skeleton.generatedAt}`,
    `- 唯一判词：${skeleton.thesis}`,
    `- 当前前台真值：${skeleton.currentFrontdesk.app} / ${skeleton.currentFrontdesk.url}`,
    `- 前台验证：${skeleton.currentFrontdesk.verification}`,
    "",
    "## 本轮外部复核",
    ...skeleton.checks.map((item) => `- ${item.name}｜${item.url}｜HTTP ${item.status}｜${item.scope}｜验证：${item.verification}`),
    "",
    "## 默认动作改写",
    ...skeleton.defaultActionRewrite.map((item) => `- ${item}`),
    "",
    "## 硬边界",
    ...skeleton.hardBoundaries.map((item) => `- ${item}`),
    "",
    "## 复用判断骨架",
    ...skeleton.reusableJudgmentSkeleton.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 下一条可验证任务",
    `- 目标：${skeleton.nextVerifiableTask.goal}`,
    `- 验证命令：\`${skeleton.nextVerifiableTask.verifyCmd}\``,
    ""
  ].join("\n");
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const currentChromeUrl = await getChromeUrl();
  const checks: PlatformCheck[] = [];

  for (const platform of PLATFORMS) {
    const status = await checkUrl(platform.url);
    checks.push({
      ...platform,
      expectedStatus: 200,
      status,
      ok: status === 200,
      verification: `curl --noproxy '*' -L -s -o /dev/null -w '%{http_code}' ${platform.url}`
    });
  }

  const verifyCmd = "bash -lc \"for u in https://web.wechat.com/ https://web.okjike.com/publish https://channels.weixin.qq.com/platform/post/create; do code=$(curl --noproxy '*' -L -s -o /dev/null -w '%{http_code}' $u); test $code = 200 || exit 1; done\"";

  const skeleton: TruthSkeleton = {
    generatedAt,
    thesis: "历史旁证只在被反复压成‘公开入口可达性真值 + 当前前台真值 + 明确边界’时才有用；任何把历史旁证偷换成当前执行页的说法都作废。",
    currentFrontdesk: {
      app: "Google Chrome",
      url: currentChromeUrl,
      verification: "osascript -e 'tell application \"Google Chrome\" to if it is running then get URL of active tab of front window'"
    },
    checks,
    defaultActionRewrite: [
      "以后先分开写‘当前前台真值’与‘公开入口历史旁证’，禁止混写成同一结论。",
      "只要公开入口复核仍是 HTTP 200，就可把它当作稳定外部旁证；但不能升级成‘已登录/已可发’。",
      "后续新增平台旁证时，统一要求：URL、HTTP 状态、边界说明、验证命令四件套同时落盘。"
    ],
    hardBoundaries: [
      "Chrome 当前前台页与公开平台历史入口不是一回事。",
      "HTTP 200 只证明公网入口可达，不证明业务权限、登录态、发送能力。",
      "没有退出码验证的旁证，不进入判断骨架。"
    ],
    reusableJudgmentSkeleton: [
      "先取当前前台页真实 URL，锁死‘正在执行什么’。",
      "再成组复核历史平台入口，记录 HTTP 状态与时间。",
      "给每个入口补一条边界说明，防止把‘可达’偷换成‘可用’。",
      "把多次稳定命中的入口压成下一轮的可验证任务与默认动作。"
    ],
    nextVerifiableTask: {
      goal: "三个公开平台入口下次复核仍全部返回 HTTP 200。",
      verifyCmd
    }
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(skeleton, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(skeleton), "utf8");

  console.log(`updated ${relative(ROOT, JSON_PATH)}`);
  console.log(`updated ${relative(ROOT, MD_PATH)}`);
}

void main();
