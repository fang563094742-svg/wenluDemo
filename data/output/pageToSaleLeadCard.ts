#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SaleLeadCard {
  url: string;
  title: string;
  budget: string;
  summary: string;
  requiredSkills: string[];
  deliverables: string[];
  confidence: "high" | "medium" | "low";
  whyWorthReply: string[];
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pickFirst(html: string, patterns: RegExp[], fallback = ""): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return fallback;
}

function collectMatches(html: string, pattern: RegExp): string[] {
  const results = new Set<string>();
  for (const match of html.matchAll(pattern)) {
    const value = clean(match[1] ?? "");
    if (value) results.add(value);
  }
  return [...results];
}

function splitSignals(text: string): string[] {
  return text
    .split(/[，。；;、|]/)
    .map((item) => clean(item))
    .filter((item) => item.length >= 2);
}

function inferSkills(summary: string): string[] {
  const mapping: Array<[RegExp, string]> = [
    [/python/i, "Python"],
    [/stl/i, "STL 数据格式"],
    [/3d|三维|建模/i, "3D 处理"],
    [/参数|参数化/i, "参数化接口设计"],
    [/生成|指定区域/i, "规则生成/区域处理"],
  ];
  const hits = mapping.filter(([regex]) => regex.test(summary)).map(([, label]) => label);
  return hits.length ? hits : ["需人工复核技能要求"];
}

function inferDeliverables(summary: string): string[] {
  const base = splitSignals(summary).slice(0, 6);
  if (base.length) return base;
  return ["交付物需人工复核"];
}

function buildWhyWorthReply(card: SaleLeadCard): string[] {
  const reasons = [
    `预算显示为 ${card.budget || "待商议"}，存在最小切单空间`,
    card.requiredSkills.length > 0 ? `技能信号明确：${card.requiredSkills.join(" / ")}` : "技能信号仍需人工补锤",
    card.deliverables.length > 0 ? `任务可拆成 ${card.deliverables.slice(0, 3).join(" / ")}` : "交付范围仍需人工确认",
  ];
  return reasons;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 WenLuLeadCard/1.0",
      "accept-language": "zh-CN,zh;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return await response.text();
}

function buildCard(url: string, html: string): SaleLeadCard {
  const title = pickFirst(html, [/<title>([^<]+)<\/title>/i], "未识别标题");
  const summary = pickFirst(html, [
    /<meta name="description" content="([\s\S]*?)"\s*\/?/i,
    /<meta content="([\s\S]*?)"\s+name="description"\s*\/?/i,
  ], "");
  const budget = pickFirst(html, [
    /外包预算[:：]?\s*([^_<\n]+)/i,
    /预算[:：]?\s*([^，。<\n]+)/i,
    /￥\s*([^<\s]+)/i,
  ], "待商议");

  const anchors = collectMatches(html, />([^<>]{2,24}(?:python|stl|3D|参数化|生成|制作|步骤|接口)[^<>]{0,24})</gi);
  const requiredSkills = [...new Set([...inferSkills(summary), ...anchors.filter((item) => /(python|stl|3D|参数化)/i.test(item))])];
  const deliverables = [...new Set([...inferDeliverables(summary), ...anchors.filter((item) => /(制作|生成|步骤|接口)/.test(item))])].slice(0, 8);

  const confidence: SaleLeadCard["confidence"] = summary && requiredSkills[0] !== "需人工复核技能要求" ? "high" : summary ? "medium" : "low";
  const card: SaleLeadCard = {
    url,
    title,
    budget,
    summary,
    requiredSkills,
    deliverables,
    confidence,
    whyWorthReply: [],
  };
  card.whyWorthReply = buildWhyWorthReply(card);
  return card;
}

function resolveOutDir(explicitOutDir?: string): string {
  return explicitOutDir ? resolve(explicitOutDir) : resolve("task_output", "page-sale-lead-card");
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const explicitOutDir = process.argv[3];
  if (!url) {
    console.error("usage: tsx scripts/pageToSaleLeadCard.ts <url> [outDir]");
    process.exit(1);
  }

  const html = await fetchHtml(url);
  const card = buildCard(url, html);
  const outDir = resolveOutDir(explicitOutDir);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "latest.json"), `${JSON.stringify(card, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
