#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

interface BlockerSignal {
  id: string;
  signal: string;
  means: string;
  defaultAction: string;
}

interface ShiftRule {
  from: string;
  trigger: string;
  to: string;
  action: string;
}

interface AutopsyQuestion {
  id: string;
  question: string;
  evidence: string;
}

interface TempoWindow {
  scene: string;
  cadence: string;
  checkEveryMinutes: number;
  mustProduce: string[];
  stopCondition: string;
}

interface ResponseStrategyLine {
  generatedAt: string;
  mission: string;
  doctrine: string;
  defaultLoop: string[];
  blockerSignals: BlockerSignal[];
  shiftRules: ShiftRule[];
  autopsyQuestions: AutopsyQuestion[];
  closureProtocol: string[];
  wartimeTempo: TempoWindow[];
  hardRules: string[];
  outputs: {
    immediateChecklist: string[];
    handoffTemplate: string[];
  };
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve("task_output", "response-strategy-line");
const DATA_DIR = resolve("data", "capability-line");
const JSON_PATH = resolve(DATA_DIR, "response-strategy-line.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-response-strategy-line.md");

void main();

async function main() {
  const line: ResponseStrategyLine = {
    generatedAt: new Date().toISOString(),
    mission: "持续增强应对策略线：默认先识别阻塞，再决定换挡，完成验尸，强制收口，并在战时节奏下持续产出。",
    doctrine: "先判是不是阻塞，再判阻塞层级；先用最小动作解卡，再决定是否换挡；每次失手都要验尸；每轮推进都必须留下收口与下一跳。",
    defaultLoop: [
      "识别阻塞：先把卡点写成信息缺口 / 权限缺口 / 资源缺口 / 决策缺口 / 外部环境缺口。",
      "判断层级：区分是局部卡点、链路级卡点还是全局方向卡点。",
      "最小解卡：优先尝试一跳内能验证的补证据、补权限、补替代路径动作。",
      "决定换挡：若连续两次同类动作无增量，立即切到降配、旁路、模拟、延迟、求援中的一种。",
      "即时验尸：记录这次卡住的触发信号、误判点、最早该发现的证据。",
      "强制收口：输出当前状态、已完成证据、未完成缺口、下一步和止损条件。",
      "战时复拍：按场景节奏重新进入下一轮，而不是无限停留在解释。"
    ],
    blockerSignals: [
      {
        id: "same-path-no-gain",
        signal: "连续两轮重复同一路径，但新证据、新结果、新权限都没有增加。",
        means: "已经进入空转，不是努力不够，而是路径失效。",
        defaultAction: "停止加码原路径，转做换挡决策。"
      },
      {
        id: "unknown-root-cause",
        signal: "只能描述表层报错，不能指出卡在事实、接口、权限、环境还是目标定义。",
        means: "根因未定位，继续执行只会扩大噪音。",
        defaultAction: "先补最小诊断动作，禁止直接扩写方案。"
      },
      {
        id: "external-hard-stop",
        signal: "外部系统、网络、账号、人工反馈成为单点依赖且当前不可控。",
        means: "主链路被外部阻塞。",
        defaultAction: "切出旁路验证或生成待接管收口包。"
      },
      {
        id: "goal-drift",
        signal: "讨论越来越多，但验收结果、时间窗口或交付定义变模糊。",
        means: "问题已从执行阻塞升级为方向阻塞。",
        defaultAction: "回到目标重写与验收重定，未重定前不继续堆动作。"
      },
      {
        id: "tempo-collapse",
        signal: "长时间没有可验证产出，只剩解释、等待或重复查看。",
        means: "战时节奏失守。",
        defaultAction: "缩短检查周期，并强制产出一份中间证据或收口说明。"
      }
    ],
    shiftRules: [
      {
        from: "主链路硬顶",
        trigger: "同类尝试两次无增量",
        to: "降配试跑",
        action: "缩小输入、缩小范围、缩小目标，只验证最小闭环是否能通。"
      },
      {
        from: "需要真实外部依赖",
        trigger: "外部依赖当前不可控",
        to: "旁路模拟",
        action: "先用 mock、缓存证据、已有样本或静态检查替代，确认内部链路是否正确。"
      },
      {
        from: "信息不够无法判断",
        trigger: "根因类别说不清",
        to: "诊断模式",
        action: "优先做能分层定位的探针、日志、最小复现，而不是继续改代码。"
      },
      {
        from: "方向争议或目标漂移",
        trigger: "验收口径失焦",
        to: "重定标",
        action: "把真结果、衡量标准、时间窗口重写成三行，再决定是否继续。"
      },
      {
        from: "长线任务疲劳堆积",
        trigger: "节奏塌陷且产出稀薄",
        to: "战时节拍",
        action: "缩成固定时间盒，每个时间盒必须交一个证据、一个判断、一个下一步。"
      }
    ],
    autopsyQuestions: [
      {
        id: "first-signal",
        question: "最早出现的异常信号是什么，当时为什么没被提升为阻塞？",
        evidence: "日志、命令输出、时间线。"
      },
      {
        id: "misclassification",
        question: "这次把哪类阻塞误判成了别的东西？",
        evidence: "阻塞分类与真实根因对照。"
      },
      {
        id: "wasted-loop",
        question: "哪一轮开始进入空转，本可用什么阈值更早止损？",
        evidence: "重复动作记录与增量缺失。"
      },
      {
        id: "shift-timing",
        question: "换挡是否太晚，旁路、降配、求援本该何时启动？",
        evidence: "尝试顺序与结果对照。"
      },
      {
        id: "closure-quality",
        question: "收口时是否说清已完成、未完成、卡点、下一跳和接手条件？",
        evidence: "最终交付文本。"
      }
    ],
    closureProtocol: [
      "任何一轮结束前都要输出：当前目标、当前状态、已验证证据、剩余阻塞。",
      "若未完成，必须写明下一步动作、触发条件、止损条件和接手所需材料。",
      "若确认失败或外部阻塞，直接生成可接管收口，而不是停在‘还在看’。",
      "若已完成，补一条可复跑命令或模板，让下次不再从零开始。"
    ],
    wartimeTempo: [
      {
        scene: "陌生仓库侦察",
        cadence: "先快后稳",
        checkEveryMinutes: 10,
        mustProduce: ["结构地图", "关键入口", "首个可行动作"],
        stopCondition: "找到最短落地点或确认入口不存在。"
      },
      {
        scene: "实现与修复",
        cadence: "25 分钟一拍",
        checkEveryMinutes: 25,
        mustProduce: ["可见改动", "局部验证", "风险备注"],
        stopCondition: "改动落地并完成最近邻验证。"
      },
      {
        scene: "根因排查",
        cadence: "15 分钟一拍",
        checkEveryMinutes: 15,
        mustProduce: ["新诊断证据", "排除项", "下一探针"],
        stopCondition: "根因类别收敛到单一层级。"
      },
      {
        scene: "外部依赖卡死",
        cadence: "8 分钟一拍",
        checkEveryMinutes: 8,
        mustProduce: ["旁路尝试", "待接管包", "恢复触发条件"],
        stopCondition: "旁路打通或收口包完整可接手。"
      }
    ],
    hardRules: [
      "连续两轮无增量，必须换挡，不能继续硬顶。",
      "说不清阻塞类别时，先诊断，后行动。",
      "没有证据增量的长解释，一律视为空转。",
      "没有收口文本的暂停，不算合格结束。",
      "外部依赖不可控时，优先产出旁路或接管包。",
      "每次验尸至少沉淀一个下次可提前识别的信号。"
    ],
    outputs: {
      immediateChecklist: [
        "现在卡在哪一类阻塞？",
        "上一轮动作带来了什么新证据？",
        "如果没有增量，应该切哪种挡？",
        "此刻能留下什么收口证据？",
        "下一个时间盒结束前必须交付什么？"
      ],
      handoffTemplate: [
        "目标：",
        "当前状态：",
        "已验证证据：",
        "当前阻塞：",
        "已尝试动作 / 结果：",
        "建议换挡：",
        "下一步：",
        "止损条件 / 恢复条件："
      ]
    }
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(line, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(line), "utf8");

  console.log(`应对策略线已生成: ${relative(ROOT, MD_PATH)}`);
}

function renderMarkdown(line: ResponseStrategyLine): string {
  return [
    "# 应对策略线默认作战机制",
    "",
    `- 生成时间：${line.generatedAt}`,
    `- 任务：${line.mission}`,
    `- 总纲：${line.doctrine}`,
    "",
    "## 默认循环",
    ...line.defaultLoop.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 阻塞识别信号",
    ...line.blockerSignals.map((item) => `- ${item.id}｜信号：${item.signal}｜含义：${item.means}｜默认动作：${item.defaultAction}`),
    "",
    "## 换挡规则",
    ...line.shiftRules.map((item) => `- ${item.from} → ${item.to}｜触发：${item.trigger}｜动作：${item.action}`),
    "",
    "## 验尸问题",
    ...line.autopsyQuestions.map((item) => `- ${item.id}｜问题：${item.question}｜证据：${item.evidence}`),
    "",
    "## 收口协议",
    ...line.closureProtocol.map((item) => `- ${item}`),
    "",
    "## 战时节奏",
    ...line.wartimeTempo.map((item) => `- ${item.scene}｜节拍：${item.cadence}｜每 ${item.checkEveryMinutes} 分钟检查｜必须产出：${item.mustProduce.join(" / ")}｜停止条件：${item.stopCondition}`),
    "",
    "## 硬规则",
    ...line.hardRules.map((item) => `- ${item}`),
    "",
    "## 即时检查清单",
    ...line.outputs.immediateChecklist.map((item) => `- ${item}`),
    "",
    "## 接管收口模板",
    ...line.outputs.handoffTemplate.map((item) => `- ${item}`),
    ""
  ].join("\n");
}
