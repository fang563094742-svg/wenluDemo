#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface EvidenceRef {
  kind: "screenshot" | "chat" | "quote" | "payment" | "delivery" | "note" | "other";
  path: string;
  note?: string;
}

interface AttemptRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  targetAmount: number;
  channel: string;
  counterpart: string;
  demandSummary: string;
  stage: "attempted" | "quoted" | "accepted" | "failed" | "delivered";
  quote?: {
    amount: number;
    currency: string;
    scope: string;
    turnaround?: string;
  };
  outcome: {
    status: "pending" | "won" | "lost";
    failureReason?: string;
    nextAction?: string;
  };
  evidence: EvidenceRef[];
  tags: string[];
}

interface Ledger {
  title: string;
  updatedAt: string;
  targetAmount: number;
  records: AttemptRecord[];
}

const ROOT = resolve(".");
const DATA_DIR = resolve(ROOT, "data", "attempt-ledger");
const JSON_PATH = resolve(DATA_DIR, "attempt-ledger.json");
const MD_PATH = resolve(DATA_DIR, "attempt-ledger.md");
const TEMPLATE_PATH = resolve(DATA_DIR, "attempt-template.md");

function nowIso(): string {
  return new Date().toISOString();
}

function nowHuman(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function newId(): string {
  return `attempt-${Date.now()}`;
}

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadLedger(): Promise<Ledger> {
  if (!existsSync(JSON_PATH)) {
    return {
      title: "1万元目标外部尝试证据账本",
      updatedAt: nowHuman(),
      targetAmount: 10000,
      records: []
    };
  }

  const raw = await readFile(JSON_PATH, "utf8");
  return JSON.parse(raw) as Ledger;
}

function renderMarkdown(ledger: Ledger): string {
  const totalQuoted = ledger.records
    .filter((record) => record.quote)
    .reduce((sum, record) => sum + (record.quote?.amount ?? 0), 0);
  const totalWon = ledger.records
    .filter((record) => record.outcome.status === "won")
    .reduce((sum, record) => sum + (record.quote?.amount ?? 0), 0);
  const totalLost = ledger.records.filter((record) => record.outcome.status === "lost").length;
  const totalPending = ledger.records.filter((record) => record.outcome.status === "pending").length;

  const header = [
    "# 1万元目标外部尝试证据账本",
    "",
    `更新时间：${ledger.updatedAt}`,
    `目标金额：${ledger.targetAmount} 元`,
    `累计尝试：${ledger.records.length} 次`,
    `累计报价额：${totalQuoted} 元`,
    `已成交额：${totalWon} 元`,
    `待推进：${totalPending} 次`,
    `失败/流失：${totalLost} 次`,
    "",
    "## 使用纪律",
    "- 每次外部尝试必须落一条记录，至少写清渠道、对象、需求、当前阶段。",
    "- 每次报价必须补金额、范围、周期，并附上聊天/截图/文案路径。",
    "- 每次失败必须写失败原因，禁止只写‘跟进中’或口头进展。",
    "- 证据不足的记录不算结果，只算待补证。",
    ""
  ].join("\n");

  const body = ledger.records.length
    ? ledger.records
        .slice()
        .reverse()
        .map((record, index) => {
          const quoteLine = record.quote
            ? `- 报价：${record.quote.amount} ${record.quote.currency}｜范围：${record.quote.scope}${record.quote.turnaround ? `｜周期：${record.quote.turnaround}` : ""}`
            : "- 报价：未记录";
          const failureLine = record.outcome.failureReason
            ? `- 失败原因：${record.outcome.failureReason}`
            : "- 失败原因：未记录";
          const evidenceLines = record.evidence.length
            ? record.evidence.map((item) => `  - [${item.kind}] ${item.path}${item.note ? `｜${item.note}` : ""}`).join("\n")
            : "  - 无";

          return [
            `## ${ledger.records.length - index}. ${record.counterpart}｜${record.channel}｜${record.stage}`,
            `- ID：${record.id}`,
            `- 创建：${record.createdAt}`,
            `- 更新：${record.updatedAt}`,
            `- 需求：${record.demandSummary}`,
            quoteLine,
            `- 结果：${record.outcome.status}`,
            failureLine,
            record.outcome.nextAction ? `- 下一步：${record.outcome.nextAction}` : "- 下一步：未记录",
            record.tags.length ? `- 标签：${record.tags.join(" / ")}` : "- 标签：无",
            "- 证据：",
            evidenceLines,
            ""
          ].join("\n");
        })
        .join("\n")
    : "## 暂无记录\n- 先用模板补第一条真实外部尝试。\n";

  return `${header}${body}`;
}

function renderTemplate(): string {
  return [
    "# 外部尝试记录模板",
    "",
    "每次尝试复制一份，补齐后再同步进 `data/attempt-ledger/attempt-ledger.json`。",
    "",
    "- 时间：",
    "- 渠道：",
    "- 对象：",
    "- 需求一句话：",
    "- 当前阶段：attempted / quoted / accepted / failed / delivered",
    "- 报价金额：",
    "- 报价范围：",
    "- 周期：",
    "- 当前结果：pending / won / lost",
    "- 失败原因：",
    "- 下一步：",
    "- 证据路径1：",
    "- 证据路径2：",
    "- 标签：",
    ""
  ].join("\n");
}

async function seedIfEmpty(ledger: Ledger): Promise<Ledger> {
  if (ledger.records.length > 0) return ledger;

  ledger.records.push({
    id: newId(),
    createdAt: nowHuman(),
    updatedAt: nowHuman(),
    targetAmount: 10000,
    channel: "待补",
    counterpart: "待补真实对象",
    demandSummary: "把下一次真实外部尝试填进来，禁止空口进展。",
    stage: "attempted",
    outcome: {
      status: "pending",
      nextAction: "用真实渠道、对象、需求、证据替换本条占位记录。"
    },
    evidence: [],
    tags: ["占位", "待补证"]
  });

  return ledger;
}

async function main(): Promise<void> {
  await ensureDir();
  const ledger = await seedIfEmpty(await loadLedger());
  ledger.updatedAt = nowHuman();

  await writeFile(JSON_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await writeFile(MD_PATH, `${renderMarkdown(ledger)}\n`, "utf8");
  await writeFile(TEMPLATE_PATH, `${renderTemplate()}\n`, "utf8");

  process.stdout.write(`${JSON_PATH}\n${MD_PATH}\n${TEMPLATE_PATH}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
