#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LawSource {
  id: string;
  title: string;
  kind: "current-truth" | "historical-corroboration" | "doctrine";
  rule: string;
  verification: string;
}

interface JudgmentLaw {
  title: string;
  updatedAt: string;
  mission: string;
  defaultJudgmentMartialLaw: string;
  triggerScope: string[];
  executionOrder: string[];
  hardRules: string[];
  antiPatterns: string[];
  reviewChecklist: string[];
  lawSources: LawSource[];
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "front-truth-law");
const JSON_PATH = resolve(ROOT, "data", "capability-line", "front-truth-law.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-front-truth-law.md");

const DEFAULT_JUDGMENT_MARTIAL_LAW = "同主题第一句先锁当前前台真值，再谈历史旁证。";

const law: JudgmentLaw = {
  title: "问路默认判断军法｜同主题先锁前台真值",
  updatedAt: new Date().toISOString(),
  mission: "把同主题判断的默认顺序钉死为：先核当前前台真值，再引入历史旁证，避免把旧观察、缓存印象、历史材料误判成当前事实。",
  defaultJudgmentMartialLaw: DEFAULT_JUDGMENT_MARTIAL_LAW,
  triggerScope: [
    "同一主题同时存在当前页面/当前前台状态与历史记录时",
    "需要引用浏览历史、旧页面、旧截图、旧结论作为补充证据时",
    "任何可能把‘现在看到的’与‘以前看过的’混说的判断场景"
  ],
  executionOrder: [
    "先写一句当前前台真值：此刻前台正在显示什么、聚焦什么、处于什么状态。",
    "若当前前台真值未锁定，先补采当前前台证据，不许直接下结论。",
    "当前真值锁定后，才允许追加历史旁证，并明确标注它不是当前页。",
    "若历史旁证与当前前台冲突，以当前前台真值为主，并把冲突单列。",
    "最终表述必须能拆成两层：当前真值层 / 历史旁证层。"
  ],
  hardRules: [
    "没有当前前台真值，不得把历史材料写成现状。",
    "历史旁证只能补充、解释、对比，不能越级替代当前前台真值。",
    "同主题第一句必须先报当前前台真值，不能先讲回忆、缓存或旧截图。",
    "引用历史旁证时必须显式标注‘历史旁证，非当前页/非当前前台’。",
    "若拿不到当前前台真值，结论只能降级为待核，不得伪装确定。"
  ],
  antiPatterns: [
    "先复述旧观察，再补一句‘现在应该也是这样’。",
    "把浏览历史摘要、之前卡片、旧证据直接当前台现状使用。",
    "当前页未核就用历史旁证抢答。",
    "把‘曾经出现过’写成‘现在正在发生’。"
  ],
  reviewChecklist: [
    "第一句是否明确交代当前前台真值？",
    "历史旁证是否与当前真值分层表述？",
    "是否存在用旧材料替代当前核验的句子？",
    "若当前真值缺失，是否已明确降级为待核？"
  ],
  lawSources: [
    {
      id: "front-truth-priority",
      title: "当前前台真值优先",
      kind: "current-truth",
      rule: "同主题判断时，先核此刻前台真实显示，再允许引用任何历史材料。",
      verification: "检查最终表述第一句是否只描述当前前台状态，而非历史摘要。"
    },
    {
      id: "history-secondary",
      title: "历史旁证只作旁证",
      kind: "historical-corroboration",
      rule: "历史记录只能作为补充、比对、解释来源，不能替代当前前台核验。",
      verification: "检查每条历史材料是否带有‘历史旁证/非当前页’标签。"
    },
    {
      id: "conflict-resolution",
      title: "冲突时以前台为主",
      kind: "doctrine",
      rule: "当历史材料与当前前台冲突时，优先采信当前前台真值，并显式记录冲突。",
      verification: "遇到冲突时，检查结论是否先写当前状态，再单列历史冲突。"
    }
  ]
};

void main();

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(resolve(ROOT, "data", "capability-line"), { recursive: true });

  await writeFile(JSON_PATH, JSON.stringify(law, null, 2), "utf8");
  await writeFile(MD_PATH, buildMarkdown(law), "utf8");

  console.log(`wrote ${JSON_PATH}`);
  console.log(`wrote ${MD_PATH}`);
}

function buildMarkdown(model: JudgmentLaw): string {
  return [
    `# ${model.title}`,
    "",
    `更新时间：${model.updatedAt}`,
    "",
    "## 任务目标",
    model.mission,
    "",
    "## 默认判断军法",
    `- ${model.defaultJudgmentMartialLaw}`,
    "",
    "## 触发范围",
    ...model.triggerScope.map((item) => `- ${item}`),
    "",
    "## 默认执行顺序",
    ...model.executionOrder.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 硬规则",
    ...model.hardRules.map((item) => `- ${item}`),
    "",
    "## 反模式",
    ...model.antiPatterns.map((item) => `- ${item}`),
    "",
    "## 复核清单",
    ...model.reviewChecklist.map((item) => `- ${item}`),
    "",
    "## 可复核法源",
    ...model.lawSources.flatMap((source) => [
      `### ${source.title}`,
      `- 编号：${source.id}`,
      `- 类型：${source.kind}`,
      `- 法条：${source.rule}`,
      `- 复核法：${source.verification}`,
      ""
    ])
  ].join("\n");
}
