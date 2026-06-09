#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SkeletonInput {
  title: string;
  sourcePath: string;
  text: string;
}

interface SkeletonSignals {
  audience: string[];
  deliverables: string[];
  asks: string[];
  proof: string[];
  payments: string[];
  refusal: string[];
  nextActions: string[];
}

interface SkeletonAnalysis {
  source: string;
  title: string;
  oneLineOpportunity: string;
  opportunityType: "direct-close" | "ask-first" | "mvp-first" | "refuse";
  defaultTrack: "public-hook" | "private-close" | "platform-proof";
  signals: SkeletonSignals;
  judgmentSkeleton: {
    detect: string[];
    decide: string[];
    act: string[];
    settle: string[];
  };
}

function normalize(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function linesOf(text: string): string[] {
  return normalize(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function cleanLine(line: string): string {
  return line.replace(/^[-*#\d.）(\s]+/, "").trim();
}

function collect(lines: string[], pattern: RegExp, max: number, exclude?: RegExp): string[] {
  return unique(
    lines
      .map(cleanLine)
      .filter((line) => pattern.test(line) && !(exclude?.test(line) ?? false)),
  ).slice(0, max);
}

function detectType(signals: SkeletonSignals): SkeletonAnalysis["opportunityType"] {
  const hardRefusal = signals.refusal.filter((item) => /明确不做|暂不做/.test(item));
  if (hardRefusal.length > 0) return "refuse";

  const hasInput = signals.asks.some((item) => /输入/.test(item));
  const hasOutput = signals.asks.some((item) => /输出/.test(item));
  const hasDeadline = signals.asks.some((item) => /最晚|截止|时间/.test(item));
  const hasOffer = signals.proof.some((item) => /报价|多少钱|多久|定金|首版|锁排期|到账/.test(item));

  if (hasInput && hasOutput && hasDeadline && hasOffer) return "direct-close";
  if (signals.deliverables.length > 0) return "ask-first";
  if (signals.refusal.some((item) => /MVP|伪快单|系统单/.test(item))) return "mvp-first";
  return "ask-first";
}

function detectTrack(sourcePath: string, type: SkeletonAnalysis["opportunityType"]): SkeletonAnalysis["defaultTrack"] {
  if (/copy-compressor|成交压缩/.test(sourcePath)) return "public-hook";
  if (type === "direct-close") return "private-close";
  return "platform-proof";
}

function buildOneLineOpportunity(signals: SkeletonSignals): string {
  const audience = signals.audience[0] || "有重复机械需求的人";
  const deliverable = signals.deliverables[0] || "把重复工作压成可直接交付的小工具/自动化结果";
  return `${audience}｜${deliverable}`;
}

function analyze(input: SkeletonInput): SkeletonAnalysis {
  const lines = linesOf(input.text);
  const signals: SkeletonSignals = {
    audience: collect(lines, /小红书|抖音|视频号|微信|陌生客户|公开流量|熟人|转介绍|平台|客户/, 6),
    deliverables: collect(lines, /表格|文本|文件|音视频|按钮|小工具|自动化|报价|首回|收款|成交/, 8),
    asks: collect(lines, /输入|输出|最晚|截止|什么时候要|素材|需求描述/, 6, /三种典型输出|浏览器输入框/),
    proof: collect(lines, /24~72|24~48|首版|定金|报价|多久|多少钱|锁排期|到账/, 8),
    payments: collect(lines, /微信|支付宝|币安|USDT|收款|付款|到账|定金|尾款/, 8),
    refusal: collect(lines, /明确不做|暂不做|伪快单|系统单|MVP/, 6, /不让动作链被拖长/),
    nextActions: collect(lines, /直接发我|直接回你|先确认|跑命令|复制|粘贴|继续私聊|锁排期|开工/, 8),
  };

  const opportunityType = detectType(signals);
  const defaultTrack = detectTrack(input.sourcePath, opportunityType);
  const oneLineOpportunity = buildOneLineOpportunity(signals);

  return {
    source: input.sourcePath,
    title: input.title,
    oneLineOpportunity,
    opportunityType,
    defaultTrack,
    signals,
    judgmentSkeleton: {
      detect: [
        "先抓三类线索：对象是谁、重复痛点是什么、交付能否在 1~3 天内闭环。",
        "若原话里已有 输入 / 输出 / 截止 三件事，直接视为可收口线索；缺一则先补问。",
        "若出现 平台语境/陌生来源，默认加一层公开留痕或平台适配首回。",
      ],
      decide: [
        "信息齐全 + 有周期/报价锚点：走 direct-close。",
        "能做但信息不全：走 ask-first，只问最多三件事：输入、输出、截止。",
        "范围虚大或伪快单：先压 MVP；若明确不做收益极低，直接 refuse。",
      ],
      act: [
        "public-hook：先发平台短帖/私聊首回，把线索压进三问。",
        "private-close：直接回能不能做、多久、多少钱，并推进定金锁排期。",
        "platform-proof：陌生流量先给公开入口留痕，再转私聊承接收款。",
      ],
      settle: [
        "产出后必须落成固定文件：短帖/首回/报价推进/收款口径之一。",
        "若客户继续问，只允许沿 报价推进 → 收款 → 到账确认 顺序推进，不回到空聊解释。",
        "结算标准只认两类：是否减少下一次判断成本；是否缩短到收款的动作数。",
      ],
    },
  };
}

function buildMarkdown(analysis: SkeletonAnalysis): string {
  const typeMap: Record<SkeletonAnalysis["opportunityType"], string> = {
    "direct-close": "信息齐全，直接收口",
    "ask-first": "能推进，但先补三问",
    "mvp-first": "先压最小闭环",
    "refuse": "直接拒绝/不投入",
  };

  const trackMap: Record<SkeletonAnalysis["defaultTrack"], string> = {
    "public-hook": "先公开短钩子，再私聊收口",
    "private-close": "直接私聊报价与定金",
    "platform-proof": "先留痕，再转私聊承接",
  };

  return [
    "# 外部扫描赚钱缝隙判断骨架与默认动作法源",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`,
    "用途：把每次外部扫描拿到的赚钱缝隙，统一压成可复用的判断骨架与默认动作，避免每次重新解释。",
    "",
    "## 唯一现行判词",
    "外部扫描的价值，不在于又看到多少线索，而在于能否把线索立即压进同一套收口骨架：先判能不能收、缺什么、走哪条承接轨，再只产出最短可发件。",
    "",
    "## 默认判断顺序",
    "1. 先判是不是小而快闭环：能否在 1~3 天内，用现成输入换出明确输出。",
    "2. 再判信息是否够：只看 输入 / 输出 / 截止 三件事，缺一就补，不多问。",
    "3. 再判承接语境：熟人/微信直收；陌生/公开流量先留痕；公开平台先用短钩子。",
    "4. 最后才选动作：直接报价、三问追问、压 MVP、或明确不做。",
    "",
    "## 默认动作法源",
    "- 若信息齐全：直接回‘能不能做 / 多久 / 多少钱’，随后推进定金锁排期。",
    "- 若信息不全但能做：只问三件事——现在输入是什么、想输出什么、最晚什么时候要。",
    "- 若是陌生公开流量：先发平台短帖或公开入口页，再转私聊收口。",
    "- 若是伪快单/系统单：不空聊方案，直接压 MVP 或明确不做。",
    "- 每次外扫后至少沉淀一个固定产物：`platform-post.txt`、`private-opening.txt`、`reply.txt`、`payment_request.txt` 之一。",
    "",
    "## 判断骨架模板",
    "### Detect｜先识别",
    ...analysis.judgmentSkeleton.detect.map((item) => `- ${item}`),
    "",
    "### Decide｜再分诊",
    ...analysis.judgmentSkeleton.decide.map((item) => `- ${item}`),
    "",
    "### Act｜后动作",
    ...analysis.judgmentSkeleton.act.map((item) => `- ${item}`),
    "",
    "### Settle｜最后结算",
    ...analysis.judgmentSkeleton.settle.map((item) => `- ${item}`),
    "",
    "## 当前已验证样本压缩",
    `- 样本：${analysis.title}`,
    `- 一句话机会：${analysis.oneLineOpportunity}`,
    `- 类型：${typeMap[analysis.opportunityType]}`,
    `- 默认轨道：${trackMap[analysis.defaultTrack]}`,
    `- 高价值信号：${unique([...analysis.signals.deliverables, ...analysis.signals.proof]).slice(0, 6).join("；") || "暂无"}`,
    `- 收款/承接信号：${unique([...analysis.signals.payments, ...analysis.signals.nextActions]).slice(0, 6).join("；") || "暂无"}`,
    "",
    "## 下次外扫后的唯一动作",
    "1. 把线索原话喂给 `npm run deal:triage -- \"客户原话\"`。",
    "2. 若已有长成交页，再补跑 `npm run copy:compress -- \"文件路径\"` 产出公开短钩子。",
    "3. 只从生成物里复制发送，不再手写新解释。",
  ].join("\n");
}

async function main() {
  const sourcePath = process.argv[2] || "scripts/快钱收口分诊脚本说明.md";
  const text = await readFile(resolve(sourcePath), "utf8");
  const analysis = analyze({
    title: sourcePath.split("/").pop() || sourcePath,
    sourcePath,
    text,
  });

  const outDir = resolve("task_output", "gap-judgment-line");
  await mkdir(outDir, { recursive: true });

  const markdown = buildMarkdown(analysis);
  await writeFile(resolve(outDir, "latest-gap-judgment-law.md"), `${markdown}\n`);
  await writeFile(resolve(outDir, "latest-gap-judgment-law.json"), `${JSON.stringify(analysis, null, 2)}\n`);

  console.log(JSON.stringify({
    outDir,
    markdown: resolve(outDir, "latest-gap-judgment-law.md"),
    json: resolve(outDir, "latest-gap-judgment-law.json"),
    opportunityType: analysis.opportunityType,
    defaultTrack: analysis.defaultTrack,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
