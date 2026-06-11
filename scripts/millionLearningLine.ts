#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LearningAsset {
  name: string;
  command: string;
  role: string;
  repeatableOutput: string;
  leverage: string;
}

interface MillionLearningLine {
  generatedAt: string;
  target: string;
  thesis: string;
  laws: string[];
  tracks: Array<{
    name: string;
    why: string;
    assets: string[];
    drills: string[];
    doneSignal: string;
  }>;
  assets: LearningAsset[];
  operatingCadence: string[];
  replicationChecklist: string[];
  nextBuilds: string[];
}

const ROOT = resolve(".");
const DATA_DIR = resolve(ROOT, "data", "capability-line");
const OUTPUT_DIR = resolve(ROOT, "task_output", "learning-line");
const OUT_JSON = resolve(DATA_DIR, "million-learning-line.json");
const OUT_MD = resolve(OUTPUT_DIR, "million-learning-line.md");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

async function main() {
  const capabilityMethods = await readJson<Array<{ path: string; name: string; reuseCommand: string; summary?: string }>>(resolve(DATA_DIR, "capability-methods.json"));
  const learningLine = await readJson<{ generatedAt: string }>(resolve(DATA_DIR, "learning-line.json"));
  const responseStrategy = await readJson<{ doctrine: string; defaultLoop: string[]; hardRules: string[] }>(resolve(DATA_DIR, "response-strategy-line.json"));
  const toolJudgment = await readJson<{ finalRuling: string; dispatchRules: string[] }>(resolve(DATA_DIR, "tool-judgment-law.json"));
  const platformTruth = await readJson<{ hardBoundaries: string[]; reusableSkeleton: string[] }>(resolve(DATA_DIR, "public-platform-truth-skeleton.json"));

  const assets: LearningAsset[] = [
    {
      name: "公开需求扫描",
      command: capabilityMethods.find((item) => item.name === "publicDemandScanner.ts")?.reuseCommand || "npx tsx scripts/publicDemandScanner.ts",
      role: "持续收集高频、可转化、可拆单的公开需求样本",
      repeatableOutput: "结构化需求清单、优先级线索、首条回复草案",
      leverage: "把‘找需求’从临场刷站点，变成持续积累的可比较样本池",
    },
    {
      name: "成交压缩",
      command: capabilityMethods.find((item) => item.name === "copyCompressor.ts")?.reuseCommand || "npx tsx scripts/copyCompressor.ts",
      role: "把长成交页压成平台首帖和私聊首回",
      repeatableOutput: "platform-post.txt、private-opening.txt、成交压缩包.md",
      leverage: "把强分发需要的大量短文案，压成可量产资产",
    },
    {
      name: "收口分诊",
      command: capabilityMethods.find((item) => item.name === "dealAccelerator.ts")?.reuseCommand || "npx tsx scripts/dealAccelerator.ts",
      role: "把线索快速推进到报价、追问、定金与开工",
      repeatableOutput: "reply.txt、payment_reply.txt、kickoff_confirmation.txt",
      leverage: "让成交动作不依赖状态，直接复用成熟收口链",
    },
    {
      name: "工具分工判词",
      command: "npx tsx scripts/toolJudgmentLaw.ts",
      role: "把人机分工、主副战位、不能做什么说清",
      repeatableOutput: "唯一法源判词卡",
      leverage: "避免每次重新争论工具怎么搭配，减少协作损耗",
    },
    {
      name: "三层真值骨架",
      command: "npx tsx data/output/publicLayeredFrontdesk.ts",
      role: "区分前台真值、公开入口、需求落盘旁证",
      repeatableOutput: "可验证三层判断卡",
      leverage: "避免把‘看过、听过、猜到’混成错误判断，保护决策质量",
    },
  ];

  const report: MillionLearningLine = {
    generatedAt: new Date().toISOString(),
    target: "按 1000 万目标重建学习主线：收集并压缩可复制成交系统、分工、强分发、高客单/高频并行的学习法源",
    thesis: "这条学习主线不是多学知识，而是持续收集真实成交样本，把找需求、发分发、私聊收口、工具分工、判断边界压成可复跑法源，最终形成能并行支撑高频进单与更高客单的系统。",
    laws: unique([
      "优先学习已经被现实打通过的成交链，而不是抽象商业概念。",
      "每次学习都必须沉淀为可复跑命令、模板或唯一法源，否则不算完成。",
      "强分发与强收口必须同时建设：只有曝光没有收口，流量白费；只有收口没有分发，单量上不来。",
      "高客单与高频单不是二选一：高频单负责现金流和样本池，高客单单负责利润和能力上探。",
      "所有判断必须分层写清证据边界，禁止把公开入口可达、历史样本和当前真值混写。",
      responseStrategy.doctrine,
      toolJudgment.finalRuling,
    ]),
    tracks: [
      {
        name: "样本收集线",
        why: "先解决‘市场里到底什么需求可接、可快收、可复制’。",
        assets: ["公开需求扫描", "三层真值骨架"],
        drills: [
          "每天至少跑一次公开需求扫描，记录高匹配需求标题、预算、工期、可切 MVP 角度。",
          "每新增一个平台样本，都用三层骨架校验‘公开入口可达’与‘需求已落盘’是否分层成立。",
        ],
        doneSignal: "形成持续增长的可比较需求池，并能说清哪些是高频、哪些值得冲更高客单。",
      },
      {
        name: "成交压缩线",
        why: "把长文案和零散经验压成强分发可直接外发的短资产。",
        assets: ["成交压缩"],
        drills: [
          "每有一份长成交页，就压成平台短帖、私聊首回、抽取规则三件套。",
          "比较不同平台帖的点击/回复反馈，继续删掉无效解释，只保留对象、痛点、三问、承诺。",
        ],
        doneSignal: "任意服务能力都能在几分钟内变成可发帖、可私聊、可复用的短成交件。",
      },
      {
        name: "收口提效线",
        why: "把进来的线索最快推进到报价、定金、开工，减少空聊。",
        assets: ["收口分诊"],
        drills: [
          "遇到真实询单先跑分诊脚本，再按平台上下文选择首回、追问、报价推进或收款口径。",
          "把成单与失单样本继续回灌到分诊规则，强化‘输入/输出/截止’三问收束。",
        ],
        doneSignal: "线索进入后，首条回复和下一跳动作几乎不靠临场发挥。",
      },
      {
        name: "分工升级线",
        why: "让工具、人力与浏览器控制面各司其职，形成并行产能。",
        assets: ["工具分工判词"],
        drills: [
          "新任务先判主刀、补位、旁路、GUI 末梢各由谁承担。",
          "每次卡住先按阻塞层级换挡，而不是盲目加动作。",
        ],
        doneSignal: "同一时间能并行推进找需求、改资产、收口回复与验证，不再单线程硬顶。",
      },
      {
        name: "高客单上探线",
        why: "在高频现金流外，持续筛出更大单的可复制切入口。",
        assets: ["公开需求扫描", "成交压缩", "收口分诊"],
        drills: [
          "从样本池里单独标记预算更高、工期更长、但可先卖 MVP 的需求类型。",
          "为这些类型补一版更强调结果、排期、边界和定金的高客单口径。",
        ],
        doneSignal: "能并行维护快单现金流与更高预算项目试探，不互相拖死。",
      },
    ],
    assets,
    operatingCadence: unique([
      "每日：扫描公开需求，补充 1 份高匹配样本。",
      "每日：至少压缩 1 份成交资产，形成可直接分发版本。",
      "每次来线索：立即跑收口分诊链，不靠手写即兴回复。",
      "每周：复盘哪些需求高频、哪些成交快、哪些预算值得升级，更新法源。",
      ...responseStrategy.defaultLoop.slice(0, 5),
    ]),
    replicationChecklist: unique([
      "是否有真实需求来源，而不是想象中的客户画像？",
      "是否已经压成平台短帖、私聊首回、报价推进三件套？",
      "是否写清主刀工具、补位工具与真实浏览器验证位？",
      "是否把高频快单与高客单试探分成两条并行队列？",
      "是否给出复跑命令、产物路径、更新法源位置？",
      ...platformTruth.hardBoundaries,
      ...toolJudgment.dispatchRules,
      ...responseStrategy.hardRules.slice(0, 3),
    ]),
    nextBuilds: [
      "把公开需求扫描结果与成交压缩结果自动串联，直接生成平台帖候选池。",
      "为高客单需求单独补‘MVP 先卖版’报价与边界模板。",
      "建立成单/失单回灌台账，用真实反馈持续修正分发与收口规则。",
    ],
  };

  const markdown = [
    "# 1000万目标学习主线法源",
    "",
    `生成时间：${report.generatedAt}`,
    `目标：${report.target}`,
    "",
    "## 核心论点",
    report.thesis,
    "",
    "## 学习总律",
    ...report.laws.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 主线分轨",
    ...report.tracks.flatMap((track, index) => [
      `### ${index + 1}. ${track.name}`,
      `为什么学：${track.why}`,
      `现成资产：${track.assets.join(" / ")}`,
      ...track.drills.map((drill) => `- ${drill}`),
      `完成信号：${track.doneSignal}`,
      "",
    ]),
    "## 可复跑资产",
    ...report.assets.flatMap((asset, index) => [
      `### ${index + 1}. ${asset.name}`,
      `命令：\`${asset.command}\``,
      `作用：${asset.role}`,
      `产物：${asset.repeatableOutput}`,
      `杠杆：${asset.leverage}`,
      "",
    ]),
    "## 运行节奏",
    ...report.operatingCadence.map((item) => `- ${item}`),
    "",
    "## 复制检查表",
    ...report.replicationChecklist.map((item) => `- ${item}`),
    "",
    "## 下一步建设",
    ...report.nextBuilds.map((item) => `- ${item}`),
    "",
    `补充说明：已复用 data/capability-line/learning-line.json（${learningLine.generatedAt}）作为现有学习线盘点底稿。`,
    ...platformTruth.reusableSkeleton.map((item) => `- 三层骨架提醒：${item}`),
  ].join("\n");

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD, `${markdown}\n`, "utf8");

  console.log(JSON.stringify({ json: OUT_JSON, markdown: OUT_MD }, null, 2));
}

void main();
