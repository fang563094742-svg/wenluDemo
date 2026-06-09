#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface LawSource {
  title: string;
  path: string;
  role: string;
}

interface UpgradeTask {
  id: string;
  goal: string;
  verifyCmd: string;
  difficulty: number;
  successSignal: string;
}

interface JudgmentUpgradeLaw {
  generatedAt: string;
  mission: string;
  singleGap: string;
  doctrine: string;
  defaultActionSystem: string[];
  hardRules: string[];
  antiRollbackTriggers: string[];
  mandatoryLoop: string[];
  verifiableTasks: UpgradeTask[];
  lawsToReadFirst: LawSource[];
  evidence: string[];
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "judgment-upgrade-line");
const DATA_DIR = resolve(ROOT, "data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "judgment-upgrade-law.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-judgment-upgrade-law.md");

const SOURCE_FILES: LawSource[] = [
  {
    title: "第1163次呼吸-旧壳回滑处决与唯一默认约束卡",
    path: "data/output/第1163次呼吸-旧壳回滑处决与唯一默认约束卡.md",
    role: "定义旧壳回滑禁令与默认动作切换条件"
  },
  {
    title: "第1284次呼吸-敢拍板最小决策卡",
    path: "data/output/第1284次呼吸-敢拍板最小决策卡.md",
    role: "定义唯一目标/唯一阻塞/唯一动作的裁决骨架"
  },
  {
    title: "第1226次呼吸-17点前唯一现行进化约束卡",
    path: "data/output/第1226次呼吸-17点前唯一现行进化约束卡.md",
    role: "定义先结旧预测、先认法源真实路径的高位约束"
  }
];

void main();

async function main() {
  const evidence = await Promise.all(
    SOURCE_FILES.map(async (item) => {
      const text = await readFile(resolve(ROOT, item.path), "utf8");
      const firstSignal = pickFirstSignal(text);
      return `${item.title}：${firstSignal}`;
    })
  );

  const law: JudgmentUpgradeLaw = {
    generatedAt: new Date().toISOString(),
    mission: "持续升级判断骨架与默认动作系统，把新学到的规律压成现行法源、规则与可验证任务，避免回滑旧壳。",
    singleGap: "不是缺更多分析，而是缺一条每轮都会先执行的升级闭环：结旧预测→读现行法源→压唯一阻塞→声明并验证任务。",
    doctrine: "每轮优先缩小会改变默认动作的唯一差距；凡不能改变下轮默认动作的忙碌，一律不算升级。",
    defaultActionSystem: [
      "先结算已具现实证据的旧预测，再允许沿同主题继续判断。",
      "先读回现行法源，再压成唯一目标 / 唯一阻塞 / 唯一默认动作。",
      "若动作不能直接缩小唯一差距，不执行；若只能制造整理感，也不执行。",
      "每轮至少新增一条能约束后续行为的规则、或一条可被现实验证的任务。",
      "任何“接近结果”的口径都必须先过验证命令；没有退出码 0 的证据，只能降回准备完成。"
    ],
    hardRules: [
      "没有先读现行法源，不得引用旧判断充当前台结论。",
      "没有唯一阻塞，不得并列抛出多个候选方向让主人承担选择疲劳。",
      "没有可验证任务，不得把“学到了”报成完成升级。",
      "没有结算旧预测，不得继续堆新预测。",
      "文件存在、整理完成、脚本写完，都不能冒充默认动作已改变。"
    ],
    antiRollbackTriggers: [
      "一旦发现自己又想扩分析、补漂亮总结、并列多条都对的路，立刻压回唯一链。",
      "一旦想用内部产物冒充真实结果，立刻回到验证命令或外部证据。",
      "一旦法源路径不确定，先校路径，再引用内容。",
      "一旦发现本轮产出不会改变下轮第一动作，立即停止当前分支。"
    ],
    mandatoryLoop: [
      "读：先读最新现行法源与相关判词。",
      "判：写唯一目标、唯一阻塞、唯一默认动作。",
      "压：把新规律压成 rule / knowledge / belief / understanding 之一。",
      "赌：把关键判断转成可验证预测或可验证任务。",
      "验：用现实证据结算预测、跑验证命令、校准结果分。"
    ],
    verifiableTasks: [
      {
        id: "judgment-law-build",
        goal: "成功生成并落盘最新判断升级法源 JSON 与 Markdown 产物。",
        verifyCmd: "test -f data/capability-line/judgment-upgrade-law.json && test -f task_output/judgment-upgrade-line/latest-judgment-upgrade-law.md",
        difficulty: 1,
        successSignal: "两个法源文件同时存在。"
      },
      {
        id: "judgment-law-contains-loop",
        goal: "确认法源正文明确包含‘结旧预测→读法源→压唯一阻塞→声明并验证任务’闭环。",
        verifyCmd: "rg -q '结旧预测.*读现行法源.*唯一阻塞.*可验证任务|读：先读最新现行法源' task_output/judgment-upgrade-line/latest-judgment-upgrade-law.md",
        difficulty: 2,
        successSignal: "Markdown 产物可检出升级闭环关键词。"
      },
      {
        id: "judgment-law-rebuild",
        goal: "升级脚本可独立复跑且不报错。",
        verifyCmd: "npm run tool:judgment:upgrade >/tmp/judgment-law-build.log 2>&1",
        difficulty: 2,
        successSignal: "脚本退出码为 0。"
      }
    ],
    lawsToReadFirst: SOURCE_FILES,
    evidence
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(law, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(law), "utf8");

  console.log(`updated ${relative(ROOT, JSON_PATH)}`);
  console.log(`updated ${relative(ROOT, MD_PATH)}`);
}

function pickFirstSignal(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith("- ") || line.startsWith("1.") || line.startsWith("## "));
  return (lines[0] ?? text.split("\n").find((line) => line.trim()) ?? "无信号").replace(/^[-#0-9.\s]+/, "");
}

function renderMarkdown(law: JudgmentUpgradeLaw): string {
  return `# 判断骨架与默认动作升级法源\n\n更新时间：${law.generatedAt}\n\n## 任务使命\n- ${law.mission}\n- 唯一差距：${law.singleGap}\n- 总军法：${law.doctrine}\n\n## 默认动作系统\n${law.defaultActionSystem.map((item) => `- ${item}`).join("\n")}\n\n## 强制升级闭环\n${law.mandatoryLoop.map((item) => `- ${item}`).join("\n")}\n\n## 硬规则\n${law.hardRules.map((item) => `- ${item}`).join("\n")}\n\n## 防回滑触发器\n${law.antiRollbackTriggers.map((item) => `- ${item}`).join("\n")}\n\n## 可验证任务\n${law.verifiableTasks
    .map(
      (task) => `- ${task.id}｜目标：${task.goal}｜验证：\`${task.verifyCmd}\`｜成功信号：${task.successSignal}`
    )
    .join("\n")}\n\n## 先读法源\n${law.lawsToReadFirst.map((item) => `- ${item.title}｜${item.role}｜\`${item.path}\``).join("\n")}\n\n## 证据摘录\n${law.evidence.map((item) => `- ${item}`).join("\n")}\n`;
}
