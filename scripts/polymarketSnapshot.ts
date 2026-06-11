#!/usr/bin/env tsx

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Market = {
  id?: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  slug?: string;
  liquidity?: number | string;
  volume?: number | string;
};

type SnapshotEntry = {
  id: string | null;
  question: string | null;
  slug: string | null;
  active: boolean;
  closed: boolean;
  endDate: string | null;
  liquidity: number | null;
  volume: number | null;
};

type Snapshot = {
  ok: true;
  source: string;
  limit: number;
  fetchedAt: string;
  marketCount: number;
  activeCount: number;
  closedCount: number;
  entries: SnapshotEntry[];
};

const endpoint = process.env.POLYMARKET_GAMMA_URL ?? 'https://gamma-api.polymarket.com/markets';
const limit = Number.parseInt(process.env.POLYMARKET_LIMIT ?? '5', 10);
const outputPath = resolve(process.env.POLYMARKET_SNAPSHOT_OUT ?? 'artifacts/polymarket/markets_snapshot.json');

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
    'user-agent: wenlu-polymarket-tracker/0.2',
    target
  ]);
  return stdout;
}

function toNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMarket(market: Market): SnapshotEntry {
  return {
    id: typeof market.id === 'string' ? market.id : null,
    question: typeof market.question === 'string' ? market.question.trim() || null : null,
    slug: typeof market.slug === 'string' ? market.slug : null,
    active: market.active === true,
    closed: market.closed === true,
    endDate: typeof market.endDate === 'string' ? market.endDate : null,
    liquidity: toNumber(market.liquidity),
    volume: toNumber(market.volume)
  };
}

async function main(): Promise<void> {
  const raw = await fetchWithCurl(url.toString());
  const payload = JSON.parse(raw) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected payload: expected JSON array');
  }

  const markets = payload as Market[];
  const entries = markets.map(normalizeMarket);
  const snapshot: Snapshot = {
    ok: true,
    source: url.toString(),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
    fetchedAt: new Date().toISOString(),
    marketCount: entries.length,
    activeCount: entries.filter((market) => market.active && !market.closed).length,
    closedCount: entries.filter((market) => market.closed).length,
    entries
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, outputPath, marketCount: snapshot.marketCount, source: snapshot.source }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, outputPath, source: url.toString(), error: message }, null, 2));
  process.exit(1);
});
