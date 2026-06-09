#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface RawLead {
  source: string;
  title: string;
  budget: string;
  deadline: string;
  published: string;
  url: string;
  snippet: string;
}

interface QualifiedLead extends RawLead {
  score: number;
  fit: "high" | "medium" | "low";
  reason: string[];
  category: "automation" | "prototype" | "other";
  reply: string;
  action: "直接追" | "先三问" | "放弃";
  quote: string;
  delivery: string;
  mvp: string;
  risk: string;
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(fragment: string, pattern: RegExp, fallback = ""): string {
  const match = fragment.match(pattern);
  return clean(match?.[1] ?? fallback);
}

function matchAllLeads(html: string): RawLead[] {
  const blocks = html.split('<div class="posts-item posts-item-gallery">').slice(1);
  const leads: RawLead[] = [];

  for (const block of blocks) {
    const titleText = clean((block.match(/<a href="[^"]+" target="_blank"\s*>\s*([^<]{2,120})\s*<\/a>/)?.[1]) ?? "");
    if (!titleText || /广告位招商|推广投放/.test(titleText)) continue;

    const href = block.match(/<a href="([^"]+)" target="_blank"\s*>\s*[^<]{2,120}\s*<\/a>/)?.[1] ?? "/";
    const budget = pick(block, /text-align: right;[\s\S]*?￥\s*([\s\S]*?)<\/span>/, "待商议");
    const deadline = pick(block, /label label-default\s*">([^<]*?工期)<\/span>/, "商议工期");
    const published = pick(block, /<span class="time">([^<]{1,30})<\/span>/, "未知");

    leads.push({
      source: "sxsapi",
      title: titleText,
      budget,
      deadline,
      published,
      url: new URL(href, "https://sxsapi.com").toString(),
      snippet: `${titleText}｜预算:${budget}｜工期:${deadline}`,
    });
  }

  return leads;
}

function inferQuote(category: QualifiedLead["category"], fit: QualifiedLead["fit"], budget: string): string {
  if (fit === "high" && category === "prototype") return "先报 999~1999 元首版";
  if (category === "automation") return /1千~5千/.test(budget) ? "先报 699~1499 元最小工具版" : "先报 499~999 元验证版";
  if (/1千~5千/.test(budget)) return "先报 699~999 元最小交付版";
  return "先报 399~699 元信息验证版";
}

function inferDelivery(fit: QualifiedLead["fit"], category: QualifiedLead["category"]): string {
  if (fit === "high") return "24~48 小时出首版范围确认";
  if (category === "automation") return "2~3 天出可跑通首版";
  return "1~2 天出结构化首版";
}

function inferMvp(title: string, category: QualifiedLead["category"]): string {
  if (/真假冬虫夏草/.test(title)) return "先做图片上传 + 人工规则判别 + 结果页，不碰训练模型";
  if (category === "automation") return "先做单文件输入、单结果输出的本地脚本版";
  if (category === "prototype") return "先做单页面原型 + 核心流程演示，不做全量后台";
  return "先做最小可展示件，验证需求真假与付款意愿";
}

function inferRisk(title: string, category: QualifiedLead["category"]): string {
  if (/三维|模型|算法|识别/.test(title)) return "存在算法/精度预期失控风险，必须先锁 MVP";
  if (category === "other") return "需求边界模糊，先问清输入输出再报价";
  return "低风险，可先推进三问收边界";
}

function scoreLead(lead: RawLead): QualifiedLead {
  let score = 0;
  const reason: string[] = [];
  const title = lead.title;
  const snippet = `${lead.title} ${lead.budget} ${lead.deadline}`;

  if (/(自动|批量|工具|桌面|WEB|H5|企业应用|管理|数据|导出|处理|系统)/i.test(title)) {
    score += 3;
    reason.push("标题包含工具/系统/数据处理信号");
  }
  if (/(AI|算法|无人机|硬件|摄像头|区块链|音箱APP|三维|模型)/i.test(title)) {
    score -= 3;
    reason.push("更偏硬件/算法/重研发，不适合快速收口");
  }
  if (/(1千以下|1千~5千|待商议)/.test(lead.budget)) {
    score += 2;
    reason.push("预算区间允许先切最小成交件");
  }
  if (/(14天|30天|商议工期|90天)/.test(lead.deadline)) {
    score += 1;
    reason.push("工期可先切首版/MVP");
  }
  if (/(门禁|真假冬虫夏草|音箱APP|无人机)/.test(snippet)) {
    score -= 2;
  }
  if (/github|mblog/i.test(snippet)) {
    score -= 4;
    reason.push("疑似非真实需求条目，剔除");
  }

  const category = /(工具|自动|批量|数据|导出|处理)/.test(title)
    ? "automation"
    : /(WEB|H5|企业应用|系统)/i.test(title)
      ? "prototype"
      : "other";

  const fit: QualifiedLead["fit"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const reply = buildReply(lead, fit, category);
  const action: QualifiedLead["action"] = fit === "high" ? "直接追" : fit === "medium" ? "先三问" : "放弃";
  const quote = inferQuote(category, fit, lead.budget);
  const delivery = inferDelivery(fit, category);
  const mvp = inferMvp(title, category);
  const risk = inferRisk(title, category);
  return { ...lead, score, fit, reason, category, reply, action, quote, delivery, mvp, risk };
}

function buildReply(lead: RawLead, fit: QualifiedLead["fit"], category: QualifiedLead["category"]): string {
  const categoryLine = category === "automation"
    ? "如果你这单核心是把现有数据/文件/流程先压成一个可直接跑的最小工具，我这边可以先接首版。"
    : "如果你这单愿意先切最小可用版，而不是一次做全，我这边可以先接首版。";
  const fitLine = fit === "high"
    ? "这类需求我倾向直接推进三问+最小报价。"
    : "这类需求先确认是否能压成 MVP，再决定要不要继续追。";
  return [
    `看到你这个“${lead.title}”需求了。`,
    categoryLine,
    "你直接补我 3 个信息就行：1）你现在已有的输入/素材是什么；2）这次最先要交付的结果是什么；3）最晚什么时候要。",
    "我收到后直接回你：能不能先做、首版多久、这次先报多少钱。",
    fitLine,
  ].join("");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 WenLuDealScanner/1.0",
      "accept-language": "zh-CN,zh;q=0.9"
    }
  });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return await response.text();
}

async function main(): Promise<void> {
  const html = await fetchText("https://sxsapi.com/");
  const leads = matchAllLeads(html).map(scoreLead);
  const shortlisted = leads.filter((lead) => lead.fit !== "low").sort((a, b) => b.score - a.score).slice(0, 5);

  const outDir = resolve("artifacts", `public-demand-scan-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  const summary = {
    scannedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    source: "https://sxsapi.com/",
    totalParsed: leads.length,
    shortlisted: shortlisted.length,
    leads: shortlisted,
  };

  const md = [
    "# 公开需求扫描首轮结果",
    `扫描时间：${summary.scannedAt}`,
    `来源：${summary.source}`,
    `解析条数：${summary.totalParsed}`,
    `入围条数：${summary.shortlisted}`,
    "",
    ...shortlisted.map((lead, index) => [
      `## ${index + 1}. ${lead.title}`,
      `- 匹配度：${lead.fit}（${lead.score} 分）`,
      `- 预算：${lead.budget}`,
      `- 工期：${lead.deadline}`,
      `- 发布时间：${lead.published}`,
      `- 归类：${lead.category}`,
      `- 建议动作：${lead.action}`,
      `- 建议报价：${lead.quote}`,
      `- 建议周期：${lead.delivery}`,
      `- 最小交付：${lead.mvp}`,
      `- 风险：${lead.risk}`,
      `- 判断：${lead.reason.join("；") || "无"}`,
      `- 公开链接：${lead.url}`,
      `- 首条推进文案：${lead.reply}`,
      ""
    ].join("\n")),
  ].join("\n");

  const salesCard = shortlisted.map((lead, index) => {
    return [
      `[线索 ${index + 1}] ${lead.title}`,
      `预算/工期：${lead.budget} / ${lead.deadline}`,
      `建议动作：${lead.action}`,
      `建议报价：${lead.quote}`,
      `建议周期：${lead.delivery}`,
      `最小交付：${lead.mvp}`,
      `主要风险：${lead.risk}`,
      `为什么追：${lead.reason.join("；") || "可压成最小成交件"}`,
      `立即发送：${lead.reply}`,
      "---"
    ].join("\n");
  }).join("\n");

  const incomeBrief = [
    "# 进钱导向摘要",
    `时间：${summary.scannedAt}`,
    `本轮共抓到 ${summary.totalParsed} 条公开需求，筛出 ${summary.shortlisted} 条可追。`,
    "",
    ...shortlisted.map((lead, index) => `${index + 1}. ${lead.title}｜${lead.action}｜${lead.quote}｜${lead.delivery}`),
    "",
    "首追顺序：先追高匹配且能切 MVP 的，再追预算清晰的小单，最后才碰算法/模型类。"
  ].join("\n");

  await writeFile(resolve(outDir, "scan.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(resolve(outDir, "scan.md"), md, "utf8");
  await writeFile(resolve(outDir, "sales-card.txt"), salesCard, "utf8");
  await writeFile(resolve(outDir, "income-brief.md"), incomeBrief, "utf8");

  console.log(JSON.stringify({ outDir, totalParsed: leads.length, shortlisted: shortlisted.length }, null, 2));
}

void main();
