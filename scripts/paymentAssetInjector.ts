#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PAYMENT_CONFIG_PATH = resolve("data", "payment-config.json");

interface DirectMethodConfig {
  label: string;
  instruction?: string;
  assetPath?: string;
  note?: string;
}

interface PaymentConfig {
  direct: {
    preferredLabel: string;
    methods: DirectMethodConfig[];
    remarkTemplate: string;
  };
  platform: {
    label: string;
    instruction?: string;
    link?: string;
    note?: string;
  };
  confirmation: {
    defaultStartWindow: string;
    askForProof: string;
  };
  binance?: unknown;
}

function getMethod(config: PaymentConfig, keyword: string): DirectMethodConfig {
  const method = config.direct.methods.find((item) => item.label.includes(keyword));
  if (!method) {
    throw new Error(`payment-config.json 中未找到包含 ${keyword} 的收款方式配置`);
  }
  return method;
}

function buildForwardCopy(config: PaymentConfig, projectName: string): string {
  const wechat = getMethod(config, "微信");
  const alipay = getMethod(config, "支付宝");
  const platformLine = config.platform.link
    ? `如果你更希望走平台留痕，也可以直接走这里：${config.platform.link}`
    : "如果你更希望走平台留痕，也可以告诉我，我这边再给你平台入口。";

  return [
    `可以，${projectName} 这边我先收 50% 定金开工。`,
    `你可以直接选 ${config.direct.preferredLabel}：`,
    `1. ${wechat.label}：${wechat.note ?? "见图付款"}`,
    `2. ${alipay.label}：${alipay.note ?? "见图付款"}`,
    platformLine,
    config.direct.remarkTemplate.replace("{projectName}", projectName),
    config.confirmation.askForProof,
  ].join("\n");
}

async function main(): Promise<void> {
  const raw = await readFile(PAYMENT_CONFIG_PATH, "utf8");
  const config = JSON.parse(raw) as PaymentConfig;
  const projectName = process.argv[2] ?? "这个项目";
  const copy = buildForwardCopy(config, projectName);
  process.stdout.write(`${copy}\n`);
}

void main();
