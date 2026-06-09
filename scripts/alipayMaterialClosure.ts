#!/usr/bin/env tsx
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const CONFIG_PATH = resolve(PROJECT_ROOT, "data", "payment-config.json");
const ASSET_DIR = resolve(PROJECT_ROOT, "data", "payment-assets");
const PRIMARY_TARGET = resolve(ASSET_DIR, "alipay-pay.jpg");
const COMPAT_TARGET = resolve(ASSET_DIR, "alipay-pay.png");
const BACKUP_DIR = resolve(ASSET_DIR, "backups");
const OUTPUT_DIR = resolve(PROJECT_ROOT, "task_output");
const STANDBY_CARD = resolve(OUTPUT_DIR, "alipay-material-injection-standby.md");
const RESULT_PATH = resolve(OUTPUT_DIR, "alipay-material-injection-result.json");
const HANDOFF_PATH = resolve(OUTPUT_DIR, "alipay-material-handoff.txt");
const RECEIPT_PATH = resolve(OUTPUT_DIR, "alipay-receipt-confirmation.txt");
const KICKOFF_PATH = resolve(OUTPUT_DIR, "alipay-kickoff-confirmation.txt");

type PaymentConfig = {
  direct: {
    preferredLabel: string;
    methods: Array<{
      label: string;
      instruction?: string;
      assetPath?: string;
      note?: string;
    }>;
    remarkTemplate: string;
  };
  confirmation: {
    defaultStartWindow: string;
    askForProof: string;
  };
};

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function injectIfNeeded(sourcePath?: string): Promise<{ injected: boolean; source?: string; backup?: string }> {
  if (!sourcePath) {
    return { injected: false };
  }
  const source = resolve(PROJECT_ROOT, sourcePath);
  await access(source, constants.R_OK);
  await mkdir(BACKUP_DIR, { recursive: true });
  let backup: string | undefined;
  if (await exists(PRIMARY_TARGET)) {
    const originalExt = extname(source) || ".jpg";
    backup = resolve(BACKUP_DIR, `alipay-pay-before-${nowStamp()}${originalExt}`);
    await copyFile(PRIMARY_TARGET, backup);
  }
  await copyFile(source, PRIMARY_TARGET);
  await copyFile(source, COMPAT_TARGET);
  return { injected: true, source, backup };
}

function buildHandoff(config: PaymentConfig, projectName: string): string {
  const remark = config.direct.remarkTemplate.replace("{projectName}", projectName);
  return [
    `可以，${projectName} 这边先走 50% 定金开工。`,
    `支付宝这边你直接扫这个收款码付款就行。`,
    remark,
    config.confirmation.askForProof,
    `我确认到账后，今天就开始排期；24~48 小时给你首版。`,
  ].join("\n");
}

function buildReceipt(projectName: string): string {
  return [
    `收到，${projectName} 这边我已经确认到账。`,
    `现在给你锁排期，并按刚才确认的范围开始推进。`,
    `如果你这边还有补充素材或参考样例，现在一并发我，我直接并进首版。`,
  ].join("\n");
}

function buildKickoff(config: PaymentConfig): string {
  return [
    `好，我这边正式开工。`,
    `当前锁定范围按刚才确认的内容推进，默认包含 1 次小调整；如果中途新增范围，我会先和你确认再补差价。`,
    config.confirmation.defaultStartWindow,
  ].join("\n");
}

async function refreshStandbyCard(config: PaymentConfig): Promise<void> {
  const content = [
    `# 支付宝收款码素材注入执行状态`,
    "",
    `当前真实状态：`,
    `- 标准主落盘位置：\`data/payment-assets/alipay-pay.jpg\``,
    `- 兼容落盘位置：\`data/payment-assets/alipay-pay.png\``,
    `- 收款配置入口：\`data/payment-config.json\``,
    `- 当前项目内已存在可直接发送的支付宝真实收款码主文件`,
    `- 若后续用户给出新素材，可执行同名覆盖并自动同步兼容文件`,
    "",
    `当前可直接转发承接文案：`,
    buildHandoff(config, "这个项目"),
    "",
    `到账确认：`,
    buildReceipt("这个项目"),
    "",
    `开工确认：`,
    buildKickoff(config),
  ].join("\n");
  await writeFile(STANDBY_CARD, content, "utf8");
}

async function main(): Promise<void> {
  const sourceArg = process.argv[2];
  const projectName = process.argv[3] ?? "这个项目";
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw) as PaymentConfig;
  const alipay = config.direct.methods.find((item) => item.label.includes("支付宝"));
  if (!alipay) throw new Error("未找到支付宝收款配置");

  const injectResult = await injectIfNeeded(sourceArg);
  alipay.assetPath = "data/payment-assets/alipay-pay.jpg";
  alipay.instruction = "直接发送 data/payment-assets/alipay-pay.jpg 作为支付宝真实收款码。";
  alipay.note = sourceArg
    ? `已注入 ${sourceArg}；直接扫码付款即可，付款后把截图发我确认。`
    : alipay.note ?? "直接扫码付款即可，付款后把截图发我确认。";

  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const handoff = buildHandoff(config, projectName);
  const receipt = buildReceipt(projectName);
  const kickoff = buildKickoff(config);
  await writeFile(HANDOFF_PATH, `${handoff}\n`, "utf8");
  await writeFile(RECEIPT_PATH, `${receipt}\n`, "utf8");
  await writeFile(KICKOFF_PATH, `${kickoff}\n`, "utf8");
  await refreshStandbyCard(config);

  const targetStat = await stat(PRIMARY_TARGET);
  const result = {
    updatedAt: new Date().toISOString(),
    injected: injectResult.injected,
    source: injectResult.source ?? null,
    backup: injectResult.backup ?? null,
    primaryTarget: "data/payment-assets/alipay-pay.jpg",
    compatTarget: "data/payment-assets/alipay-pay.png",
    size: targetStat.size,
    handoffPath: "task_output/alipay-material-handoff.txt",
    receiptPath: "task_output/alipay-receipt-confirmation.txt",
    kickoffPath: "task_output/alipay-kickoff-confirmation.txt"
  };
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
