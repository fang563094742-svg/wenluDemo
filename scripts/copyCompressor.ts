#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface CompressionArtifacts {
  sourceTitle: string;
  sourceText: string;
  sourceLines: string[];
  promise: string;
  audience: string;
  categories: string[];
  asks: string[];
  proof: string[];
  process: string[];
  pricing: string[];
  payment: string[];
  riskControl: string[];
}

interface ExpressionVariant {
  audience: string;
  tone: string;
  text: string;
}

interface CompressionOutput {
  sourceTitle: string;
  audience: string;
  promise: string;
  platformPost: string;
  privateOpening: string;
  expressionVariants: ExpressionVariant[];
  deliveryCard: {
    categories: string[];
    asks: string[];
    proof: string[];
    process: string[];
    pricing: string[];
    payment: string[];
    riskControl: string[];
  };
}

const PLATFORM_LIMITS: Record<string, number> = {
  platformPost: 120,
  privateOpening: 70,
  bossBrief: 90,
  collaboratorBrief: 100,
  selfNote: 140,
};

function normalize(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\*+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linesOf(text: string): string[] {
  return normalize(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function pickFirst(lines: string[], patterns: RegExp[], fallback = ""): string {
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) return line;
  }
  return fallback;
}

function pickMany(lines: string[], patterns: RegExp[]): string[] {
  return lines.filter((line) => patterns.some((pattern) => pattern.test(line)));
}

function cleanBullet(line: string): string {
  return line.replace(/^[-*#\d.）\(\)\s]+/, "").trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function keepCategory(line: string): boolean {
  return /表格|文本|文件|音视频|按钮|小工具|固定流程/.test(line) && line.length <= 30;
}

function keepAsk(line: string): boolean {
  return /输入|输出|最晚|什么时候要|素材/.test(line) && line.length <= 20;
}

function keepProof(line: string): boolean {
  return /24~72|24~48|首版|50% 定金|1 次小调整|199~999|周期|报价/.test(line) && line.length <= 40;
}

function keepPayment(line: string): boolean {
  return /定金|微信|支付宝|尾款|到账/.test(line) && line.length <= 40;
}

function extractArtifacts(title: string, text: string): CompressionArtifacts {
  const sourceLines = linesOf(text);
  const promise = pickFirst(sourceLines, [/反复手工做的重复工作/, /重复、机械/, /自动化流程/, /小而快/], sourceLines[0] || "");
  const audience = pickFirst(sourceLines, [/如果你现在/, /手里有/, /每天都在/, /适合/]);
  const categories = unique(sourceLines.map(cleanBullet).filter(keepCategory)).slice(0, 6);
  const asks = unique(sourceLines.map(cleanBullet).filter(keepAsk)).slice(0, 6);
  const proof = unique(sourceLines.map(cleanBullet).filter(keepProof)).slice(0, 8);
  const process = unique(
    pickMany(sourceLines, [/先按最小闭环/, /直接发我/, /我直接回你/, /确认/, /排期/, /开工/]).map(cleanBullet),
  ).slice(0, 8);
  const pricing = unique(sourceLines.map(cleanBullet).filter((line) => /199|399|699|999|报价/.test(line) && line.length <= 40)).slice(0, 8);
  const payment = unique(sourceLines.map(cleanBullet).filter(keepPayment)).slice(0, 8);
  const riskControl = unique(
    pickMany(sourceLines, [/不要/, /不建议/, /先把/, /边界/, /最小闭环/]).map(cleanBullet),
  ).slice(0, 8);

  return { sourceTitle: title, sourceText: normalize(text), sourceLines, promise, audience, categories, asks, proof, process, pricing, payment, riskControl };
}

function compressToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const parts = text.split(/[，。；\n]/).map((part) => part.trim()).filter(Boolean);
  let result = "";
  for (const part of parts) {
    const candidate = result ? `${result}，${part}` : part;
    if (candidate.length > limit - 1) break;
    result = candidate;
  }
  return result ? `${result}。` : `${text.slice(0, limit - 1)}…`;
}

function firstOf(items: string[], fallback: string): string {
  return items[0] || fallback;
}

function buildPlatformPost(a: CompressionArtifacts): string {
  const cat = a.categories.length ? a.categories.slice(0, 3).join("、") : "重复工作自动化";
  const ask = "现在输入是什么 / 想输出什么 / 最晚什么时候要";
  const proof = a.proof.find((item) => /24~72|24~48|首版/.test(item)) || "24~72 小时给首版";
  return compressToLimit(`我现在单独接${cat}这类小而快自动化单。直接发我：${ask}。我会直接回你能不能做、多久、多少钱；${proof}。`, PLATFORM_LIMITS.platformPost);
}

function buildPrivateOpening(): string {
  return compressToLimit("把你现在卡住的重复动作发我，我先按最小闭环帮你压成可直接交付的一步。", PLATFORM_LIMITS.privateOpening);
}

function buildBossBrief(a: CompressionArtifacts): string {
  const category = firstOf(a.categories, "重复工作自动化");
  const proof = firstOf(a.proof, "24~72 小时给首版");
  return compressToLimit(`这类${category}我能直接接住：先拿输入/输出/时限，回一版方案与报价，${proof}。`, PLATFORM_LIMITS.bossBrief);
}

function buildCollaboratorBrief(a: CompressionArtifacts): string {
  const ask = firstOf(a.asks, "输入 / 输出 / 最晚时间");
  const process = firstOf(a.process, "先按最小闭环确认再开工");
  return compressToLimit(`你先把${ask}发我，我这边按“${process}”推进，先做出能交付的一版，再一起补细节。`, PLATFORM_LIMITS.collaboratorBrief);
}

function buildSelfNote(a: CompressionArtifacts): string {
  const category = firstOf(a.categories, "重复工作自动化");
  const pricing = firstOf(a.pricing, "先按最小闭环报价");
  const risk = firstOf(a.riskControl, "先收边界，再开工");
  return compressToLimit(`这单本质是${category}压缩。先问清输入、输出、时限，再给${pricing}；执行时守住“${risk}”，避免把边界做散。`, PLATFORM_LIMITS.selfNote);
}

function buildExpressionVariants(a: CompressionArtifacts): ExpressionVariant[] {
  return [
    { audience: "老板", tone: "结果/决策", text: buildBossBrief(a) },
    { audience: "同事", tone: "协作/推进", text: buildCollaboratorBrief(a) },
    { audience: "自己", tone: "推演/约束", text: buildSelfNote(a) },
  ];
}

async function main(): Promise<void> {
  const inputPath = process.argv[2] || resolve("scratch", "sales_copy_source.md");
  const outputDir = process.argv[3] || resolve("task_output", "copy-compressor");
  const raw = await readFile(inputPath, "utf8");
  const title = linesOf(raw)[0] || "未命名原文";
  const artifacts = extractArtifacts(title, raw);
  const output: CompressionOutput = {
    sourceTitle: artifacts.sourceTitle,
    audience: artifacts.audience,
    promise: artifacts.promise,
    platformPost: buildPlatformPost(artifacts),
    privateOpening: buildPrivateOpening(),
    expressionVariants: buildExpressionVariants(artifacts),
    deliveryCard: {
      categories: artifacts.categories,
      asks: artifacts.asks,
      proof: artifacts.proof,
      process: artifacts.process,
      pricing: artifacts.pricing,
      payment: artifacts.payment,
      riskControl: artifacts.riskControl,
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "copy-compressed.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(
    resolve(outputDir, "copy-compressed.md"),
    [
      `# ${output.sourceTitle}`,
      "",
      `## 平台帖`,
      output.platformPost,
      "",
      `## 私聊开场`,
      output.privateOpening,
      "",
      `## 分场表达`,
      ...output.expressionVariants.map((variant) => `- ${variant.audience}（${variant.tone}）：${variant.text}`),
      "",
      `## 交付卡`,
      `- 类别：${output.deliveryCard.categories.join(" / ") || "无"}`,
      `- 需求口：${output.deliveryCard.asks.join(" / ") || "无"}`,
      `- 证明：${output.deliveryCard.proof.join(" / ") || "无"}`,
      `- 流程：${output.deliveryCard.process.join(" / ") || "无"}`,
      `- 报价：${output.deliveryCard.pricing.join(" / ") || "无"}`,
      `- 收款：${output.deliveryCard.payment.join(" / ") || "无"}`,
      `- 风控：${output.deliveryCard.riskControl.join(" / ") || "无"}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
