#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve("scripts", "finalExecutionCard.ts");
let text = await readFile(path, "utf8");
text = text.replace(
  '  const categories = unique(sourceLines.filter(keepCategory).map(cleanBullet)).slice(0, 8);\n',
  '  const categories = unique(sourceLines.filter(keepCategory).map(cleanBullet)).filter((line) => !/经常做表格|输入 \/ 素材|适合：/.test(line)).slice(0, 8);\n'
);
text = text.replace(
  '  const avoid = unique([\n    a.riskControl.find((item) => /不要讲长方案|不要先免费咨询/.test(item)) || "不要讲长方案，不要先免费咨询很多轮",\n    a.riskControl.find((item) => /不要一上来接大而全需求|不建议一上来做很大/.test(item)) || "不要一上来接大而全需求，先锁最小闭环",\n    a.riskControl.find((item) => /边界/.test(item)) || "边界不清先收输入 / 输出 / 时间，不展开技术细节",\n  ]);\n',
  '  const avoid = unique([\n    a.riskControl.find((item) => /不要讲长方案|不要先免费咨询/.test(item)) || "不要讲长方案，不要先免费咨询很多轮",\n    a.riskControl.find((item) => /不要一上来接大而全需求|不建议一上来做很大/.test(item)) || "不要一上来接大而全需求，先锁最小闭环",\n    a.riskControl.find((item) => /边界/.test(item)) || "边界不清先收输入 / 输出 / 时间，不展开技术细节",\n  ]).filter((item) => !/反复手工做的重复工作/.test(item));\n'
);
await writeFile(path, text, "utf8");
console.log("patched scripts/finalExecutionCard.ts");
