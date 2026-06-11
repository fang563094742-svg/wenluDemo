#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface EnforcementTask {
  id: string;
  goal: string;
  verifyCmd: string;
  difficulty: number;
  successSignal: string;
}

interface EnforcementLaw {
  generatedAt: string;
  mission: string;
  singleActiveLaw: string;
  judgmentThreshold: string[];
  actionDeadline: string[];
  defaultSequence: string[];
  hardRules: string[];
  verificationTasks: EnforcementTask[];
  evidence: string[];
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "judgment-deadline-law");
const DATA_DIR = resolve(ROOT, "data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "judgment-deadline-law.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-judgment-deadline-law.md");
const CHAIN_PATH = resolve(ROOT, "data", "verifiable-task-chain", "task-chain.json");

const EVIDENCE_FILES = [
  "data/capability-line/judgment-skeleton-card.json",
  "data/capability-line/judgment-upgrade-law.json",
  "data/output/第1226次呼吸-17点前唯一现行进化约束卡.md"
];

void main();

async function main() {
  const evidence = await Promise.all(EVIDENCE_FILES.map(readEvidenceSignal));

  const law: EnforcementLaw = {
    generatedAt: new Date().toISOString(),
    mission: "把‘判断门槛 + 动作时限’压成唯一现行军法卡，并让每轮执行都能被客观验尸。",
    singleActiveLaw: "只有同时过‘判断门槛’与‘动作时限’两道闸，动作才算现行合法；任一未过，都必须降级为补证据或停止。",
    judgmentThreshold: [
      "先回答 10 个强制判断问题中的至少 8 个，缺 3 项以上不得给最终打法。",
      "先写唯一目标、唯一阻塞、唯一默认动作；没有唯一阻塞，禁止并列多方向。",
      "先结旧预测、再读现行法源；未完成任一项，不得引用旧判断当前台结论。"
    ],
    actionDeadline: [
      "从写下唯一阻塞开始，15 分钟内必须产出一个最小可验件。",
      "最小可验件只能是 rule / verifiable task / prediction / 可复跑脚本 四类之一。",
      "连续两轮没有新增证据或没有新的最小可验件，必须换挡，不得继续扩写分析。"
    ],
    defaultSequence: [
      "读：先读判断骨架卡、判断升级法源、17点前唯一现行约束卡。",
      "判：先检查 10 问完成数，再写唯一目标 / 唯一阻塞 / 唯一默认动作。",
      "做：启动 15 分钟动作时限，只允许交付一个最小可验件。",
      "验：立即跑验证命令，确认产物存在且正文包含门槛与时限军法。",
      "收：把任务写入可验证任务链，后续引用只认这张唯一军法卡。"
    ],
    hardRules: [
      "未过判断门槛，不得推进最终动作。",
      "超出动作时限仍无最小可验件，默认判为本轮失手。",
      "文件存在不能冒充动作完成，必须有验证命令退出码 0。",
      "后续凡提判断军法，只允许引用本法源，不再并列旧卡。"
    ],
    verificationTasks: [
      {
        id: "judgment-deadline-law-files",
        goal: "唯一现行军法卡 JSON 与 Markdown 产物同时落盘。",
        verifyCmd: "test -f data/capability-line/judgment-deadline-law.json && test -f task_output/judgment-deadline-law/latest-judgment-deadline-law.md",
        difficulty: 1,
        successSignal: "两个法源文件同时存在。"
      },
      {
        id: "judgment-deadline-law-content",
        goal: "Markdown 军法卡正文明确包含‘10 问至少 8 项’与‘15 分钟最小可验件’。",
        verifyCmd: "rg -q '10 个强制判断问题中的至少 8 个|15 分钟内必须产出一个最小可验件' task_output/judgment-deadline-law/latest-judgment-deadline-law.md",
        difficulty: 2,
        successSignal: "关键门槛与时限可被正文检出。"
      },
      {
        id: "judgment-deadline-law-chain",
        goal: "可验证任务链已登记这张唯一军法卡的双重校验任务。",
        verifyCmd: "rg -q 'judgment-deadline-law-content' data/verifiable-task-chain/task-chain.json && rg -q 'judgment-deadline-law-files' data/verifiable-task-chain/task-chain.json",
        difficulty: 2,
        successSignal: "任务链已收录双校验任务。"
      }
    ],
    evidence
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, `${JSON.stringify(law, null, 2)}\n`, "utf8");
  await writeFile(MD_PATH, renderMarkdown(law), "utf8");
  await updateTaskChain(law.verificationTasks);

  console.log(`updated ${relative(ROOT, JSON_PATH)}`);
  console.log(`updated ${relative(ROOT, MD_PATH)}`);
  console.log(`updated ${relative(ROOT, CHAIN_PATH)}`);
}

async function readEvidenceSignal(path: string) {
  const text = await readFile(resolve(ROOT, path), "utf8");
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("{") && !line.startsWith("[") && !line.startsWith("#"));
  return `${path}：${firstLine ?? "已读，无空白证据行"}`;
}

async function updateTaskChain(tasks: EnforcementTask[]) {
  const existing = JSON.parse(await readFile(CHAIN_PATH, "utf8")) as Array<Record<string, unknown>>;
  const retained = existing.filter((item) => {
    const id = String(item.id ?? "");
    return !tasks.some((task) => task.id === id);
  });
  const stamped = tasks.map((task) => ({
    id: task.id,
    goal: task.goal,
    verifyCmd: task.verifyCmd,
    difficulty: task.difficulty,
    createdAt: new Date().toISOString()
  }));
  await writeFile(CHAIN_PATH, `${JSON.stringify([...retained, ...stamped], null, 2)}\n`, "utf8");
}

function renderMarkdown(law: EnforcementLaw) {
  const sections = [
    "# 判断门槛 + 动作时限唯一现行军法卡",
    "",
    `生成时间：${law.generatedAt}`,
    `使命：${law.mission}`,
    `唯一判词：${law.singleActiveLaw}`,
    "",
    "## 判断门槛",
    ...law.judgmentThreshold.map((item) => `- ${item}`),
    "",
    "## 动作时限",
    ...law.actionDeadline.map((item) => `- ${item}`),
    "",
    "## 默认顺序",
    ...law.defaultSequence.map((item) => `- ${item}`),
    "",
    "## 硬规则",
    ...law.hardRules.map((item) => `- ${item}`),
    "",
    "## 可验证任务",
    ...law.verificationTasks.flatMap((task) => [
      `- ${task.id}｜${task.goal}`,
      `  - verifyCmd: ${task.verifyCmd}`,
      `  - successSignal: ${task.successSignal}`
    ]),
    "",
    "## 证据来源",
    ...law.evidence.map((item) => `- ${item}`),
    ""
  ];
  return sections.join("\n");
}
