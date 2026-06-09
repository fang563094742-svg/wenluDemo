#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SingleSourceOfTruth {
  title: string;
  updatedAt: string;
  goal: string;
  positioning: string[];
  categories: string[];
  touch: {
    publicPost: string;
    shortPost: string;
    attachments: string[];
  };
  intake: {
    standard: string;
    followup: string;
    asks: string[];
    principles: string[];
  };
  quote: {
    template: string[];
    anchors: string[];
    boundaries: string[];
    antiFreeConsult: string;
  };
  payment: {
    deposit: string;
    confirm: string;
    kickoff: string;
    assets: string[];
    binanceFallback: string;
  };
  proof: {
    minimumEvidence: string[];
    principles: string[];
  };
  execution: string[];
  avoid: string[];
}

const ROOT = resolve(".");
const SOURCE = resolve(ROOT, "单页法源-陌生客成交物料链唯一现行法源.md");
const OUTPUT_DIR = resolve(ROOT, "artifacts", `single-source-${Date.now()}`);

function now(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function toJsonModel(): SingleSourceOfTruth {
  return {
    title: "单页法源｜陌生客成交物料链唯一现行法源",
    updatedAt: now(),
    goal: "把首触达、回复承接、报价、留证、定金压成更少文件、更少动作的一页法源。",
    positioning: [
      "只卖当下能止痛的最小结果",
      "小而快、边界清楚、24~72 小时首版",
      "默认先做最核心的一步"
    ],
    categories: [
      "表格 / 文本 / 文件批量处理",
      "音视频机械处理",
      "固定流程按钮化 / 本地小工具化"
    ],
    touch: {
      publicPost: "如果你手里有一段重复、机械、容易出错的电脑工作，想先压成一个小而快的脚本 / 本地工具 / 自动化流程，直接把现在输入是什么、想输出什么、最晚什么时候要发我，我直接回你能不能做、多久、多少钱。",
      shortPost: "我现在单独接表格/文本/文件处理、音视频机械处理、固定流程小工具这类小而快自动化单。直接发我：输入是什么、想输出什么、最晚什么时候要。我直接回你能不能做、多久、多少钱。",
      attachments: ["界面图", "处理中画面", "输出结果图"]
    },
    intake: {
      standard: "你直接把 3 个信息发我就行：1）现在输入是什么 2）想输出成什么 3）最晚什么时候要。我按最小范围直接回你：能不能做、多久、多少钱。",
      followup: "收到，我先补齐 3 件事：1）你现在的输入 / 素材 / 原始文件是什么？2）你最终想输出成什么结果？3）最晚什么时候要？",
      asks: ["现在输入是什么", "想输出成什么", "最晚什么时候要"],
      principles: ["不先讲技术方案", "不先做长解释", "先把输入 / 输出 / 时间卡清"]
    },
    quote: {
      template: [
        "输入：XXX",
        "输出：XXX",
        "这次先只做最核心的一步",
        "周期：24~72 小时首版",
        "报价：XXX 元",
        "包含：首版 + 1 次小调整"
      ],
      anchors: ["199~399：轻量快修", "399~699：标准小单", "699~999：稍复杂首版", "999+：原型 / 更复杂流程"],
      boundaries: ["低于 199 不接", "默认只含 1 次小调整", "新增范围单独补差价", "默认先定金再开工"],
      antiFreeConsult: "这个需求可以做。如果要继续进入更细的方案拆解和实现细节，我建议按正式项目推进。你确认预算和时间后，我这边直接给交付方案。"
    },
    payment: {
      deposit: "可以，先付 50% 定金开工。你选微信 / 支付宝其一，我把收款方式发你；付完把截图发我，我确认到账后马上锁排期。",
      confirm: "收到，我这边已经确认到账。今天开始排期，24~72 小时给你首版。",
      kickoff: "好，我这边正式开工。当前锁定范围：XXX。默认包含 1 次小调整；如果中途新增范围，我会先跟你确认再补差价。",
      assets: [
        "data/payment-assets/wechat-pay.jpg",
        "data/payment-assets/alipay-pay.jpg",
        "http://127.0.0.1:8899/platform-entry.html"
      ],
      binanceFallback: "可以，如果你这边更方便走币安，也可以按 USDT 付款。默认走 USDT-TRC20。你确认金额后，我这边现查并发你这次的收款地址；转完把截图和 txid 发我，我确认到账后马上锁排期。"
    },
    proof: {
      minimumEvidence: [
        "对方原始需求截图 / 文本",
        "三问补齐后的输入输出时间",
        "报价与确认记录",
        "定金到账截图 / 开工确认"
      ],
      principles: ["留证只做最小闭环", "先成交，再归档", "不把留证扩成新的多文件工程"]
    },
    execution: [
      "发公开短帖或私聊开口",
      "有人回复，只收三问",
      "信息一清楚，立刻发最小闭环报价",
      "对方确认，立刻发 50% 定金模板",
      "到账，立刻发开工确认",
      "顺手留 4 个最小证据"
    ],
    avoid: [
      "不发 localhost / 127.0.0.1 本地演示链接到公开场景",
      "不一上来发付款码",
      "不先聊抽象能力和大规划",
      "不做多轮免费咨询",
      "不一上来接大而全需求",
      "不让留证与归档反压主成交链"
    ]
  };
}

function buildOperationalCard(model: SingleSourceOfTruth): string {
  return `# 单页法源衍生执行卡｜复制即用\n\n更新时间：${model.updatedAt}\n\n## 公开首触达\n${model.touch.publicPost}\n\n## 更短版\n${model.touch.shortPost}\n\n## 三问\n1. ${model.intake.asks[0]}\n2. ${model.intake.asks[1]}\n3. ${model.intake.asks[2]}\n\n## 报价\n- ${model.quote.template.join("\n- ")}\n\n## 定金\n${model.payment.deposit}\n\n## 到账\n${model.payment.confirm}\n\n## 开工\n${model.payment.kickoff}\n\n## 最小留证\n- ${model.proof.minimumEvidence.join("\n- ")}\n`;
}

async function main() {
  const markdown = await readFile(SOURCE, "utf8");
  const model = toJsonModel();
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(resolve(OUTPUT_DIR, "single-source.json"), JSON.stringify(model, null, 2), "utf8");
  await writeFile(resolve(OUTPUT_DIR, "single-source-operational-card.md"), buildOperationalCard(model), "utf8");
  await writeFile(resolve(OUTPUT_DIR, "source-snapshot.md"), markdown, "utf8");
  console.log(`已生成 ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
