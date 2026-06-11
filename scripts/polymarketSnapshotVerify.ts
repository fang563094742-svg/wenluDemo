#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';
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

const snapshotPath = process.env.POLYMARKET_SNAPSHOT_OUT ?? 'artifacts/polymarket/markets_snapshot.json';

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
    'user-agent: wenlu-polymarket-tracker-verify/0.2',
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
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot;
  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.entries)) {
    throw new Error('Snapshot file is invalid');
  }

  const raw = await fetchWithCurl(snapshot.source);
  const payload = JSON.parse(raw) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected payload: expected JSON array');
  }

  const remoteEntries = (payload as Market[]).map(normalizeMarket);
  const expectedEntries = JSON.stringify(remoteEntries);
  const actualEntries = JSON.stringify(snapshot.entries);

  if (snapshot.marketCount !== remoteEntries.length) {
    throw new Error(`Market count mismatch: snapshot=${snapshot.marketCount}, remote=${remoteEntries.length}`);
  }

  const remoteActiveCount = remoteEntries.filter((market) => market.active && !market.closed).length;
  if (snapshot.activeCount !== remoteActiveCount) {
    throw new Error(`Active count mismatch: snapshot=${snapshot.activeCount}, remote=${remoteActiveCount}`);
  }

  const remoteClosedCount = remoteEntries.filter((market) => market.closed).length;
  if (snapshot.closedCount !== remoteClosedCount) {
    throw new Error(`Closed count mismatch: snapshot=${snapshot.closedCount}, remote=${remoteClosedCount}`);
  }

  if (actualEntries !== expectedEntries) {
    throw new Error('Snapshot entries differ from live API response');
  }

  console.log(JSON.stringify({ ok: true, snapshotPath, source: snapshot.source, verifiedAt: new Date().toISOString() }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, snapshotPath, error: message }, null, 2));
  process.exit(1);
});
