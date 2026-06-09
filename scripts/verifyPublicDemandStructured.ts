#!/usr/bin/env tsx
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const artifactsDir = resolve('artifacts');
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  const latest = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('public-demand-scan-'))
    .map((entry) => entry.name)
    .sort()
    .pop();

  if (!latest) {
    console.error('no public-demand-scan artifacts found');
    process.exit(1);
  }

  const scanPath = resolve(artifactsDir, latest, 'scan.json');
  const parsed = JSON.parse(await readFile(scanPath, 'utf8')) as {
    leads?: Array<{ url?: string; budget?: string; confidence?: number; requiredSkills?: string[] }>;
  };

  const ok = Array.isArray(parsed.leads)
    && parsed.leads.length > 0
    && parsed.leads.every((lead) =>
      typeof lead.url === 'string'
      && lead.url.startsWith('https://')
      && typeof lead.budget === 'string'
      && lead.budget.length > 0
      && typeof lead.confidence === 'number'
      && Array.isArray(lead.requiredSkills)
      && lead.requiredSkills.length > 0
    );

  if (!ok) {
    console.error(`structured verification failed: ${scanPath}`);
    process.exit(1);
  }

  console.log(scanPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
