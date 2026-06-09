#!/usr/bin/env tsx
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

interface SourcePick {
  label: string;
  path: string;
  mtimeMs: number;
}

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

const ROOT = resolve(".");
const ARTIFACTS_DIR = resolve(ROOT, "artifacts");
const SOURCE_CANDIDATES = [
  "今晚唯一直接发的成交成品.md",
  "今晚最短可直接复制发送版.md",
  "今夜首发执行卡-半小时破零版.md",
  "cash-path-总成交包.md",
  "今晚直接外发收定金的一页成交包.md",
  "今日执行清单.md",
];
const PLATFORM_LIMIT = 120;

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

function cleanBullet(line: string): string {
  return line.replace(/^[-*#\d.）\(\)\s]+/, "").trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function pickFirst(lines: string[], patterns: RegExp[], fallback = ""): string {
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) return cleanBullet(line);
  }
  return fallback;
}

function pickMany(lines: string[], patterns: RegExp[]): string[] {
  return lines.filter((line) => patterns.some((pattern) => pattern.test(line))).map(cleanBullet);
}

function keepCategory(line: string): boolean {
  return /表格|文本|文件|音视频|按钮|小工具|固定流程|自动化|原型/.test(line) && line.length <= 38;
}

function keepProof(line: string): boolean {
  return /24~72|24~48|首版|定金|报价|修改|周期|199|399|699|999/.test(line) && line.length <= 42;
}

function keepPayment(line: string): boolean {
  return /定金|微信|支付宝|到账|尾款|收款码/.test(line) && line.length <= 42;
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

function extractArtifacts(title: string, text: string): CompressionArtifacts {
  const sourceLines = linesOf(text);
  const promise = pickFirst(sourceLines, [/重复、机械/, /反复手工/, /自动化流程/, /小而快/], sourceLines[0] || "");
  const audience = pickFirst(sourceLines, [/如果你/, /手里有/, /适合/, /最近开始接/]);
  const categories = unique(sourceLines.filter(keepCategory).map(cleanBullet))
    .filter((line) => !/经常做表格|输入\s*\/\s*素材|适合：/.test(line))
    .slice(0, 6);
  const asks = [
    "你现在的输入 / 素材 / 原始文件是什么？",
    "你最终想输出成什么结果？",
    "最晚什么时候要？",
  ];
  const proof = unique(sourceLines.filter(keepProof).map(cleanBullet)).slice(0, 10);
  const process = unique(pickMany(sourceLines, [/直接发我/, /直接回你/, /确认 3 件事/, /最小闭环/, /排期/, /开工/])).slice(0, 10);
  const pricing = unique(sourceLines.map(cleanBullet).filter((line) => /199|399|699|999|报价/.test(line) && line.length <= 40)).slice(0, 10);
  const payment = unique(sourceLines.filter(keepPayment).map(cleanBullet)).slice(0, 10);
  const riskControl = unique(pickMany(sourceLines, [/不要/, /不建议/, /边界/, /低于 199/, /先把/]))
    .filter((line) => !/反复手工做的重复工作/.test(line))
    .slice(0, 10);
  return { sourceTitle: title, sourceText: normalize(text), sourceLines, promise, audience, categories, asks, proof, process, pricing, payment, riskControl };
}

function buildPlatformPost(a: CompressionArtifacts): string {
  const cat = a.categories.length ? a.categories.slice(0, 3).join("、") : "重复工作自动化";
  return compressToLimit(`我现在单独接${cat}这类小而快自动化单。直接发我：现在输入是什么 / 想输出什么 / 最晚什么时候要。我会直接回你能不能做、多久、多少钱；24~72 小时给首版。`, PLATFORM_LIMIT);
}

function buildOpenCard(a: CompressionArtifacts, source: SourcePick): string {
  const summary = a.promise || "把重复、机械、容易出错的电脑工作，先压成小而快的自动化交付。";
  const categories = a.categories.slice(0, 5).map((item) => `- ${item}`).join("\n") || "- 表格 / 文本 / 文件批处理\n- 音视频机械处理\n- 固定流程按钮化 / 本地小工具";
  const proof = unique([
    a.proof.find((item) => /24~72|24~48|首版/.test(item)) || "24~72 小时首版",
    a.pricing.find((item) => /199|399|699|999/.test(item)) || "轻量快修 199~399 / 标准小单 399~699 / 稍复杂首版 699~999",
    a.payment.find((item) => /50% 定金/.test(item)) || "先付 50% 定金开工，首版后补尾款",
    "默认只含 1 次小调整",
  ]);
  const avoid = unique([
    a.riskControl.find((item) => /不要讲长方案|不要先免费咨询/.test(item)) || "不要讲长方案，不要先免费咨询很多轮",
    a.riskControl.find((item) => /不要一上来接大而全需求|不建议一上来做很大/.test(item)) || "不要一上来接大而全需求，先锁最小闭环",
    a.riskControl.find((item) => /边界/.test(item)) || "边界不清先收输入 / 输出 / 时间，不展开技术细节",
  ]);
  const ask3 = a.asks.map((line, index) => `${index + 1}）${line}`).join("\n");
  const opening = `如果你手里有一段重复、机械、容易出错的工作，想先压成一个小而快的脚本 / 本地工具 / 自动化流程，直接把现在输入是什么、想输出什么、最晚什么时候要发我，我直接回你能不能做、多久、多少钱。`;
  const quote = `我建议先按最小闭环做：\n- 输入：XXX\n- 输出：XXX\n- 这次先只做最核心的一步\n- 周期：24~72 小时首版\n- 报价：XXX 元\n- 包含：首版 + 1 次小调整`;
  const deposit = `可以，先付 50% 定金开工，首版确认后再补尾款。支持微信 / 支付宝，你选一个我把收款码发你；付完把截图发我，我确认到账后马上锁排期。`;
  const flow = [
    "1. 发主文案给 3~5 个最可能成交的人",
    "2. 有回复就只收：输入 / 输出 / 时间",
    "3. 信息清楚后立刻发报价模板",
    "4. 对方不明显犹豫就发 50% 定金模板",
    "5. 到账后发开工确认并锁排期",
  ].join("\n");

  return `# 最终执行卡｜打开即发顺序卡\n\n来源：${source.path}\n最后更新时间：${new Date(source.mtimeMs).toLocaleString("zh-CN", { hour12: false })}\n\n## 一句话主线\n${summary}\n\n## 今晚只卖这三类\n${categories}\n\n## 打开先发这一段\n${opening}\n\n## 对方一回复，只问这三件事\n${ask3}\n\n## 快速报价模板\n${quote}\n\n## 收定金模板\n${deposit}\n\n## 统一边界\n${proof.map((item) => `- ${item}`).join("\n")}\n\n## 不要做的事\n${avoid.map((item) => `- ${item}`).join("\n")}\n\n## 最少动作顺序\n${flow}\n\n## 可公开短帖（120 字内）\n${buildPlatformPost(a)}\n\n## 陌生客户留痕入口\nhttp://127.0.0.1:8899/platform-entry.html\n\n## 备注\n这张卡的目标不是解释更多，而是：打开就发、有人回就问三件事、信息一清就报价、报价一接就收定金。\n`;
}

async function findLatestArtifactFile(root: string, fileName: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(root, entry.name, fileName);
    try {
      const s = await stat(candidate);
      matches.push({ path: candidate, mtimeMs: s.mtimeMs });
    } catch {}
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path || null;
}

async function pickBestSource(): Promise<SourcePick> {
  const picks: SourcePick[] = [];
  for (const rel of SOURCE_CANDIDATES) {
    const abs = resolve(ROOT, rel);
    try {
      const s = await stat(abs);
      picks.push({ label: basename(rel, extname(rel)), path: rel, mtimeMs: s.mtimeMs });
    } catch {}
  }

  const latestCompressed = await findLatestArtifactFile(ARTIFACTS_DIR, "成交压缩包.md");
  if (latestCompressed) {
    const s = await stat(latestCompressed);
    picks.push({ label: "最新成交压缩包", path: latestCompressed.replace(`${ROOT}/`, ""), mtimeMs: s.mtimeMs });
  }

  if (!picks.length) {
    throw new Error("未找到可用成交素材源。\n");
  }

  picks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return picks[0];
}

async function main() {
  const source = await pickBestSource();
  const text = await readFile(resolve(ROOT, source.path), "utf8");
  const artifacts = extractArtifacts(source.label, text);
  const output = buildOpenCard(artifacts, source);

  await mkdir(resolve(ROOT, "task_output"), { recursive: true });
  await writeFile(resolve(ROOT, "task_output", "最终执行卡-打开即发顺序卡.md"), output, "utf8");

  const latestJson = {
    generatedAt: new Date().toISOString(),
    source,
    platformPost: buildPlatformPost(artifacts),
    opening: "如果你手里有一段重复、机械、容易出错的工作，想先压成一个小而快的脚本 / 本地工具 / 自动化流程，直接把现在输入是什么、想输出什么、最晚什么时候要发我，我直接回你能不能做、多久、多少钱。",
    ask3: artifacts.asks,
  };
  await writeFile(resolve(ROOT, "task_output", "最终执行卡-最新摘要.json"), JSON.stringify(latestJson, null, 2), "utf8");
  console.log(`已生成 task_output/最终执行卡-打开即发顺序卡.md，来源：${source.path}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
