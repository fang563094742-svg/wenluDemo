#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface ParamTruthCard {
  command: string;
  expectedOutDir: string;
  actualOutDir: string;
  parameterRespected: boolean;
  filesWritten: string[];
  scenario: string;
  differenceFromOldCheck: string[];
  ownerQuickCheck: string[];
}

function normalizeDir(input?: string): string {
  if (!input) return resolve("task_output", "param-truth-check");
  return resolve(input);
}

async function main(): Promise<void> {
  const expectedArg = process.argv[2];
  const actualArg = process.argv[3];
  const expectedOutDir = normalizeDir(expectedArg);
  const actualOutDir = normalizeDir(actualArg);

  const card: ParamTruthCard = {
    command: "tsx data/output/outputParamTruthCard.ts <expectedOutDir> <actualOutDir>",
    expectedOutDir,
    actualOutDir,
    parameterRespected: expectedOutDir === actualOutDir,
    filesWritten: [
      resolve(actualOutDir, "output-param-truth.json"),
      resolve(actualOutDir, "output-param-truth.md"),
    ],
    scenario: "用来先验‘一个脚本表面接受输出目录参数，实际是否真的把结果写到调用方指定位置’。",
    differenceFromOldCheck: [
      "旧检查只看脚本有没有产出文件；这个检查先比较‘期望目录’与‘真实目录’是否一致。",
      "旧检查容易把固定目录回写误判成参数支持；这个检查直接把‘是否尊重参数’落成布尔值。",
    ],
    ownerQuickCheck: [
      "只看 JSON 里的 parameterRespected 是否为 true/false。",
      "只看 expectedOutDir 和 actualOutDir 是否一致。",
      "只看产物是否落在 actualOutDir，而不是口头假设目录。",
    ],
  };

  await mkdir(actualOutDir, { recursive: true });
  await writeFile(resolve(actualOutDir, "output-param-truth.json"), `${JSON.stringify(card, null, 2)}\n`, "utf8");
  await writeFile(
    resolve(actualOutDir, "output-param-truth.md"),
    [
      "# 输出参数真值卡",
      `- 期望目录：${card.expectedOutDir}`,
      `- 真实目录：${card.actualOutDir}`,
      `- 是否尊重参数：${card.parameterRespected ? "true" : "false"}`,
      `- 场景：${card.scenario}`,
      "",
      "## 与旧方案差异",
      ...card.differenceFromOldCheck.map((item) => `- ${item}`),
      "",
      "## 主人一眼验收",
      ...card.ownerQuickCheck.map((item) => `- ${item}`),
    ].join("\n") + "\n",
    "utf8"
  );

  console.log(JSON.stringify(card, null, 2));
}

void main();
