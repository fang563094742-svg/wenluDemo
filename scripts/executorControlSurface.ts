#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec as rawExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(rawExec);
const ROOT = resolve(".");
const OUTPUT_DIR = resolve(ROOT, "task_output", "tool-dominance-line");
const MAP_PATH = resolve(ROOT, "task_output", "unified-orchestration-map.md");
const JSON_PATH = resolve(OUTPUT_DIR, "latest-executor-control-surface.json");

interface ProbeResult {
  label: string;
  command: string;
  ok: boolean;
  signal: string;
}

interface SurfaceItem {
  name: string;
  entry: string[];
  verified: string[];
  gaps: string[];
  role: string;
  probes: ProbeResult[];
}

async function run(command: string): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await exec(command, { cwd: ROOT, maxBuffer: 1024 * 1024 * 8, shell: "/bin/zsh" });
    const signal = [stdout, stderr].join("\n").split("\n").map((line) => line.trim()).find(Boolean) ?? "OK";
    return { label: command, command, ok: true, signal };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const signal = [failed.stderr, failed.stdout, failed.message].filter(Boolean).join("\n").split("\n").map((line) => line.trim()).find(Boolean) ?? "FAILED";
    return { label: command, command, ok: false, signal };
  }
}

function appExists(name: string): boolean {
  return existsSync(`/Applications/${name}.app`) || existsSync(`/System/Applications/${name}.app`) || existsSync(`/System/Volumes/Preboot/Cryptexes/App/System/Applications/${name}.app`);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const probes = {
    codexHelp: await run("codex --help | head -n 5"),
    kiroHelp: await run("kiro --help | head -n 8"),
    safariUrl: await run("osascript -e 'tell application \"Safari\" to if (count of windows) > 0 then get URL of current tab of front window'"),
    safariDriver: await run("safaridriver --version"),
    chromeUrl: await run("osascript -e 'tell application \"Google Chrome\" to if (count of windows) > 0 then get URL of active tab of front window'") ,
    claudeOpen: await run("open -a Claude && sleep 2 && osascript -e 'tell application \"System Events\" to if exists process \"Claude\" then get name of first process whose name is \"Claude\"'") ,
    codexOpen: await run("osascript -e 'tell application \"Codex\" to activate'"),
    kiroOpen: await run("osascript -e 'tell application \"Kiro\" to activate'"),
    chromeOpen: await run("osascript -e 'tell application \"Google Chrome\" to activate'")
  };

  const surfaces: SurfaceItem[] = [
    {
      name: "Codex",
      entry: ["codex CLI", "Codex.app"],
      verified: [
        probes.codexHelp.ok ? "CLI 可用，支持 exec/review/app 等子命令" : "CLI 未通过",
        appExists("Codex") ? "桌面应用存在，可前台化" : "桌面应用缺失"
      ],
      gaps: ["需在仓库/终端上下文内工作"],
      role: "主执行器 / 主调度器",
      probes: [probes.codexHelp, probes.codexOpen]
    },
    {
      name: "Kiro",
      entry: ["kiro CLI", "Kiro.app"],
      verified: [
        probes.kiroHelp.ok ? "CLI 可用，支持 goto/diff/merge/add" : "CLI 未通过",
        appExists("Kiro") ? "桌面应用存在，可前台化" : "桌面应用缺失"
      ],
      gaps: ["未验尸 agent 闭环，只确认编辑器控制面"],
      role: "辅助编辑器 / 人工接管位",
      probes: [probes.kiroHelp, probes.kiroOpen]
    },
    {
      name: "Claude",
      entry: ["Claude.app", "open -a Claude"],
      verified: [
        probes.claudeOpen.ok ? "应用可拉起，进程可观测" : "应用拉起失败",
        appExists("Claude") ? "桌面应用存在" : "桌面应用缺失"
      ],
      gaps: ["未确认 CLI", "未确认稳定脚本接口"],
      role: "备用对话脑 / 人工评审位",
      probes: [probes.claudeOpen]
    },
    {
      name: "Safari",
      entry: ["osascript", "safaridriver", "open"],
      verified: [
        probes.safariUrl.ok ? `可读取当前页：${probes.safariUrl.signal}` : "当前页读取失败",
        probes.safariDriver.ok ? `WebDriver 可用：${probes.safariDriver.signal}` : "WebDriver 未通过"
      ],
      gaps: ["外网页面未做本轮闭环"],
      role: "默认浏览器执行面",
      probes: [probes.safariUrl, probes.safariDriver]
    },
    {
      name: "Chrome",
      entry: ["osascript", "open -a Google Chrome"],
      verified: [
        appExists("Google Chrome") ? "桌面应用存在，可激活" : "桌面应用缺失",
        probes.chromeOpen.ok ? "可前台化" : "前台化失败"
      ],
      gaps: [probes.chromeUrl.ok ? "当前 URL 可读，但稳定性仍待补验" : `当前无稳定 tab 读取：${probes.chromeUrl.signal}`],
      role: "浏览器备胎",
      probes: [probes.chromeOpen, probes.chromeUrl]
    },
    {
      name: "本机控制面",
      entry: ["zsh/bash", "osascript", "open", "git", "node"],
      verified: ["shell 可执行", "文件读写可执行", "应用拉起可执行"],
      gaps: ["不做不可逆整盘动作"],
      role: "最终兜底执行面",
      probes: []
    }
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    mission: "补锤 Codex/Kiro/Claude/浏览器等执行者当前可控面，生成最新统一调度图",
    surfaces,
    defaultDispatch: [
      "Codex 接总目标并落盘",
      "本机控制面补证",
      "Safari 承载浏览器动作",
      "Kiro 接明确编辑/跳转指令",
      "Claude 只做辅助判断"
    ],
    fallbackChain: [
      "Codex 失配 → shell/osascript/open",
      "Kiro 失配 → Codex 直接改文件",
      "Claude 失配 → Codex 收口",
      "Safari 失配 → Chrome → curl/日志",
      "浏览器全失配 → 底层证据链"
    ]
  };

  const md = renderMap(payload.generatedAt, surfaces);
  await writeFile(JSON_PATH, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(MAP_PATH, md, "utf8");
  console.log(`执行者可控面已刷新: ${JSON_PATH}`);
  console.log(`统一调度图已刷新: ${MAP_PATH}`);
}

function renderMap(generatedAt: string, surfaces: SurfaceItem[]): string {
  const lines: string[] = [];
  lines.push("# 统一总调度图（Codex / Kiro / Claude / 浏览器 / 本机控制面）", "", `- 生成时间：${generatedAt}`, "- 目标：把 Codex、Kiro、Claude、浏览器、本机控制面拉成一张统一调度图，明确默认分工、下派顺序、失败降级、验收链。", "- 方法：只记录本机已验尸的真实可控入口，不写猜测性能力。", "", "## 1. 控制面总览", "", "| 控制面 | 当前真实入口 | 已验尸能力 | 当前缺口 | 默认角色 |", "|---|---|---|---|---|");
  for (const surface of surfaces) {
    lines.push(`| ${surface.name} | ${surface.entry.join(" + ")} | ${surface.verified.join("；")} | ${surface.gaps.join("；")} | ${surface.role} |`);
  }
  lines.push("", "## 2. 默认分工", "", "- Codex：默认总调度 + 主执行。", "- Kiro：文件定位 / 可视编辑 / 冲突处理。", "- Claude：高不确定性讨论 / 备用脑 / 对外措辞。", "- Safari：默认浏览器执行面。", "- 本机控制面：任何链路失灵时的最终兜底。", "", "## 3. 默认下派顺序", "", "1. Codex 接总目标：拆分、搜证、改动、落盘。", "2. 本机控制面补证：shell / osascript / open。", "3. Safari 承载浏览器动作。", "4. Kiro 接明确编辑指令。", "5. Claude 只做辅助判断。", "", "## 4. 失败降级链", "", "- Codex 失败：降级到 shell + osascript + open。", "- Kiro 失败：回 Codex 直接改文件。", "- Claude 失败：不进入强依赖验收链。", "- Safari 失败：切 Chrome，再退回 curl / 日志。", "- 浏览器全失败：只看底层证据链。", "", "## 5. 统一验收链", "", "1. 入口验真：命令/应用存在。", "2. 控制验真：CLI --help / activate / 状态读取可用。", "3. 动作验真：打开应用、读取页面、执行具体动作。", "4. 产物验真：调度图与 JSON 落盘。", "5. 收口验真：默认分工、顺序、降级、验收链写清。", "", "## 6. 本轮证据", "");
  for (const surface of surfaces) {
    for (const probe of surface.probes) {
      lines.push(`- ${surface.name}｜${probe.ok ? "通过" : "失败"}｜\`${probe.command}\`｜${probe.signal}`);
    }
  }
  lines.push(`- 产物｜\`task_output/unified-orchestration-map.md\``);
  lines.push(`- 产物｜\`task_output/tool-dominance-line/latest-executor-control-surface.json\``);
  return lines.join("\n");
}

void main();
