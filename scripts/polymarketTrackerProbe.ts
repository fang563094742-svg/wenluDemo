#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Market = {
  question?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  slug?: string;
};

type ProbeResult = {
  ok: boolean;
  url: string;
  marketCount: number;
  activeCount: number;
  sampleQuestion: string | null;
  checkedAt: string;
};

const endpoint = process.env.POLYMARKET_GAMMA_URL ?? 'https://gamma-api.polymarket.com/markets';
const limit = Number.parseInt(process.env.POLYMARKET_LIMIT ?? '5', 10);
const url = new URL(endpoint);
if (!url.searchParams.has('limit')) {
  url.searchParams.set('limit', String(Number.isFinite(limit) && limit > 0 ? limit : 5));
}

async function fetchWithCurl(target: string): Promise<string> {
  const { stdout } = await execFileAsync('curl', [
    '--silent',
    '--show-error',
    '--fail',
    '--location',
    '--max-time',
    '20',
    '--header',
    'accept: application/json',
    '--header',
    'user-agent: wenlu-polymarket-tracker/0.1',
    target
  ]);
  return stdout;
}

async function main(): Promise<void> {
  const raw = await fetchWithCurl(url.toString());
  const payload = JSON.parse(raw) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected payload: expected JSON array');
  }

  const markets = payload as Market[];
  const activeCount = markets.filter((market) => market.active === true && market.closed !== true).length;
  const sampleQuestion = markets.find((market) => typeof market.question === 'string' && market.question.trim().length > 0)?.question?.trim() ?? null;

  const result: ProbeResult = {
    ok: true,
    url: url.toString(),
    marketCount: markets.length,
    activeCount,
    sampleQuestion,
    checkedAt: new Date().toISOString()
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, url: url.toString(), error: message }, null, 2));
  process.exit(1);
});
