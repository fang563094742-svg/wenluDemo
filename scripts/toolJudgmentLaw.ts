#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface ToolVerdict {
  name: string;
  alias: string;
  canDo: string[];
  cannotDo: string[];
  bestFor: string[];
  currentVerdict: string;
}

interface ToolJudgmentLaw {
  generatedAt: string;
  mission: string;
  doctrine: string[];
  sourceRule: string[];
  verdicts: ToolVerdict[];
  dispatchRules: string[];
  antiPatterns: string[];
  finalRuling: string;
}

const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'tool-judgment-line');
const DATA_DIR = resolve(ROOT, 'data', 'capability-line');
const JSON_PATH = resolve(DATA_DIR, 'tool-judgment-law.json');
const MD_PATH = resolve(OUTPUT_DIR, 'latest-tool-judgment-law.md');

const verdicts: ToolVerdict[] = [
  {
    name: 'Codex',
    alias: '仓内执行主刀',
    canDo: [
      '直接读写当前仓库文件、改代码、补脚本并立即落盘',
      '调用 shell、构建、测试、检索代码，形成可复跑改动链',
      '把实现、验证、收口压成同一条执行链，而不是只给建议'
    ],
    cannotDo: [
      '不能天然替代真实 GUI 人机操作；浏览器与桌面控制需借助 shell/AppleScript/外部脚本',
      '不能把未验证的外部能力当既成事实，尤其是账号态、云端权限、第三方在线服务',
      '不适合承担长篇开放式陪聊或纯创作型高发散对话作为主战场'
    ],
    bestFor: [
      '代码实现、仓库侦察、脚本化收口、把零散能力固化成唯一法源',
      '需要“说完就做、做完就验”的工程闭环',
      '多文件联动但边界清晰的本地执行任务'
    ],
    currentVerdict: 'Codex 现阶段最适合打“本机代码与脚本执行战”，是把能力落盘、验尸、复跑的主刀，不该被降格成只会口述方案的参谋。'
  },
  {
    name: 'Kiro',
    alias: '产品视图与工程协作副刀',
    canDo: [
      '作为已安装 GUI IDE/工程工具承接项目浏览、编辑、界面对照与人工协作',
      '可被本机打开并纳入桌面工作流，适合做并排查看、人工确认与补充编辑',
      '适合承担“人看界面、人做判断”的交互式工程辅助位'
    ],
    cannotDo: [
      '当前仓内没有证据表明 Kiro 已打通可编程 CLI 闭环，因此不能算自动执行主链',
      '不能在没有额外桥接脚本的前提下，直接替代 Codex 完成批量命令、验证、产物落盘',
      '不应被当作当前任务线的唯一法源生成器'
    ],
    bestFor: [
      '需要 IDE 视角浏览项目、手工对照文件、辅助改稿或人工 review 的仗',
      '与主执行链并行的可视化协作位',
      '当目标更偏交互编辑而非全自动复跑时的副战场'
    ],
    currentVerdict: 'Kiro 现阶段是可接入工作流的 GUI 副刀，强在交互编辑与工程视图，不强在当前这条任务线所需的全自动验尸收口。'
  },
  {
    name: 'Claude 桥接',
    alias: '对话能力外援接口',
    canDo: [
      '通过已安装的 Claude 应用与潜在桥接层，承接需要额外模型视角的问答与文本协商',
      '可作为外援认知面，为复杂表述、重写、比较方案提供补充判断',
      '适合被纳入“旁路验证/第二意见”链路，而不是单点真相源'
    ],
    cannotDo: [
      '当前仓内未见已落地的 Claude 自动桥接脚本与验尸产物，因此不能宣称已形成稳定自动闭环',
      '不能在无桥接协议、无调用留证的情况下，被当作可复跑执行面',
      '不适合负责本机文件改动、命令执行、测试验收这类需要落盘证据的主链任务'
    ],
    bestFor: [
      '需要第二判断源、文案重述、思路对拍、风险反驳的仗',
      '主链被卡住时的旁路认知验证',
      '对外话术、表达打磨、概念拆解等偏语言面的局部战斗'
    ],
    currentVerdict: 'Claude 桥接目前只能判为“有外援位、无自动主链证据”；适合作为第二脑和旁路火力，不适合作为本任务的唯一执行中枢。'
  },
  {
    name: '本机浏览器控制面',
    alias: 'GUI 与页面操作控制面',
    canDo: [
      '已实测可用 AppleScript 驱动 Safari 与 Chrome 的拉起、切前台、建标签、读标题/URL 等动作',
      'Safari 具备 `safaridriver`，意味着可继续向 WebDriver 自动化延伸',
      '适合承担网页打开、页面前台切换、基础导航、需要真实浏览器环境的本机验证'
    ],
    cannotDo: [
      'Chrome 当前仅确认到应用级 AppleScript 控制，未证明稳定外网导航与完整自动化链',
      '未确认 Playwright/Puppeteer/Selenium 现成 CLI，因此不能把现代前端自动化能力虚报为已就位',
      '不适合在没有专门脚本与页面探针时承担复杂网页流程的唯一执行保证'
    ],
    bestFor: [
      '需要真实浏览器打开、本机 GUI 观察、轻量页面操作与演示验证的仗',
      '给 Codex 这类代码执行面补齐“看得到页面、点得到应用”的最后一跳',
      '本地网页验尸、界面截查、人工在环的自动化辅助'
    ],
    currentVerdict: '本机浏览器控制面已经能打“真实浏览器在场”的仗，但主力仍是 AppleScript + Safari WebDriver 潜力，尚未升级成重型网页自动化军团。'
  }
];

const law: ToolJudgmentLaw = {
  generatedAt: new Date().toISOString(),
  mission: '为 Codex、Kiro、Claude 桥接、本机浏览器控制面分别补齐“能做什么/不能做什么/最适合打哪类仗”的现行判词，并收成唯一法源。',
  doctrine: [
    '只写当前机器、当前仓库、当前会话下有证据支撑的现行能力。',
    '每个对象都必须同时写清能做、不能做、最适战场，禁止只吹优点。',
    '主战工具看闭环落盘与验尸能力，副战工具看补位价值，不混淆席位。'
  ],
  sourceRule: [
    '本文件是四类对象现行判词的唯一法源。',
    '对外或对上汇报时，四类对象口径只允许引用本法源。',
    '若后续有新验尸证据，必须先更新本法源，再更新其他派生卡片。'
  ],
  verdicts,
  dispatchRules: [
    '要改代码、跑命令、落产物、做复跑闭环，先派 Codex。',
    '要人工 IDE 视角补看、并排编辑、交互式 review，派 Kiro 补位。',
    '要第二意见、改表述、做认知对拍，调用 Claude 桥接做旁路验证。',
    '要真实浏览器在场、页面前台操作、GUI 末梢验证，派本机浏览器控制面。'
  ],
  antiPatterns: [
    '把未验尸的桥接能力说成已稳定可用。',
    '让 GUI 工具冒充主执行闭环，或让对话外援冒充落盘执行面。',
    '只按工具名气选型，不按当前证据与战场类型分派。'
  ],
  finalRuling: '现行分工应是：Codex 主执行闭环，Kiro 主交互编辑补位，Claude 桥接主第二脑旁路，本机浏览器控制面主真实页面与 GUI 末梢控制；四者各司其职，禁止混岗。'
};

void main();

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(law, null, 2), 'utf8');
  await writeFile(MD_PATH, renderMarkdown(law), 'utf8');
  console.log(`工具判词唯一法源已生成: ${relative(ROOT, MD_PATH)}`);
}

function renderMarkdown(model: ToolJudgmentLaw): string {
  const lines: string[] = [];
  lines.push('# 工具判词唯一法源');
  lines.push('');
  lines.push(`- 生成时间：${model.generatedAt}`);
  lines.push(`- 任务：${model.mission}`);
  lines.push('');
  lines.push('## 立法原则');
  model.doctrine.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
  lines.push('## 唯一口径');
  model.sourceRule.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
  lines.push('## 分对象现行判词');
  model.verdicts.forEach((verdict) => {
    lines.push(`### ${verdict.name}｜${verdict.alias}`);
    lines.push('- 能做什么');
    verdict.canDo.forEach((item) => lines.push(`  - ${item}`));
    lines.push('- 不能做什么');
    verdict.cannotDo.forEach((item) => lines.push(`  - ${item}`));
    lines.push('- 最适合打哪类仗');
    verdict.bestFor.forEach((item) => lines.push(`  - ${item}`));
    lines.push(`- 现行判词：${verdict.currentVerdict}`);
    lines.push('');
  });
  lines.push('## 派兵规则');
  model.dispatchRules.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
  lines.push('## 禁止误用');
  model.antiPatterns.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
  lines.push('## 总判');
  lines.push(`- ${model.finalRuling}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
