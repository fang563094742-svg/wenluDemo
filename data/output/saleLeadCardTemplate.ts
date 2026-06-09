#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface TemplateItem {
  url: string;
  scene: string;
  expectedSignals: string[];
}

interface TemplateFile {
  generatedAt: string;
  purpose: string;
  items: TemplateItem[];
}

async function main(): Promise<void> {
  const outDir = resolve("task_output", "sale-lead-card-template");
  await mkdir(outDir, { recursive: true });

  const template: TemplateFile = {
    generatedAt: new Date().toISOString(),
    purpose: "给单页公开需求详情页结构化线索卡能力提供可直接复用的输入模板",
    items: [
      {
        url: "https://sxsapi.com/post/857",
        scene: "当前 Safari 前台公开需求页",
        expectedSignals: ["title", "budget", "requiredSkills", "deliverables"],
      },
      {
        url: "https://sxsapi.com/post/856",
        scene: "同站另一条公开需求页，用于复用验尸",
        expectedSignals: ["title", "budget", "requiredSkills", "deliverables"],
      }
    ],
  };

  await writeFile(resolve(outDir, "latest.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const summary = [
    "# 单页售卖线索卡输入模板",
    `- 生成时间：${template.generatedAt}`,
    `- 用途：${template.purpose}`,
    ...template.items.map((item, index) => `- 样例${index + 1}：${item.url}｜${item.scene}｜期望字段：${item.expectedSignals.join(" / ")}`),
    "",
    "## 适用场景",
    "- 对着一条公开需求详情页，先给结构化脚本一个稳定输入清单，而不是临时手敲 URL。",
    "",
    "## 与旧方案差异",
    "- 旧方案直接跑单页；这个模板先把可复用输入集合落盘，方便批量复用与验尸。",
    "- 旧方案产出结果卡；这个模板产出的是能力前置的输入法源。",
    "",
    "## 一眼验收",
    "- `task_output/sale-lead-card-template/latest.json` 里必须至少有 2 条 URL 样例。",
    "- 每条样例都必须带 `scene` 和 4 个期望字段信号。"
  ].join("\n");

  await writeFile(resolve(outDir, "latest.md"), `${summary}\n`, "utf8");

  const templateFile = JSON.parse(await readFile(resolve(outDir, "latest.json"), "utf8")) as TemplateFile;
  if (!Array.isArray(templateFile.items) || templateFile.items.length < 2) {
    throw new Error("template items missing");
  }
}

void main();
