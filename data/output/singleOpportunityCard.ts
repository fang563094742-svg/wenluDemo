#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface OpportunityCard {
  fetchedAt: string;
  source: string;
  title: string;
  url: string;
  budget: string;
  confidence: number;
  requiredSkills: string[];
  summary: string;
}

function clean(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function pick(fragment: string, pattern: RegExp, fallback = ""): string {
  const match = fragment.match(pattern);
  return clean(match?.[1] ?? fallback);
}

function extractFirstCard(html: string): OpportunityCard {
  const blocks = html.split('<div class="posts-item posts-item-gallery">').slice(1);
  for (const block of blocks) {
    const title = clean((block.match(/<a href="[^"]+" target="_blank"\s*>\s*([^<]{2,120})\s*<\/a>/)?.[1]) ?? "");
    if (!title || /广告位招商|推广投放/.test(title)) continue;

    const href = block.match(/<a href="([^"]+)" target="_blank"\s*>\s*[^<]{2,120}\s*<\/a>/)?.[1] ?? "/";
    const budget = pick(block, /text-align: right;[\s\S]*?￥\s*([\s\S]*?)<\/span>/, "待商议");
    const summary = `${title}｜预算:${budget}`;
    const text = `${title} ${summary}`;
    const requiredSkills: string[] = [];
    if (/(WEB|H5|网页|前端)/i.test(text)) requiredSkills.push("前端页面");
    if (/(管理|系统|后台|数据|导出|处理)/i.test(text)) requiredSkills.push("后台系统");
    if (/(自动|批量|工具|流程)/i.test(text)) requiredSkills.push("自动化脚本");
    if (/(接口|API|对接)/i.test(text)) requiredSkills.push("接口对接");
    if (requiredSkills.length === 0) requiredSkills.push("需求澄清");

    return {
      fetchedAt: new Date().toISOString(),
      source: "sxsapi",
      title,
      url: new URL(href, "https://sxsapi.com").toString(),
      budget,
      confidence: 0.78,
      requiredSkills: [...new Set(requiredSkills)],
      summary,
    };
  }

  throw new Error("no public opportunity block found");
}

async function main(): Promise<void> {
  const response = await fetch("https://sxsapi.com/", {
    headers: {
      "user-agent": "Mozilla/5.0 WenLuSingleOpportunityCard/1.0",
      "accept-language": "zh-CN,zh;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  const html = await response.text();
  const card = extractFirstCard(html);

  const outDir = resolve("data", "output");
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, "single-opportunity-card.json");
  await writeFile(outFile, JSON.stringify(card, null, 2), "utf8");
  console.log(JSON.stringify({ outFile, title: card.title, url: card.url }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
