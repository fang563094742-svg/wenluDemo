#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LeadCard {
  source: string;
  title: string;
  budget: string;
  deadline: string;
  published: string;
  url: string;
  fit: "high" | "medium" | "low";
  score: number;
  category: "automation" | "prototype" | "other";
  requiredSkills: string[];
  confidence: number;
  reason: string[];
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

function inferRequiredSkills(title: string, snippet: string): string[] {
  const text = `${title} ${snippet}`;
  const skills = new Set<string>();

  if (/(自动|批量|数据|导出|处理)/.test(text)) skills.add("automation");
  if (/(web|h5|网页|前端|后台|管理系统|企业应用)/i.test(text)) skills.add("web-app");
  if (/(接口|api|对接|同步)/i.test(text)) skills.add("api-integration");
  if (/(管理|后台|系统)/.test(text)) skills.add("admin-panel");
  if (/(表单|录入|导入|导出)/.test(text)) skills.add("data-workflow");
  if (skills.size === 0) skills.add("general-dev");

  return Array.from(skills);
}

function detectCategory(title: string): LeadCard["category"] {
  if (/(工具|自动|批量|数据|导出|处理)/.test(title)) return "automation";
  if (/(WEB|H5|企业应用|系统|后台)/i.test(title)) return "prototype";
  return "other";
}

function scoreLead(title: string, budget: string, deadline: string, snippet: string): { score: number; fit: LeadCard["fit"]; reason: string[]; confidence: number } {
  let score = 0;
  const reason: string[] = [];

  if (/(自动|批量|工具|桌面|WEB|H5|企业应用|管理|数据|导出|处理|系统)/i.test(title)) {
    score += 3;
    reason.push("标题包含工具/系统/数据处理信号");
  }
  if (/(1千以下|1千~5千|待商议)/.test(budget)) {
    score += 2;
    reason.push("预算允许先切最小成交件");
  }
  if (/(14天|30天|商议工期|90天)/.test(deadline)) {
    score += 1;
    reason.push("工期可先切 MVP");
  }
  if (/(AI|算法|无人机|硬件|摄像头|区块链|音箱APP|三维|模型)/i.test(title)) {
    score -= 3;
    reason.push("偏硬件/重研发，不适合快速收口");
  }
  if (/(github|mblog)/i.test(snippet)) {
    score -= 4;
    reason.push("疑似异常条目");
  }

  const fit: LeadCard["fit"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const confidence = Math.max(0.45, Math.min(0.95, 0.55 + score * 0.06));
  return { score, fit, reason, confidence: Number(confidence.toFixed(2)) };
}

function parseLeadCards(html: string): LeadCard[] {
  const blocks = html.split('<div class="posts-item posts-item-gallery">').slice(1);
  const cards: LeadCard[] = [];

  for (const block of blocks) {
    const title = clean((block.match(/<a href="[^"]+" target="_blank"\s*>\s*([^<]{2,120})\s*<\/a>/)?.[1]) ?? "");
    if (!title || /广告位招商|推广投放/.test(title)) continue;

    const href = block.match(/<a href="([^"]+)" target="_blank"\s*>\s*[^<]{2,120}\s*<\/a>/)?.[1] ?? "/";
    const budget = pick(block, /text-align: right;[\s\S]*?￥\s*([\s\S]*?)<\/span>/, "待商议");
    const deadline = pick(block, /label label-default\s*">([^<]*?工期)<\/span>/, "商议工期");
    const published = pick(block, /<span class="time">([^<]{1,30})<\/span>/, "未知");
    const snippet = `${title}｜预算:${budget}｜工期:${deadline}`;
    const category = detectCategory(title);
    const scored = scoreLead(title, budget, deadline, snippet);

    cards.push({
      source: "sxsapi",
      title,
      budget,
      deadline,
      published,
      url: new URL(href, "https://sxsapi.com").toString(),
      fit: scored.fit,
      score: scored.score,
      category,
      requiredSkills: inferRequiredSkills(title, snippet),
      confidence: scored.confidence,
      reason: scored.reason,
    });
  }

  return cards;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 WenLuSingleLeadCard/1.0",
      "accept-language": "zh-CN,zh;q=0.9"
    }
  });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return await response.text();
}

async function main(): Promise<void> {
  const html = await fetchText("https://sxsapi.com/");
  const cards = parseLeadCards(html)
    .filter((card) => card.fit !== "low")
    .sort((left, right) => right.score - left.score);

  const top = cards.slice(0, 5);
  const outDir = resolve(process.cwd(), "task_output", "single-lead-cards");
  await mkdir(outDir, { recursive: true });

  const jsonPath = resolve(outDir, "sxsapi-top-leads.json");
  const mdPath = resolve(outDir, "sxsapi-top-leads.md");

  await writeFile(jsonPath, `${JSON.stringify(top, null, 2)}\n`, "utf8");

  const markdown = [
    "# SXSAPI Top Leads",
    "",
    ...top.map((card, index) => [
      `## ${index + 1}. ${card.title}`,
      `- url: ${card.url}`,
      `- budget: ${card.budget}`,
      `- deadline: ${card.deadline}`,
      `- published: ${card.published}`,
      `- fit: ${card.fit}`,
      `- score: ${card.score}`,
      `- confidence: ${card.confidence}`,
      `- category: ${card.category}`,
      `- requiredSkills: ${card.requiredSkills.join(", ")}`,
      `- reason: ${card.reason.join("；") || "无"}`,
      ""
    ].join("\n"))
  ].join("\n");

  await writeFile(mdPath, `${markdown}\n`, "utf8");
  console.log(JSON.stringify({ jsonPath, mdPath, count: top.length }, null, 2));
}

void main();
