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

const PLATFORM_LIMITS: Record<string, number> = {
  platformPost: 120,
  privateOpening: 70,
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
    pickMany(sourceLines, [/先按最小闭环/, /直接发我/, /我直接回你/, /确认/, /排期/, /开工/])
      .map(cleanBullet),
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

function buildPlatformPost(a: CompressionArtifacts): string {
  const cat = a.categories.length
    ? a.categories.slice(0, 3).join("、")
    : "重复工作自动化";
  const ask = "现在输入是什么 / 想输出什么 / 最晚什么时候要";
  const proof = a.proof.find((item) => /24~72|24~48|首版/.test(item)) || "24~72 小时给首版";
  return compressToLimit(`我现在单独接${cat}这类小而快自动化单。直接发我：${ask}。我会直接回你能不能做、多久、多少钱；${proof}。`, PLATFORM_LIMITS.platformPost);
}

function buildPrivateOpening(): string {
  return compressToLimit("收到，我先确认 3 件事：1.现在输入是什么 2.想输出什么 3.最晚什么时候要；清楚的话我直接给周期和报价。", PLATFORM_LIMITS.privateOpening);
}

function buildRules(a: CompressionArtifacts): string[] {
  return [
    "先抽一句话卖点：只留‘帮谁把什么重复工作压成什么结果’。",
    "平台短帖只保留四块：对象/痛点、可做范围、三问动作、结果承诺。",
    "私聊首回只做成交分诊，不讲技术细节，优先收‘输入/输出/截止’。",
    "凡是价格、周期、定金、修改次数，优先用现成锚点，不重新发明。",
    "超过字数时，先删举例，再删解释，最后保留三问与承诺。",
    `当前样本高频信任锚点：${unique([...a.proof, ...a.payment]).slice(0, 6).join("；") || "24~72 小时首版；50%定金；1次小调整"}`,
  ];
}

async function main() {
  const filePath = process.argv[2] || "今晚直接外发收定金的一页成交包.md";
  const raw = await readFile(resolve(filePath), "utf8");
  const title = filePath.split("/").pop() || filePath;
  const artifacts = extractArtifacts(title, raw);
  const platformPost = buildPlatformPost(artifacts);
  const privateOpening = buildPrivateOpening();
  const rules = buildRules(artifacts);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve("artifacts", `copy-compressor-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const summary = {
    source: filePath,
    platformPost,
    privateOpening,
    rules,
    extracted: {
      promise: artifacts.promise,
      audience: artifacts.audience,
      categories: artifacts.categories,
      asks: artifacts.asks,
      proof: artifacts.proof,
      pricing: artifacts.pricing,
      payment: artifacts.payment,
      riskControl: artifacts.riskControl,
    },
  };

  const markdown = [
    `# 成交压缩包｜${title}`,
    "",
    `## 平台即发短帖（<=${PLATFORM_LIMITS.platformPost}字）`,
    platformPost,
    "",
    `## 私聊首回（<=${PLATFORM_LIMITS.privateOpening}字）`,
    privateOpening,
    "",
    "## 压缩规则",
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    "## 抽取到的信任锚点",
    ...unique([...artifacts.proof, ...artifacts.pricing, ...artifacts.payment]).map((item) => `- ${item}`),
  ].join("\n");

  await writeFile(resolve(outDir, "analysis.json"), JSON.stringify(summary, null, 2));
  await writeFile(resolve(outDir, "platform-post.txt"), `${platformPost}\n`);
  await writeFile(resolve(outDir, "private-opening.txt"), `${privateOpening}\n`);
  await writeFile(resolve(outDir, "rules.txt"), `${rules.join("\n")}\n`);
  await writeFile(resolve(outDir, "成交压缩包.md"), `${markdown}\n`);

  console.log(JSON.stringify({ outDir, platformPost, privateOpening }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
