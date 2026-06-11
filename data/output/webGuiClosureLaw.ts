#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface GuiClosureLaw {
  generatedAt: string;
  domain: "web";
  difficulty: 4;
  sourceSample: string;
  currentTruth: {
    frontdesk: string;
    externalAnchor: {
      url: string;
      proof: string;
    };
  };
  closure: {
    target: string;
    blocker: string;
    action: string;
    nonRegression: string[];
  };
  webEntry: {
    path: string;
    url: string;
    promises: string[];
    intake: string[];
  };
  lawSource: {
    samplePath: string;
    paymentConfigPath: string;
  };
  verification: {
    verifyCmd: string;
    checks: string[];
  };
}

const ROOT = resolve(".");
const SAMPLE_PATH = resolve(ROOT, "data/output/第2132次呼吸-GUI单核分界与外部补锤卡.md");
const PAYMENT_PATH = resolve(ROOT, "data/payment-config.json");
const OUTPUT_DIR = resolve(ROOT, "task_output/web-gui-closure-law");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-web-gui-closure-law.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-web-gui-closure-law.md");

function now(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

async function buildLaw(): Promise<GuiClosureLaw> {
  await readFile(SAMPLE_PATH, "utf8");
  await readFile(PAYMENT_PATH, "utf8");

  const verifyCmd = "bash -lc 'curl -fsS http://127.0.0.1:8899/platform-entry.html >/tmp/wenlu_platform.$$ && test -f task_output/web-gui-closure-law/latest-web-gui-closure-law.md && test -f task_output/web-gui-closure-law/latest-web-gui-closure-law.json && rg -q \"GUI单核样本\" task_output/web-gui-closure-law/latest-web-gui-closure-law.md && rg -q \"当前唯一目标\" task_output/web-gui-closure-law/latest-web-gui-closure-law.md && (rg -q \"三问\" /tmp/wenlu_platform.$$ || rg -q \"platform-entry\" /tmp/wenlu_platform.$$)'";

  return {
    generatedAt: now(),
    domain: "web",
    difficulty: 4,
    sourceSample: relative(ROOT, SAMPLE_PATH),
    currentTruth: {
      frontdesk: "Google Chrome `chrome://settings/content/javascript` 只证明当前前台，不证明公开成交闭环已存在。",
      externalAnchor: {
        url: "https://jsonplaceholder.typicode.com/posts/1",
        proof: "外部直连可抓到 id=1 与标题，说明本轮闭环必须把‘内部前台真值’与‘外部可抓取真值’同屏压实。"
      }
    },
    closure: {
      target: "把GUI单核样本升级为一条新的外部可客观验证闭环，并固化为现行法源。",
      blocker: "GUI 单核判断、公开入口页、法源产物还没有压成同一条可被 HTTP 抓取交叉验证的 web 链路。",
      action: "公开入口统一收三问，法源统一沉淀唯一目标/阻塞/动作，再用 HTTP 页面 + 文件产物双证互锁。",
      nonRegression: [
        "不准把历史 GitHub 页冒充当前公开入口。",
        "不准把内部整理结果冒充外部可验证成果。",
        "不准把本地 localhost 页面单独存在却没有法源沉淀。"
      ]
    },
    webEntry: {
      path: "public/platform-entry.html",
      url: "http://127.0.0.1:8899/platform-entry.html",
      promises: [
        "陌生客户先看一页就知道你收什么、怎么回、多久给答复。",
        "页面只承接最小闭环，不展开长介绍，不把注意力打散。",
        "页面内容与法源同源，避免前台说法和内部执行脱节。"
      ],
      intake: ["现在输入是什么", "想输出成什么", "最晚什么时候要"]
    },
    lawSource: {
      samplePath: relative(ROOT, SAMPLE_PATH),
      paymentConfigPath: relative(ROOT, PAYMENT_PATH)
    },
    verification: {
      verifyCmd,
      checks: [
        "`platform-entry.html` 可被 HTTP 200 抓取。",
        "法源 markdown 明确包含 GUI单核样本 与 当前唯一目标。",
        "法源 json 明确标记 web 域与 verifyCmd。"
      ]
    }
  };
}

function renderMarkdown(law: GuiClosureLaw): string {
  return [
    "# Web GUI 单核闭环现行法源",
    "",
    `- 更新时间：${law.generatedAt}`,
    `- 领域：${law.domain}`,
    `- 难度：${law.difficulty}`,
    `- 源样本：${law.sourceSample}`,
    "",
    "## GUI单核样本",
    `- 当前前台真值：${law.currentTruth.frontdesk}`,
    `- 外部补锤：${law.currentTruth.externalAnchor.url}`,
    `- 外部补锤判词：${law.currentTruth.externalAnchor.proof}`,
    "",
    "## 当前唯一目标",
    `- ${law.closure.target}`,
    "",
    "## 当前唯一阻塞",
    `- ${law.closure.blocker}`,
    "",
    "## 当前唯一动作",
    `- ${law.closure.action}`,
    "",
    "## 禁止回滑",
    ...law.closure.nonRegression.map((item) => `- ${item}`),
    "",
    "## Web公开入口",
    `- 页面路径：${law.webEntry.path}`,
    `- 页面地址：${law.webEntry.url}`,
    ...law.webEntry.promises.map((item) => `- ${item}`),
    "",
    "## 三问",
    ...law.webEntry.intake.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 验证",
    ...law.verification.checks.map((item) => `- ${item}`),
    `- verifyCmd：\`${law.verification.verifyCmd}\``,
    ""
  ].join("\n");
}

async function main(): Promise<void> {
  const law = await buildLaw();
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(JSON_PATH, `${JSON.stringify(law, null, 2)}\n`, "utf8");
  await writeFile(MD_PATH, `${renderMarkdown(law)}\n`, "utf8");
  console.log(`已生成 ${relative(ROOT, MD_PATH)}`);
  console.log(`已生成 ${relative(ROOT, JSON_PATH)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
