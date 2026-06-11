#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DELIVERY_DAYS = { fast: "1 天内", medium: "1~2 天", slow: "2~3 天" } as const;
const PRICE: Record<string, Record<string, number>> = {
  automation: { small: 299, medium: 699, large: 1499 },
  prototype: { small: 999, medium: 1999, large: 3999 },
  content: { small: 399, medium: 799, large: 1499 },
  web: { small: 499, medium: 999, large: 1999 },
};

const PAYMENT_CONFIG_PATH = resolve("data", "payment-config.json");

const DEFAULT_PAYMENT_CONFIG: PaymentConfig = {
  direct: {
    preferredLabel: "微信/支付宝任选其一",
    methods: [
      { label: "微信收款码", instruction: "直接发送 data/payment-assets/wechat-pay.jpg 作为微信真实收款码。", assetPath: "data/payment-assets/wechat-pay.jpg", note: "已注入桌面 IMG_1266.JPG；直接扫码付款即可，付款后把截图发我确认。" },
      { label: "支付宝收款码", instruction: "直接发送 data/payment-assets/alipay-pay.jpg 作为支付宝真实收款码。", assetPath: "data/payment-assets/alipay-pay.jpg", note: "已注入桌面 IMG_1267.JPG；直接扫码付款即可，付款后把截图发我确认。" },
    ],
    remarkTemplate: "付款备注：{projectName} 定金 + 你的称呼/微信名",
  },
  platform: {
    label: "公开入口留痕成交页（默认给陌生客户）",
    instruction: "默认先把陌生客户引导到公开入口留痕页；客户看完后按页内三问信息回需求，确认范围后继续走陌生私聊与微信/支付宝定金承接。",
    link: "http://127.0.0.1:8899/platform-entry.html",
    note: "默认口径：公开发帖/评论区/搜索流量来的陌生客户，先看公开入口留痕页。动作最少链路：我发你入口页 → 你回我输入/输出/时间三件事 → 我确认范围和报价 → 继续私聊确认 → 你付定金并回截图 → 我确认后锁排期并开工。",
  },
  binance: {
    owner: {
      label: "币安账户归属",
      accountType: "个人币安账户",
      holderName: "仅在明确核验需要时单独提供",
      evidence: "本机存在 Binance Desktop 本地运行痕迹：~/Library/Application Support/Binance、com.binance.BinanceDesktop.plist、Binance LaunchAgent，说明已有实际账户/客户端使用基础。",
      policy: "仅作为个人收款/结算账户使用，不归任何现有项目名义，不对外包装成公司主体账户；实名信息仅在明确核验需要时单独提供。",
    },
    inbound: {
      label: "币安线入金口径",
      steps: [
        "仅在客户主动提出 USDT/币安付款，且双方已明确金额、币种、网络后启用。",
        "对外统一报：默认走 USDT，网络优先 TRC20；未确认前不发地址。",
        "发起前先在币安收款页核对本次使用的钱包地址、币种、网络三项完全一致，再复制给客户。",
        "客户转账后，要求其回传转账截图 + txid/hash；我这边以币安到账记录为准确认到账。"
      ],
      warning: "币种、网络、地址三项只要有一项不一致就可能丢失资产，所以必须逐笔现查现发，不在文案里固化具体地址。"
    },
    outbound: {
      label: "币安线提现/落袋口径",
      steps: [
        "币安到账后，先在账户内留存订单对应截图/流水，标记这笔钱对应的客户与项目。",
        "若要落到日常可用资金，优先走币安卖出/提现到我自己常用的银行卡或实名支付账户。",
        "不把客户资金直接提到他人账户，也不混同到现有项目对公/他人代收账户。",
        "对外只承诺‘到账后开始排期/交付’，不承诺汇率，不代客户承担链上或平台手续费波动。"
      ]
    },
    copywriting: {
      trigger: "仅当客户明确问‘能不能币安/USDT’时再切到该口径；默认仍先推微信/支付宝/平台留痕。",
      shortReply: "可以，如果你这边更方便走币安，也可以按 USDT 付款。默认走 USDT-TRC20。你确认金额后，我这边现查并发你这次的收款地址；转完把截图和 txid 发我，我确认到账后马上锁排期。",
      ownerReply: "这条币安线使用个人收款账户承接，不挂任何项目主体；如平台或转账页需要实名核验，再单独补充对应信息。",
      riskReply: "为避免转错，地址、币种、网络我都会按这单单独现发一次；你没收到我当次确认前，先不要自行转。"
    }
  },
  confirmation: {
    defaultStartWindow: "我确认到账后，今天就开始排期；24~48 小时给你首版。",
    askForProof: "付完把付款截图或订单页发我一下，我这边马上确认到账并给你锁排期。",
  },
};

type Category = "automation" | "prototype" | "content" | "web";
type Size = "small" | "medium" | "large";
type Speed = keyof typeof DELIVERY_DAYS;
type Decision = "马上做" | "小步试" | "暂不做" | "明确不做";
type PaymentPath = "platform-first" | "public-flow";
type Platform = "generic" | "wechat" | "xiaohongshu" | "v2ex" | "douyin" | "wechatChannel";

interface PaymentMethodConfig {
  label: string;
  instruction?: string;
  assetPath?: string;
  link?: string;
  note?: string;
}

interface PaymentConfig {
  direct: {
    preferredLabel: string;
    methods: PaymentMethodConfig[];
    remarkTemplate: string;
  };
  platform: PaymentMethodConfig;
  binance: {
    owner: {
      label: string;
      accountType: string;
      holderName: string;
      evidence: string;
      policy: string;
    };
    inbound: {
      label: string;
      steps: string[];
      warning: string;
    };
    outbound: {
      label: string;
      steps: string[];
    };
    copywriting: {
      trigger: string;
      shortReply: string;
      ownerReply: string;
      riskReply: string;
    };
  };
  confirmation: {
    defaultStartWindow: string;
    askForProof: string;
  };
}

interface LeadInput {
  raw: string;
  category: Category;
  size: Size;
  speed: Speed;
  confidence: number;
  inputsKnown: boolean;
  outputsKnown: boolean;
  deadlineKnown: boolean;
  suitable: boolean;
  riskFlags: string[];
  questions: string[];
  title: string;
  deliverable: string;
  evidence: string[];
  decision: Decision;
  paymentPath: PaymentPath;
  firstAction: string;
  triageSummary: string;
  platform: Platform;
  platformReplies: Record<Platform, string>;
  quoteReply: string;
  followUpReply: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function detectCategory(text: string): Category {
  if (includesAny(text, ["原型", "demo", "MVP", "页面", "网页原型", "AI demo", "演示"])) return "prototype";
  if (includesAny(text, ["批量", "视频", "音频", "文本", "素材", "文案生成", "自媒体"])) return "content";
  if (includesAny(text, ["落地页", "网页", "网站", "工具页", "H5"])) return "web";
  return "automation";
}

function detectSize(text: string): Size {
  const bigSignals = ["系统", "后台", "长期", "很多页面", "全套", "复杂", "平台", "多人", "权限"];
  const midSignals = ["2个功能", "两个功能", "一套流程", "批量处理", "导入导出", "简单界面", "接口"];
  if (includesAny(text, bigSignals)) return "large";
  if (includesAny(text, midSignals)) return "medium";
  return "small";
}

function detectSpeed(text: string): Speed {
  if (includesAny(text, ["今天", "今晚", "立刻", "马上", "尽快", "加急", "明天前", "明晚前", "24小时", "24 小时"])) return "fast";
  if (includesAny(text, ["这周", "两天", "1天", "2天", "本周"])) return "medium";
  return "slow";
}

function detectInputsKnown(text: string): boolean {
  return includesAny(text, ["现在是", "现有", "输入", "素材", "文件", "表格", "链接", "数据", "我有", "已有", "我这边已有"]);
}

function detectOutputsKnown(text: string): boolean {
  return includesAny(text, ["输出", "最终要", "生成", "导出", "结果", "得到", "做成", "自动发"]);
}

function detectDeadlineKnown(text: string): boolean {
  return includesAny(text, ["今天", "今晚", "明天", "后天", "这周", "月底", "截止", "最晚"]);
}

function buildRiskFlags(text: string, size: Size): string[] {
  const flags: string[] = [];
  if (includesAny(text, ["先聊聊", "先出方案", "先看看怎么做", "免费", "预算不多"])) flags.push("白嫖/低预算风险");
  if (includesAny(text, ["长期", "系统", "后台", "很多功能", "驻场"])) flags.push("超出小而快边界");
  if (includesAny(text, ["都可以", "还没想好", "你帮我定", "边做边看"])) flags.push("需求边界模糊");
  if (includesAny(text, ["很急", "立刻", "马上"]) && size !== "small") flags.push("工期压缩风险");
  return flags;
}

function buildQuestions(info: { inputsKnown: boolean; outputsKnown: boolean; deadlineKnown: boolean; category: Category; size: Size }): string[] {
  const questions: string[] = [];
  if (!info.inputsKnown) questions.push("你现在手里已有的输入/素材/文件是什么？");
  if (!info.outputsKnown) questions.push("你最终想让我交付的输出结果是什么？");
  if (!info.deadlineKnown) questions.push("最晚什么时候要？");
  if (info.size !== "small") questions.push("这次必须做的核心功能有哪些？哪些可以后放？");
  if (info.category === "prototype") questions.push("这个版本是你自己用，还是拿去演示/给客户看？");
  return questions;
}

function buildDeliverable(category: Category, size: Size): string {
  const map: Record<Category, Record<Size, string>> = {
    automation: {
      small: "1 个自动化脚本/小工具 + 使用说明",
      medium: "1 套可跑通的自动化流程 + 简单界面或配置 + 使用说明",
      large: "拆成首版 MVP：先交付关键自动化主流程 + 1 次修改",
    },
    prototype: {
      small: "1 个可运行 demo + 基础交互 + 本地运行说明",
      medium: "1 个可演示原型 + 核心页面/流程 + 本地运行说明",
      large: "先压成可演示首版：只做关键页面和主流程",
    },
    content: {
      small: "1 个批处理脚本/工具 + 使用说明",
      medium: "1 套内容批处理流程 + 简单配置 + 使用说明",
      large: "先交付最核心的一段批处理闭环 + 1 次修改",
    },
    web: {
      small: "1 个网页工具页/落地页首版 + 部署/运行说明",
      medium: "1 个带基础交互的工具页/展示页 + 说明",
      large: "先压成首版：关键页面 + 核心交互",
    },
  };
  return map[category][size];
}

function buildTitle(category: Category): string {
  switch (category) {
    case "prototype": return "AI 原型 / 演示 demo";
    case "content": return "内容生产辅助工具";
    case "web": return "网页工具页 / 落地页";
    default: return "自动化脚本 / 本地小工具";
  }
}

function decide({ size, riskFlags, inputsKnown, outputsKnown, deadlineKnown }: { size: Size; riskFlags: string[]; inputsKnown: boolean; outputsKnown: boolean; deadlineKnown: boolean }): Decision {
  if (riskFlags.includes("超出小而快边界")) return "明确不做";
  if (size === "large") return "暂不做";
  if (inputsKnown && outputsKnown && deadlineKnown && riskFlags.length === 0) return "马上做";
  return "小步试";
}

function paymentPathFor(input: { size: Size; riskFlags: string[] }): PaymentPath {
  if (input.size === "small" && input.riskFlags.length === 0) return "platform-first";
  return "public-flow";
}

function detectPlatform(text: string): Platform {
  if (includesAny(text, ["微信视频号", "视频号"])) return "wechatChannel";
  if (includesAny(text, ["小红书", "红薯"])) return "xiaohongshu";
  if (includesAny(text, ["V2EX", "v2ex"])) return "v2ex";
  if (includesAny(text, ["抖音", "douyin"])) return "douyin";
  if (includesAny(text, ["微信", "wx", "企微"])) return "wechat";
  return "generic";
}

function firstActionFor(input: { inputsKnown: boolean; outputsKnown: boolean; deadlineKnown: boolean; decision: Decision }): string {
  if (!input.inputsKnown || !input.outputsKnown || !input.deadlineKnown) return "先发三问模板补齐输入/输出/最晚时间";
  if (input.decision === "明确不做") return "直接收口拒绝，避免继续拉长沟通";
  if (input.decision === "暂不做") return "先压缩为最小首版范围，再决定是否报价";
  return "直接发送首条报价回复";
}

function buildEvidence(input: LeadInput): string[] {
  return [
    `分类=${input.category}`,
    `复杂度=${input.size}`,
    `时效=${input.speed}`,
    `输入已知=${input.inputsKnown}`,
    `输出已知=${input.outputsKnown}`,
    `截止已知=${input.deadlineKnown}`,
    `决策=${input.decision}`,
    `收款路径=${input.paymentPath}`,
    `风险=${input.riskFlags.length ? input.riskFlags.join("、") : "低"}`,
  ];
}

function analyze(raw: string): LeadInput {
  const text = normalize(raw);
  const category = detectCategory(text);
  const size = detectSize(text);
  const speed = detectSpeed(text);
  const inputsKnown = detectInputsKnown(text);
  const outputsKnown = detectOutputsKnown(text);
  const deadlineKnown = detectDeadlineKnown(text);
  const riskFlags = buildRiskFlags(text, size);
  const suitable = size !== "large" && !riskFlags.includes("超出小而快边界");
  const confidenceBase = [inputsKnown, outputsKnown, deadlineKnown].filter(Boolean).length / 3;
  const confidence = Math.max(0.35, Math.min(0.95, confidenceBase + (riskFlags.length ? -0.1 : 0.15)));
  const questions = buildQuestions({ inputsKnown, outputsKnown, deadlineKnown, category, size });
  const title = buildTitle(category);
  const deliverable = buildDeliverable(category, size);
  const decision = decide({ size, riskFlags, inputsKnown, outputsKnown, deadlineKnown });
  const paymentPath = paymentPathFor({ size, riskFlags });
  const platform = detectPlatform(text);
  const firstAction = firstActionFor({ inputsKnown, outputsKnown, deadlineKnown, decision });
  const triageSummary = `${title}｜${size}｜${decision}｜${firstAction}`;
  const draft: LeadInput = {
    raw: text,
    category,
    size,
    speed,
    confidence,
    inputsKnown,
    outputsKnown,
    deadlineKnown,
    suitable,
    riskFlags,
    questions,
    title,
    deliverable,
    evidence: [],
    decision,
    paymentPath,
    firstAction,
    triageSummary,
    platform,
    platformReplies: {} as Record<Platform, string>,
    quoteReply: "",
    followUpReply: "",
  };
  draft.evidence = buildEvidence(draft);
  draft.quoteReply = buildQuoteReply(draft);
  draft.followUpReply = buildFollowUpReply(draft);
  draft.platformReplies = buildPlatformReplies(draft);
  return draft;
}


function compactLines(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

function buildQuoteReply(input: LeadInput): string {
  return compactLines([
    `这类我能直接做，先按 ${input.deliverable} 给你收口。`,
    `报价 ${quoteFor(input)} 元，周期 ${deliveryFor(input.speed, input.size)}。`,
    "默认包含首版开发 + 1 次修改。",
    `如果你现在确认，我这边先收 ${depositRateFor(input)} 定金锁排期，今天就能排进去。`,
  ]);
}

function buildFollowUpReply(input: LeadInput): string {
  const ask = [];
  if (!input.inputsKnown) ask.push("把你现有素材/文件先发我");
  if (!input.outputsKnown) ask.push("把你最终想导出的结果说清楚");
  if (!input.deadlineKnown) ask.push("补一个最晚时间");
  return ask.length ? `我这边就差最后确认：${ask.join('；')}。你补完我直接给你定价并开收口。` : `如果你确认，我现在就按这个报价给你发定金口径。`;
}

function platformPrefix(platform: Platform): string {
  switch (platform) {
    case "xiaohongshu": return "小红书首回：";
    case "v2ex": return "V2EX 首回：";
    case "douyin": return "抖音首回：";
    case "wechat": return "微信首回：";
    case "wechatChannel": return "视频号首回：";
    default: return "首回：";
  }
}

function adaptReplyForPlatform(input: LeadInput, platform: Platform): string {
  if (!input.inputsKnown || !input.outputsKnown || !input.deadlineKnown) {
    const base = [platformPrefix(platform) + '我能接，先卡 3 个信息我就直接报：', ...input.questions.map((q, i) => `${i + 1}. ${q}`)];
    if (platform === 'xiaohongshu' || platform === 'douyin') base.push('你直接私我这 3 项，我按小单最快给你收口。');
    else base.push('你回我这几项，我就直接给你报价和周期。');
    return compactLines(base);
  }
  const lines = [platformPrefix(platform) + `这类我能直接做。`, `可交付：${input.deliverable}。`, `报价：${quoteFor(input)} 元；周期：${deliveryFor(input.speed, input.size)}。`];
  if (platform === 'xiaohongshu' || platform === 'douyin' || platform === 'wechatChannel') lines.push(`你确认我就先收 ${depositRateFor(input)} 定金锁排期，今天可开。`);
  else lines.push('你确认后我就发定金口径，到账即开工。');
  return compactLines(lines);
}

function buildPlatformReplies(input: LeadInput): Record<Platform, string> {
  return {
    generic: adaptReplyForPlatform(input, 'generic'),
    wechat: adaptReplyForPlatform(input, 'wechat'),
    xiaohongshu: adaptReplyForPlatform(input, 'xiaohongshu'),
    v2ex: adaptReplyForPlatform(input, 'v2ex'),
    douyin: adaptReplyForPlatform(input, 'douyin'),
    wechatChannel: adaptReplyForPlatform(input, 'wechatChannel'),
  };
}

function quoteFor(input: LeadInput): number {
  return PRICE[input.category][input.size];
}

function deliveryFor(speed: Speed, size: Size): string {
  if (speed === "fast" && size === "small") return "24 小时内给首版";
  return DELIVERY_DAYS[speed];
}

function depositRateFor(input: LeadInput): string {
  return input.size === "small" ? "50%" : "40%";
}

function paymentSummaryFor(input: LeadInput): string {
  if (input.paymentPath === "public-flow") {
    return `建议先收 ${depositRateFor(input)} 定金，首版确认后补尾款。`;
  }
  return "当天小单优先直接定金锁排期；若来源陌生，再补平台留痕。";
}

function paymentConfig(): PaymentConfig {
  if (!existsSync(PAYMENT_CONFIG_PATH)) return DEFAULT_PAYMENT_CONFIG;
  try {
    const raw = readFileSync(PAYMENT_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PaymentConfig>;
    return {
      direct: {
        preferredLabel: parsed.direct?.preferredLabel || DEFAULT_PAYMENT_CONFIG.direct.preferredLabel,
        methods: parsed.direct?.methods?.length ? parsed.direct.methods : DEFAULT_PAYMENT_CONFIG.direct.methods,
        remarkTemplate: parsed.direct?.remarkTemplate || DEFAULT_PAYMENT_CONFIG.direct.remarkTemplate,
      },
      platform: {
        ...DEFAULT_PAYMENT_CONFIG.platform,
        ...(parsed.platform || {}),
      },
      binance: {
        owner: {
          ...DEFAULT_PAYMENT_CONFIG.binance.owner,
          ...(parsed.binance?.owner || {}),
        },
        inbound: {
          ...DEFAULT_PAYMENT_CONFIG.binance.inbound,
          ...(parsed.binance?.inbound || {}),
          steps: parsed.binance?.inbound?.steps?.length ? parsed.binance.inbound.steps : DEFAULT_PAYMENT_CONFIG.binance.inbound.steps,
        },
        outbound: {
          ...DEFAULT_PAYMENT_CONFIG.binance.outbound,
          ...(parsed.binance?.outbound || {}),
          steps: parsed.binance?.outbound?.steps?.length ? parsed.binance.outbound.steps : DEFAULT_PAYMENT_CONFIG.binance.outbound.steps,
        },
        copywriting: {
          ...DEFAULT_PAYMENT_CONFIG.binance.copywriting,
          ...(parsed.binance?.copywriting || {}),
        },
      },
      confirmation: {
        defaultStartWindow: parsed.confirmation?.defaultStartWindow || DEFAULT_PAYMENT_CONFIG.confirmation.defaultStartWindow,
        askForProof: parsed.confirmation?.askForProof || DEFAULT_PAYMENT_CONFIG.confirmation.askForProof,
      },
    };
  } catch {
    return DEFAULT_PAYMENT_CONFIG;
  }
}

function methodReady(method: PaymentMethodConfig): boolean {
  if (method.link && method.link.trim()) return true;
  if (method.assetPath && existsSync(resolve(method.assetPath))) return true;
  return false;
}

function renderRemarkTemplate(input: LeadInput, config: PaymentConfig): string {
  return config.direct.remarkTemplate
    .replaceAll("{projectName}", input.title)
    .replaceAll("{quote}", String(quoteFor(input)))
    .replaceAll("{deposit}", String(Math.round(quoteFor(input) * (parseInt(depositRateFor(input), 10) / 100))));
}

function buildPaymentInstructions(input: LeadInput, config: PaymentConfig): string[] {
  if (input.paymentPath === "public-flow") {
    const methods = config.direct.methods.map((method) => {
      const readyBits: string[] = [];
      if (method.link) readyBits.push(`链接：${method.link}`);
      if (method.assetPath) readyBits.push(`收款码文件：${method.assetPath}${existsSync(resolve(method.assetPath)) ? "（已存在）" : "（待放入）"}`);
      if (method.note) readyBits.push(`说明：${method.note}`);
      if (method.instruction && !methodReady(method)) readyBits.push(`待补：${method.instruction}`);
      return `- ${method.label}：${readyBits.join("；") || "待补具体付款信息"}`;
    });
    return [
      `建议付款方式：${config.direct.preferredLabel}`,
      ...methods,
      `付款备注建议：${renderRemarkTemplate(input, config)}`,
      "如对方指定币安/USDT，也可补充：",
      `- ${config.binance.owner.label}：${config.binance.owner.accountType}｜归属：${config.binance.owner.holderName}｜口径：${config.binance.owner.policy}`,
      `- ${config.binance.inbound.label}：${config.binance.inbound.steps.join(" / ")}`,
      `- 风险提醒：${config.binance.inbound.warning}`,
      `- ${config.binance.outbound.label}：${config.binance.outbound.steps.join(" / ")}`,
      `- 对外短回复：${config.binance.copywriting.shortReply}`,
    ];
  }

  const platformBits: string[] = [];
  if (config.platform.link) platformBits.push(`平台链接：${config.platform.link}`);
  if (config.platform.assetPath) platformBits.push(`平台入口截图：${config.platform.assetPath}${existsSync(resolve(config.platform.assetPath)) ? "（已存在）" : "（待放入）"}`);
  if (config.platform.note) platformBits.push(`说明：${config.platform.note}`);
  if (!config.platform.link && config.platform.instruction) platformBits.push(`待补：${config.platform.instruction}`);
  return [`建议付款方式：${config.platform.label}`, `- ${config.platform.label}：${platformBits.join("；") || "待补具体平台入口"}`];
}

function buildReply(input: LeadInput): string {
  if (!input.inputsKnown || !input.outputsKnown || !input.deadlineKnown) {
    return [
      "收到，我先卡 3 个成交信息：",
      ...input.questions.map((q, i) => `${i + 1}. ${q}`),
      "你把这几项补我，我就能直接给周期和报价。",
    ].join("\n");
  }
  return [
    `我理解你的需求是：${input.title}。`,
    `我可以交付：${input.deliverable}。`,
    `周期：${deliveryFor(input.speed, input.size)}。`,
    `报价：${quoteFor(input)} 元。`,
    "包含：首版开发 + 1 次修改。",
    input.paymentPath === "public-flow" ? "如果确认，我先发你公开入口留痕页；你按三问回我后，我确认范围，再接定金和排期。" : "如果确认，优先走平台留痕或先定金，再开始排期。",
  ].join("\n");
}

function buildPaymentReply(input: LeadInput, config: PaymentConfig): string {
  const lines = buildPaymentInstructions(input, config);
  return [
    input.paymentPath === "public-flow"
      ? `可以，按这个小单我这边先收 ${depositRateFor(input)} 定金开工，首版确认后再补尾款。`
      : "可以，这单我建议优先走平台留痕；如果你想直接推进，也可以先付定金，我确认后开工。",
    ...lines,
    config.confirmation.askForProof,
  ].join("\n");
}

function buildPaymentRequest(input: LeadInput, config: PaymentConfig): string {
  const deposit = Math.round(quoteFor(input) * (parseInt(depositRateFor(input), 10) / 100));
  return [
    `这单先走 ${depositRateFor(input)} 定金，先付 ${deposit} 元，我确认到账后就锁排期。`,
    ...buildPaymentInstructions(input, config),
    config.confirmation.askForProof,
  ].join("\n");
}

function buildReceiptConfirmation(input: LeadInput, config: PaymentConfig): string {
  return [
    "收到，我这边已经确认到账。",
    `这单我会按刚才确认的范围推进：${input.deliverable}。`,
    config.confirmation.defaultStartWindow,
    "如果你这边还有补充素材/样例，现在一并发我，我直接并进首版。",
  ].join("\n");
}

function buildKickoffConfirmation(input: LeadInput, config: PaymentConfig): string {
  return [
    "好，我这边正式开工。",
    `当前锁定范围：${input.deliverable}。`,
    `交付节奏：${deliveryFor(input.speed, input.size)}。`,
    "默认包含 1 次修改；如果中途新增范围，我会先跟你确认再补差价。",
    config.confirmation.defaultStartWindow,
  ].join("\n");
}

function buildClipboardText(input: LeadInput): string {
  return input.platformReplies[input.platform] || buildReply(input);
}

function buildInternalSummary(input: LeadInput): string {
  const lines = [
    `适配度：${input.suitable ? "可接" : "谨慎/先压边界"}`,
    `落决：${input.decision}`,
    `首动作：${input.firstAction}`,
    `判断置信度：${Math.round(input.confidence * 100)}%`,
    `建议类目：${input.title}`,
    `建议交付：${input.deliverable}`,
    `建议报价：${quoteFor(input)} 元`,
    `建议周期：${deliveryFor(input.speed, input.size)}`,
    `平台识别：${input.platform}`,
    `收款路径：${input.paymentPath === "public-flow" ? "公开发帖→留痕页→陌生私聊→定金承接" : "小单优先直接定金锁排期"}`,
    `收款建议：${paymentSummaryFor(input)}`,
    `风险标记：${input.riskFlags.length ? input.riskFlags.join("、") : "无明显高风险"}`,
    "证据：",
    ...input.evidence.map((x) => `- ${x}`),
  ];
  return lines.join("\n");
}

function buildMarkdownPack(input: LeadInput, config: PaymentConfig): string {
  const questions = input.questions.length ? input.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "- 无，信息已够直接报价";
  const paymentInstructions = buildPaymentInstructions(input, config).map((line) => `- ${line}`).join("\n");
  return `# 成交加速包

## 原始询单
${input.raw}

## 分诊摘要
- ${input.triageSummary}

## 内部判断
${buildInternalSummary(input)}

## 通用首条回复

${buildReply(input)}

## 平台适配首回

### 当前识别平台（${input.platform}）

${input.platformReplies[input.platform]}

### 微信

${input.platformReplies.wechat}

### 小红书

${input.platformReplies.xiaohongshu}

### V2EX

${input.platformReplies.v2ex}

### 抖音

${input.platformReplies.douyin}

### 视频号

${input.platformReplies.wechatChannel}

## 一步式报价推进

${input.quoteReply}

## 二次追问推进

${input.followUpReply}

## 客户问怎么付时直接发

${buildPaymentReply(input, config)}

## 直接催付款时可发

${buildPaymentRequest(input, config)}

## 收到付款后确认

${buildReceiptConfirmation(input, config)}

## 正式开工确认

${buildKickoffConfirmation(input, config)}

## 若对方继续模糊，可追问
${questions}

## 收款路径
- ${input.paymentPath === "public-flow" ? "公开线索 / 陌生客户：先发公开入口留痕页，再按确认范围收定金" : "当天小单优先直收定金锁排期；陌生客户可补平台留痕"}
- 尾款节点：首版确认后补尾款，再交付最终文件 / 说明
${paymentInstructions}

## 报价边界
- 低于 199 元不接
- 默认包含 1 次修改
- 超出范围单独补差价
- 先付定金再开工
`;
}

function maybeCopyToClipboard(text: string): boolean {
  const result = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  return !result.error && result.status === 0;
}

async function ensurePaymentConfigSeed(): Promise<void> {
  const paymentConfigDir = resolve("data");
  const assetDir = resolve("data", "payment-assets");
  await mkdir(paymentConfigDir, { recursive: true });
  await mkdir(assetDir, { recursive: true });
  if (!existsSync(PAYMENT_CONFIG_PATH)) {
    await writeFile(PAYMENT_CONFIG_PATH, `${JSON.stringify(DEFAULT_PAYMENT_CONFIG, null, 2)}\n`);
  }
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2).join(" ").trim();
  if (!raw) {
    console.error("用法: npx tsx scripts/dealAccelerator.ts '客户原话/需求描述'");
    process.exit(1);
  }

  await ensurePaymentConfigSeed();
  const config = paymentConfig();
  const input = analyze(raw);
  const outDir = resolve("artifacts", `deal-accelerator-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  const summary = buildInternalSummary(input);
  const reply = buildReply(input);
  const paymentReply = buildPaymentReply(input, config);
  const paymentRequest = buildPaymentRequest(input, config);
  const receiptConfirmation = buildReceiptConfirmation(input, config);
  const kickoffConfirmation = buildKickoffConfirmation(input, config);
  const pack = buildMarkdownPack(input, config);
  const clipboard = buildClipboardText(input);
  const clipboardCopied = maybeCopyToClipboard(clipboard);

  await writeFile(resolve(outDir, "analysis.json"), JSON.stringify(input, null, 2));
  await writeFile(resolve(outDir, "reply.txt"), reply);
  await writeFile(resolve(outDir, "payment_reply.txt"), paymentReply);
  await writeFile(resolve(outDir, "payment_request.txt"), paymentRequest);
  await writeFile(resolve(outDir, "receipt_confirmation.txt"), receiptConfirmation);
  await writeFile(resolve(outDir, "kickoff_confirmation.txt"), kickoffConfirmation);
  await writeFile(resolve(outDir, "summary.txt"), summary);
  await writeFile(resolve(outDir, "成交加速包.md"), pack);
  await writeFile(resolve(outDir, "clipboard.txt"), clipboard);

  const result = {
    outDir,
    clipboardCopied,
    reply,
    paymentReply,
    paymentRequest,
    receiptConfirmation,
    kickoffConfirmation,
    summary,
    paymentConfigPath: PAYMENT_CONFIG_PATH,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
