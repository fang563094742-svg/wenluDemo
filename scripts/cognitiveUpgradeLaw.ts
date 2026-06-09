#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface CognitiveSource {
  id: string;
  title: string;
  path: string;
  role: string;
}

interface DecisionQuestion {
  id: string;
  prompt: string;
}

interface CognitiveUpgradeLaw {
  generatedAt: string;
  mission: string;
  doctrine: string;
  defaultSequence: string[];
  mandatoryQuestions: DecisionQuestion[];
  decisionOutputs: string[];
  hardRules: string[];
  antiPatterns: string[];
  sourceOfTruth: CognitiveSource[];
  activation: {
    beforeDecision: string[];
    duringDecision: string[];
    afterDecision: string[];
  };
  templates: {
    quickCheck: string[];
    commanderDebrief: string[];
  };
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve("task_output", "cognitive-upgrade-line");
const DATA_DIR = resolve("data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "cognitive-upgrade-law.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-cognitive-upgrade-law.md");
const SOURCES = [
  "问路判断骨架v2.md",
  "问路判断骨架补强清单.md",
  "问路现行判断卡｜《资治通鉴》× 帝王术骨架唯一现行入口.md"
];

void main();

async function main() {
  await Promise.all(SOURCES.map((file) => readFile(resolve(file), "utf8")));

  const law: CognitiveUpgradeLaw = {
    generatedAt: new Date().toISOString(),
    mission: "持续增强智商线：围绕判断骨架、第一性原理、提问法与统帅式决策结构，形成会改变默认动作的认知升级法源。",
    doctrine: "先定标，再判阶段；先看势，再校史；先拆利益与命门，再打假归本；最后只落四类决策，并强制留后手。",
    defaultSequence: [
      "定目标：先写真结果、验收指标、时间窗口。",
      "判阶段：先分起盘、扩张、整顿、收缩、转折。",
      "看势：先看是否顺长期趋势、是否在降阻力。",
      "校史：先看同类局常见成法与死法。",
      "拆权：先识别真决策者、真交付者、真拖延者。",
      "找命门：先定位信息、资源、验收三类单点风险。",
      "打假：先写关键假设、证据缺口、最强反例。",
      "归本：先拆底层约束、最小闭环、替代路径。",
      "成局：先明确推进责任、验收方式、补位安排。",
      "落决：只在马上做 / 小步试 / 暂不做 / 明确不做里选四选一。",
      "留后手：先写败法、止损点、接盘人与替代方案。"
    ],
    mandatoryQuestions: [
      { id: "goal", prompt: "真结果是什么，验收指标是什么，窗口还有多长？" },
      { id: "stage", prompt: "当前处于起盘、扩张、整顿、收缩还是转折？当前最怕慢、乱还是错？" },
      { id: "trend", prompt: "这件事是在顺势降阻，还是逆势堆复杂度？" },
      { id: "history", prompt: "同类事过去通常怎么成、怎么败，当前最像哪一段？" },
      { id: "power", prompt: "谁真有权、谁真交付、谁口头支持但实际拖延？" },
      { id: "chokepoint", prompt: "哪个信息、资源、验收节点一旦失控会绑架全局？" },
      { id: "assumption", prompt: "结论依赖哪些前提，这些前提有证据还是只是感觉？" },
      { id: "counterexample", prompt: "如果结论相反，最强论据是什么，我为什么可能错？" },
      { id: "first-principles", prompt: "底层问题到底是什么，哪些是客观约束，哪些只是路径依赖？" },
      { id: "closure", prompt: "最小闭环、止损点、替代路径和接盘人分别是什么？" }
    ],
    decisionOutputs: ["马上做", "小步试", "暂不做", "明确不做"],
    hardRules: [
      "没有目标定义，不进入方案讨论。",
      "没有阶段判断，不给最终打法。",
      "没有利益分析的判断，默认不完整。",
      "没有反例审查的自信，默认打折。",
      "没有止损点的行动，不算成熟决策。",
      "重要链路不允许单点同时吃住信息、资源、验收三权。",
      "先小实验，再大投入；先验证，再放量。",
      "缺少关键事实穿透时，只能给暂定判断。"
    ],
    antiPatterns: [
      "拿‘再看看’冒充决策。",
      "只堆建议，不给推进结构与验收。",
      "听表态代替看交付。",
      "情绪最强时直接下最终判断。",
      "沿旧流程修补，却不拆底层问题。",
      "扩张时只冲不治，收缩时先乱砍核心链路。"
    ],
    sourceOfTruth: [
      {
        id: "five-discipline-core",
        title: "问路判断骨架 v2",
        path: "问路判断骨架v2.md",
        role: "五家总骨架与九步默认顺序"
      },
      {
        id: "reinforcement-checklist",
        title: "问路判断骨架补强清单",
        path: "问路判断骨架补强清单.md",
        role: "强制提问清单与一页套用模板"
      },
      {
        id: "stage-power-card",
        title: "问路现行判断卡｜《资治通鉴》× 帝王术骨架唯一现行入口",
        path: "问路现行判断卡｜《资治通鉴》× 帝王术骨架唯一现行入口.md",
        role: "阶段判断、用人、控权、退路的现行动作法源"
      }
    ],
    activation: {
      beforeDecision: [
        "先把问题改写成一句话决策题。",
        "先写目标、阶段、最怕的失败类型。",
        "若无法穿透原始事实，先补证据再判断。"
      ],
      duringDecision: [
        "每次至少回答 10 个强制问题中的 8 个。",
        "若缺 3 项以上，只允许输出暂定判断或小步试。",
        "先攻击自己的方案，再保护自己的方案。"
      ],
      afterDecision: [
        "记录止损点是否清晰，是否存在备份链路。",
        "复盘是否误把表态当交付、误把感觉当证据。",
        "把有效结构沉淀为下次更快调用的模板。"
      ]
    },
    templates: {
      quickCheck: [
        "问题：",
        "目标 / 指标 / 窗口：",
        "阶段 / 当前最怕：",
        "顺势点 / 逆势点：",
        "同类死法 / 当前最像：",
        "真决策者 / 真交付者 / 真拖延者：",
        "命门 / 单点风险：",
        "关键假设 / 证据 / 最强反例：",
        "底层约束 / 最小闭环 / 替代路径：",
        "结论：马上做 / 小步试 / 暂不做 / 明确不做",
        "止损点 / 接盘人："
      ],
      commanderDebrief: [
        "这次判断最先定清的目标是什么？",
        "最关键的阶段判断是什么？",
        "最终否决或推进的核心证据是什么？",
        "哪个命门被补上了，哪个命门仍未补上？",
        "如果结果出错，最可能错在什么假设？"
      ]
    }
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(law, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(law), "utf8");

  console.log(`认知升级法源已生成: ${relative(ROOT, MD_PATH)}`);
}

function renderMarkdown(law: CognitiveUpgradeLaw): string {
  return [
    "# 智商线认知升级法源",
    "",
    `- 生成时间：${law.generatedAt}`,
    `- 使命：${law.mission}`,
    `- 总诀：${law.doctrine}`,
    "",
    "## 默认顺序",
    ...law.defaultSequence.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 强制问题",
    ...law.mandatoryQuestions.map((item) => `- ${item.id}: ${item.prompt}`),
    "",
    "## 决策输出",
    ...law.decisionOutputs.map((item) => `- ${item}`),
    "",
    "## 硬规则",
    ...law.hardRules.map((item) => `- ${item}`),
    "",
    "## 反空转警报",
    ...law.antiPatterns.map((item) => `- ${item}`),
    "",
    "## 法源文件",
    ...law.sourceOfTruth.map((item) => `- ${item.title}｜${item.path}｜${item.role}`),
    "",
    "## 启动动作",
    "### 判断前",
    ...law.activation.beforeDecision.map((item) => `- ${item}`),
    "### 判断中",
    ...law.activation.duringDecision.map((item) => `- ${item}`),
    "### 判断后",
    ...law.activation.afterDecision.map((item) => `- ${item}`),
    "",
    "## 快速模板",
    ...law.templates.quickCheck.map((item) => `- ${item}`),
    "",
    "## 统帅式复盘",
    ...law.templates.commanderDebrief.map((item) => `- ${item}`)
  ].join("\n");
}
