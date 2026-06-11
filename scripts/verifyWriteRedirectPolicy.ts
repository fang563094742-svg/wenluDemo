import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const filePath = resolve("src/riverMain.ts");
  const source = await readFile(filePath, "utf-8");

  const checks: Array<[string, boolean]> = [
    ["write_file 拒绝越界写入", source.includes("已拒绝写入")],
    ["仍允许写入用户数据目录(WENLU_DIR)", source.includes("WENLU_DIR")],
    ["仍允许写入 /tmp", source.includes('"/tmp"')],
    ["不存在重定向到 data/output 的旧逻辑", !source.includes("已重定向")],
    ["不存在 PROJECT_DATA_DIR 兜底目录", !source.includes("PROJECT_DATA_DIR")],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    for (const [label] of failed) {
      console.error(`FAIL ${label}`);
    }
    process.exit(1);
  }

  for (const [label] of checks) {
    console.log(`OK ${label}`);
  }
}

void main();
