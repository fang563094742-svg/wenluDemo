#!/usr/bin/env tsx
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

interface CapabilityEntry {
  path: string;
  name: string;
  type: "script" | "shell" | "doc" | "other";
  summary: string;
  reuseCommand: string;
}

interface CapabilityReport {
  generatedAt: string;
  projectRoot: string;
  totalEntries: number;
  entries: CapabilityEntry[];
  learned: string[];
  nextReuse: string[];
}

const ROOT = resolve(".");
const TARGET_DIRS = ["scripts", "tools"];
const OUTPUT_DIR = resolve("task_output", "capability-line");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-capability-report.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-capability-report.md");
const KNOWLEDGE_PATH = resolve("data", "capability-line", "capability-methods.json");

void main();

async function main() {
  const files = (await Promise.all(TARGET_DIRS.map((dir) => walk(resolve(ROOT, dir))))).flat()
    .filter((file) => !file.includes("node_modules"))
    .sort();

  const entries: CapabilityEntry[] = [];
  for (const file of files) {
    entries.push(await inspectFile(file));
  }

  const report: CapabilityReport = {
    generatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    totalEntries: entries.length,
    entries,
    learned: [
      "把散落的 scripts/ 与 tools/ 入口统一盘点后，可快速看出当前已经沉淀好的可执行能力，而不是每次靠记忆翻找。",
      "每个能力除了描述，还必须附带‘下次直接怎么运行’的 reuseCommand，才能真正复用。",
      "把能力汇报固定输出到 task_output/capability-line/，就能形成持续可追踪的显性进展。"
    ],
    nextReuse: [
      "每次新增脚本或工具后，运行 npm run capability:report 立即刷新能力总表。",
      "需要对当前的我明牌时，直接查看 task_output/capability-line/latest-capability-report.md。",
      "后续可把该脚本接到其他产出脚本末尾，实现产出后自动汇报。"
    ]
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(resolve("data", "capability-line"), { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(report), "utf8");
  await writeFile(KNOWLEDGE_PATH, JSON.stringify(report.entries, null, 2), "utf8");

  console.log(`能力汇报已生成: ${relative(ROOT, MD_PATH)}`);
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    const items = await readdir(current);
    for (const item of items) {
      const full = join(current, item);
      const info = await stat(full);
      if (info.isDirectory()) {
        queue.push(full);
      } else {
        results.push(full);
      }
    }
  }

  return results;
}

async function inspectFile(file: string): Promise<CapabilityEntry> {
  const rel = relative(ROOT, file);
  const ext = extname(file).toLowerCase();
  const raw = await readFile(file, "utf8");
  const summary = summarize(raw, rel);
  return {
    path: rel,
    name: basename(file),
    type: detectType(ext),
    summary,
    reuseCommand: buildReuseCommand(rel, ext)
  };
}

function detectType(ext: string): CapabilityEntry["type"] {
  if ([".ts", ".js", ".mjs", ".cjs"].includes(ext)) return "script";
  if ([".sh", ".command", ".bash", ""].includes(ext)) return "shell";
  if ([".md", ".txt"].includes(ext)) return "doc";
  return "other";
}

function summarize(raw: string, rel: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = lines.find((line) => line.startsWith("* ") || line.startsWith("- ") || line.startsWith("目标") || line.startsWith("## ") || line.startsWith("/**") || line.includes("这是什么"));
  if (preferred) return preferred.replace(/^[-*#\/ ]+/, "").slice(0, 120);
  return `可执行能力入口：${rel}`;
}

function buildReuseCommand(rel: string, ext: string): string {
  if (rel.startsWith("scripts/") && ext === ".ts") return `npx tsx ${rel}`;
  if ((ext === ".sh" || ext === "") && rel.startsWith("tools/")) return `bash ${rel}`;
  if (ext === ".md") return `open ${JSON.stringify(rel)}`;
  return rel;
}

function renderMarkdown(report: CapabilityReport): string {
  const lines: string[] = [];
  lines.push("# 能力总表");
  lines.push("");
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`项目根目录：${report.projectRoot}`);
  lines.push(`能力总数：${report.totalEntries}`);
  lines.push("");
  lines.push("## 能力清单");
  lines.push("");
  for (const entry of report.entries) {
    lines.push(`### ${entry.name}`);
    lines.push(`- 路径：${entry.path}`);
    lines.push(`- 类型：${entry.type}`);
    lines.push(`- 摘要：${entry.summary}`);
    lines.push(`- 复用命令：\`${entry.reuseCommand}\``);
    lines.push("");
  }
  lines.push("## 本次学到");
  lines.push("");
  for (const item of report.learned) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## 下次直接复用");
  lines.push("");
  for (const item of report.nextReuse) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}
