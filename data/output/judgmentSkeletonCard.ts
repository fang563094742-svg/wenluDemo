#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface DemandSignal {
  source: string;
  claim: string;
  defaultActionRewrite: string;
  evidencePath: string;
}

interface BoundarySignal {
  source: string;
  claim: string;
  defaultActionRewrite: string;
  evidencePath: string;
}

interface IncidentSignal {
  source: string;
  claim: string;
  defaultActionRewrite: string;
  evidencePath: string;
}

interface CognitiveCard {
  generatedAt: string;
  mission: string;
  thesis: string;
  sources: string[];
  publicInternetScan: DemandSignal[];
  userBoundary: BoundarySignal[];
  executionIncidents: IncidentSignal[];
  defaultSequence: string[];
  hardRules: string[];
  frontdeskReport: string[];
}

const OUTPUT_DIR = resolve("task_output", "cognitive-upgrade-line");
const DATA_DIR = resolve("data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "judgment-skeleton-card.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-judgment-skeleton-card.md");

async function read(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

function extractTimestamp(text: string): string {
  const line = text.split("\n").find((item) => /生成时间|更新时间|时间：/.test(item));
  return line?.trim() ?? "时间未标注";
}

function buildMarkdown(card: CognitiveCard): string {
  return [
    "# 判断骨架升级前台总卡",
    "",
    `- 更新时间：${card.generatedAt}`,
    `- 任务：${card.mission}`,
    `- 唯一判词：${card.thesis}`,
    "",
    "## 公开互联网扫描改写",
    ...card.publicInternetScan.map((item) => `- ${item.source}｜判断：${item.claim}｜改写默认动作：${item.defaultActionRewrite}｜证据：${item.evidencePath}`),
    "",
    "## 用户边界改写",
    ...card.userBoundary.map((item) => `- ${item.source}｜判断：${item.claim}｜改写默认动作：${item.defaultActionRewrite}｜证据：${item.evidencePath}`),
    "",
    "## 执行事故改写",
    ...card.executionIncidents.map((item) => `- ${item.source}｜判断：${item.claim}｜改写默认动作：${item.defaultActionRewrite}｜证据：${item.evidencePath}`),
    "",
    "## 新默认动作顺序",
    ...card.defaultSequence.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 硬规则",
    ...card.hardRules.map((item) => `- ${item}`),
    "",
    "## 前台三行汇报模板",
    ...card.frontdeskReport.map((item) => `- ${item}`),
    "",
    "## 法源引用",
    ...card.sources.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

void main();

async function main(): Promise<void> {
  const [
    demandLaw,
    boundaryCard,
    responseLaw,
    cognitiveLaw,
    antiSlipCard,
    parallelCard
  ] = await Promise.all([
    read("task_output/gap-judgment-line/latest-gap-judgment-law.md"),
    read("data/output/owner-understanding-gap-line-current-card.md"),
    read("task_output/response-strategy-line/latest-response-strategy-line.md"),
    read("task_output/cognitive-upgrade-line/latest-cognitive-upgrade-law.md"),
    read("data/output/第1177次呼吸-默认动作防回滑卡.md"),
    read("data/output/第1233次呼吸-并行执行面现行判词.md")
  ]);

  const card: CognitiveCard = {
    generatedAt: new Date().toISOString(),
    mission: "持续升级判断骨架：把公开互联网扫描、用户边界与执行事故沉淀为会改写默认动作的智力卡，并前台显性汇报。",
    thesis: "只有当公开世界信号、主人边界和执行事故同时进入同一默认动作顺序，判断骨架才算真正升级；否则只是散点材料。",
    sources: [
      `公开互联网扫描法源｜task_output/gap-judgment-line/latest-gap-judgment-law.md｜${extractTimestamp(demandLaw)}`,
      `用户边界法源｜data/output/owner-understanding-gap-line-current-card.md｜${extractTimestamp(boundaryCard)}`,
      `执行事故法源｜task_output/response-strategy-line/latest-response-strategy-line.md｜${extractTimestamp(responseLaw)}`,
      `认知升级法源｜task_output/cognitive-upgrade-line/latest-cognitive-upgrade-law.md｜${extractTimestamp(cognitiveLaw)}`,
      `防回滑法源｜data/output/第1177次呼吸-默认动作防回滑卡.md｜${extractTimestamp(antiSlipCard)}`,
      `并行执行面法源｜data/output/第1233次呼吸-并行执行面现行判词.md｜${extractTimestamp(parallelCard)}`
    ],
    publicInternetScan: [
      {
        source: "外部扫描赚钱缝隙判断骨架",
        claim: "公开扫描不再以‘多看到线索’计数，而只看能否压成输入/输出/截止三件事并进入最短可发件。",
        defaultActionRewrite: "以后先分诊线索能否 1~3 天闭环，再决定追问/报价/拒绝；禁止先扩写分析。",
        evidencePath: "task_output/gap-judgment-line/latest-gap-judgment-law.md"
      }
    ],
    userBoundary: [
      {
        source: "主人理解缩差唯一现行卡",
        claim: "当前唯一合格推进是锁死默认动作、防回滑、留前台证据，而不是继续证明‘我懂主人’。",
        defaultActionRewrite: "每轮先检查动作是否服务于防回滑；不服务则降级或暂停。",
        evidencePath: "data/output/owner-understanding-gap-line-current-card.md"
      },
      {
        source: "默认动作防回滑卡",
        claim: "先交付 3 分钟内可用的最小有用件，再允许一句话请主人裁决。",
        defaultActionRewrite: "先做最小可验成品，禁止未交付先扩讲旧线。",
        evidencePath: "data/output/第1177次呼吸-默认动作防回滑卡.md"
      }
    ],
    executionIncidents: [
      {
        source: "应对策略线默认作战机制",
        claim: "连续两轮无增量就必须换挡；没有证据增量的长解释一律视为空转。",
        defaultActionRewrite: "以后同路复试两次失败即切诊断/旁路/降配，不再硬顶。",
        evidencePath: "task_output/response-strategy-line/latest-response-strategy-line.md"
      },
      {
        source: "并行执行面现行判词",
        claim: "持续任务若不先显性挂线，前台就只会看到文字而非接管。",
        defaultActionRewrite: "以后先挂任务线与阻塞，再谈判断与方案。",
        evidencePath: "data/output/第1233次呼吸-并行执行面现行判词.md"
      }
    ],
    defaultSequence: [
      "先挂当前任务线、目标和唯一阻塞，让执行面先显形。",
      "先读用户边界卡，确认动作是否服务于‘锁默认动作、防回滑、留前台证据’。",
      "再用公开互联网扫描骨架分诊外部信号，只收输入/输出/截止三件事。",
      "若开始执行，按阻塞识别法每轮检查有无新证据；连续两轮无增量立即换挡。",
      "每轮只允许落一个最小可验件，并明确它改写了哪条默认动作。",
      "前台汇报只用三行：新证据、改写动作、下一缺口。"
    ],
    hardRules: [
      "没有前台显性任务线，不算已接管。",
      "没有边界校验的动作，默认可能回滑。",
      "公开扫描线索若不能压成输入/输出/截止，不进入长分析。",
      "连续两轮无证据增量，必须换挡。",
      "没有最小可验成品，只能算整理，不能算升级。",
      "前台汇报必须指出‘它改写了哪条默认动作’，禁止只报完成。"
    ],
    frontdeskReport: [
      "新补进的公开信号 / 边界 / 事故证据是什么。",
      "它把哪条默认动作改写成了什么。",
      "下一轮唯一缺口与下一步最小件是什么。"
    ]
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await Promise.all([
    writeFile(JSON_PATH, JSON.stringify(card, null, 2) + "\n", "utf8"),
    writeFile(MD_PATH, buildMarkdown(card), "utf8")
  ]);

  console.log(`判断骨架升级卡已生成: ${MD_PATH}`);
}
