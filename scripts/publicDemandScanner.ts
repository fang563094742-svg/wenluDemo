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
  confidence: number;
  requiredSkills: string[];
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

function inferRequiredSkills(lead: RawLead): string[] {
  const text = `${lead.title} ${lead.snippet}`;
  const skills: string[] = [];

  if (/(WEB|H5|网页|前端)/i.test(text)) skills.push("前端页面");
  if (/(管理|系统|后台|企业应用|数据|导出|处理)/i.test(text)) skills.push("后台系统");
  if (/(自动|批量|工具|流程)/i.test(text)) skills.push("自动化脚本");
  if (/(接口|API|对接)/i.test(text)) skills.push("接口对接");
  if (skills.length === 0) skills.push("需求澄清");

  return [...new Set(skills)];
}

function inferConfidence(score: number, fit: QualifiedLead["fit"]): number {
  const base = fit === "high" ? 0.78 : fit === "medium" ? 0.61 : 0.35;
  const adjusted = base + Math.max(-0.08, Math.min(0.08, score * 0.02));
  return Number(Math.max(0, Math.min(0.95, adjusted)).toFixed(2));
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
  const requiredSkills = inferRequiredSkills(lead);
  const confidence = inferConfidence(score, fit);
  return { ...lead, score, fit, reason, category, reply, confidence, requiredSkills };
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
      `- 判断：${lead.reason.join("；") || "待补充"}`,
      `- 置信度：${lead.confidence}`,
      `- 需要能力：${lead.requiredSkills.join("、")}`,
      `- 链接：${lead.url}`,
      `- 首条可发回复：${lead.reply}`,
      "",
    ].join("\n"))
  ].join("\n");

  const salesCard = shortlisted.map((lead, index) => [
    `【${index + 1}】${lead.title}`,
    `预算：${lead.budget}｜工期：${lead.deadline}｜匹配度：${lead.fit}/${lead.score}`,
    `链接：${lead.url}`,
    `首发：${lead.reply}`,
    "",
  ].join("\n")).join("\n");

  await writeFile(resolve(outDir, "scan.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(resolve(outDir, "scan.md"), md, "utf8");
  await writeFile(resolve(outDir, "sales-card.txt"), salesCard, "utf8");

  console.log(JSON.stringify({ outDir, shortlisted: summary.shortlisted, totalParsed: summary.totalParsed }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
