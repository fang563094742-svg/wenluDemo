#!/usr/bin/env tsx
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { Dirent, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface FileAutopsy {
  path: string;
  bytes: number;
  lines: number;
  category: "script" | "runtime" | "test" | "doc" | "other";
  hints: string[];
}

interface RuntimeCoverage {
  script: string;
  purpose: string;
  command: string;
  evidence: string;
}

interface PathClosure {
  area: string;
  source: string[];
  runtime: string[];
  proof: string[];
  closeout: string;
}

interface LearningLineReport {
  generatedAt: string;
  root: string;
  fileAutopsy: FileAutopsy[];
  runtimeCoverage: RuntimeCoverage[];
  pathClosure: PathClosure[];
  rerunChecklist: string[];
}

const ROOT = resolve(".");
const OUTPUT_DIR = resolve("task_output", "learning-line");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-learning-line.json");
const MD_PATH = resolve(OUTPUT_DIR, "latest-learning-line.md");
const KNOWLEDGE_PATH = resolve("data", "capability-line", "learning-line.json");
const TARGET_DIRS = ["src", "scripts", "tests", "tools", "public"];
// 自我盘点只关心本项目源码，跳过第三方依赖与生成物，避免报告膨胀
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "artifacts",
  "task_output",
  "diagnostic",
  ".next",
  ".venv",
  ".cache"
]);

void main();

async function main() {
  const files = (await Promise.all(TARGET_DIRS.map((dir) => walk(resolve(ROOT, dir))))).flat();
  const uniqueFiles = dedupe(files).sort();
  const fileAutopsy: FileAutopsy[] = [];
  for (const file of uniqueFiles) {
    fileAutopsy.push(await inspectFile(file));
  }

  const runtimeCoverage: RuntimeCoverage[] = [
    {
      script: "scripts/capabilityReport.ts",
      purpose: "盘点现有可复用能力入口",
      command: "npm run capability:report",
      evidence: "task_output/capability-line/latest-capability-report.md"
    },
    {
      script: "scripts/probeProvider.ts",
      purpose: "验证 LLM 提供方真实连通路径",
      command: "npx tsx scripts/probeProvider.ts",
      evidence: "终端输出的 [probe] OK/FAILED 错误链"
    },
    {
      script: "scripts/probeBig.ts",
      purpose: "用大请求体验证运行态边界",
      command: "npx tsx scripts/probeBig.ts",
      evidence: "终端输出的 [probeBig] OK/FAILED 错误链"
    },
    {
      script: "src/api/start.ts",
      purpose: "启动 API 运行态并核对健康检查路径",
      command: "npm run api",
      evidence: "http://127.0.0.1:3721/api/health 或配置端口返回 JSON"
    },
    {
      script: "tests/forgetting.test.ts",
      purpose: "跑最邻近断言测试确认基础可执行性",
      command: "npm test",
      evidence: "vitest 输出通过结果"
    }
  ];

  const pathClosure: PathClosure[] = [
    {
      area: "文件验尸",
      source: fileAutopsy.filter((item) => item.category === "script" || item.category === "test").slice(0, 6).map((item) => item.path),
      runtime: ["scripts/capabilityReport.ts", "scripts/learningLine.ts"],
      proof: ["task_output/capability-line/latest-capability-report.md", "task_output/learning-line/latest-learning-line.md"],
      closeout: "先枚举文件，再按类别抽出脚本/测试/运行入口，避免每轮从零摸索。"
    },
    {
      area: "运行态覆盖",
      source: ["src/api/start.ts", "src/api/app.ts", "src/server/webServer.ts", "scripts/probeProvider.ts", "scripts/probeBig.ts"],
      runtime: ["npm run api", "npx tsx scripts/probeProvider.ts", "npx tsx scripts/probeBig.ts"],
      proof: ["/api/health 返回值", "probe 输出错误链或成功文本"],
      closeout: "把健康检查、真实 provider 连通、大请求边界三层分开跑，能快速判断卡点在服务、网络还是 payload。"
    },
    {
      area: "真实路径收口",
      source: ["package.json", "scripts/capabilityReport.ts", "scripts/learningLine.ts"],
      runtime: ["npm run capability:report", "npx tsx scripts/learningLine.ts"],
      proof: ["data/capability-line/learning-line.json", "task_output/learning-line/latest-learning-line.md"],
      closeout: "把方法与证据固定到 data/ 和 task_output/，下一轮只需复跑命令，不再靠口头记忆。"
    }
  ];

  const report: LearningLineReport = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    fileAutopsy,
    runtimeCoverage,
    pathClosure,
    rerunChecklist: [
      "先运行 npm run capability:report，确认现有脚本能力盘点仍然有效。",
      "再运行 npx tsx scripts/learningLine.ts，刷新验尸/覆盖/收口总表。",
      "需要看运行态时先开 npm run api，再探测 /api/health。",
      "涉及 LLM 连通问题时，先跑 scripts/probeProvider.ts，再跑 scripts/probeBig.ts。",
      "交付前至少执行一次 npm test，确认最近邻断言未退化。"
    ]
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(resolve("data", "capability-line"), { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(MD_PATH, renderMarkdown(report), "utf8");
  await writeFile(KNOWLEDGE_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`学习线报告已生成: ${relative(ROOT, MD_PATH)}`);
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];

  const queue: string[] = [dir];
  const seen = new Set<string>();
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const realDir = await safeRealpath(current);
    if (realDir && seen.has(realDir)) continue;
    if (realDir) seen.add(realDir);

    let items: Dirent[];
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const item of items) {
      const full = join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (IGNORED_DIRS.has(item.name)) continue;
        queue.push(full);
        continue;
      }
      if (item.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

// 去重保险：同一真实路径只保留一条，避免报告出现重复条目
function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

async function inspectFile(file: string): Promise<FileAutopsy> {
  const raw = await readFile(file, "utf8");
  const info = await stat(file);
  const rel = relative(ROOT, file);
  const lines = raw.split(/\r?\n/).length;
  return {
    path: rel,
    bytes: info.size,
    lines,
    category: detectCategory(rel),
    hints: buildHints(rel, raw)
  };
}

function detectCategory(rel: string): FileAutopsy["category"] {
  if (rel.startsWith("scripts/") || rel.startsWith("tools/")) return "script";
  if (rel.startsWith("src/api/") || rel.startsWith("src/server/")) return "runtime";
  if (rel.startsWith("tests/")) return "test";
  if (rel.endsWith(".md")) return "doc";
  return "other";
}

function buildHints(rel: string, raw: string): string[] {
  const hints: string[] = [];
  if (rel.includes("probe")) hints.push("真实连通/边界探针");
  if (rel.includes("start") || raw.includes("listen(")) hints.push("运行态入口");
  if (rel.includes("test") || raw.includes("console.assert")) hints.push("断言验证点");
  if (rel.endsWith(".md")) hints.push("说明文档");
  if (hints.length === 0) hints.push("待人工补充用途说明");
  return hints;
}

function renderMarkdown(report: LearningLineReport): string {
  const fileRows = report.fileAutopsy
    .slice(0, 20)
    .map((item) => `| ${item.path} | ${item.category} | ${item.lines} | ${item.hints.join(" / ")} |`)
    .join("\n");

  const runtimeRows = report.runtimeCoverage
    .map((item) => `| ${item.script} | ${item.command} | ${item.evidence} |`)
    .join("\n");

  const closureBlocks = report.pathClosure
    .map((item) => [
      `## ${item.area}`,
      `- source: ${item.source.join("；")}`,
      `- runtime: ${item.runtime.join("；")}`,
      `- proof: ${item.proof.join("；")}`,
      `- closeout: ${item.closeout}`
    ].join("\n"))
    .join("\n\n");

  return [
    "# 持续学习线复跑报告",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- root: ${report.root}`,
    "",
    "## 文件验尸样本",
    "| path | category | lines | hints |",
    "| --- | --- | ---: | --- |",
    fileRows,
    "",
    "## 运行态覆盖",
    "| script | command | evidence |",
    "| --- | --- | --- |",
    runtimeRows,
    "",
    closureBlocks,
    "",
    "## 复跑清单",
    ...report.rerunChecklist.map((item) => `- ${item}`)
  ].join("\n");
}
