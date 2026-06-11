import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_URL = 'https://jsonplaceholder.typicode.com/posts';
const OUTPUT_DIR = join(process.cwd(), 'artifacts', 'net-external-json-intel');
const OUTPUT_JSON = join(OUTPUT_DIR, 'top-posts.json');
const OUTPUT_MD = join(OUTPUT_DIR, 'summary.md');

type RemotePost = {
  userId: number;
  id: number;
  title: string;
  body: string;
};

type IntelCard = {
  id: number;
  url: string;
  title: string;
  titleWordCount: number;
  bodyPreview: string;
  bodyLength: number;
  riskTag: 'long-body' | 'short-body';
};

function toWordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'wenlu-net-intel/1.0' },
  });

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }

  const posts = (await response.json()) as RemotePost[];
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error('remote payload empty');
  }

  const topCards: IntelCard[] = posts.slice(0, 3).map((post) => ({
    id: post.id,
    url: `${SOURCE_URL}/${post.id}`,
    title: post.title,
    titleWordCount: toWordCount(post.title),
    bodyPreview: post.body.replace(/\s+/g, ' ').slice(0, 80),
    bodyLength: post.body.length,
    riskTag: post.body.length >= 150 ? 'long-body' : 'short-body',
  }));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    OUTPUT_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceUrl: SOURCE_URL,
        totalFetched: posts.length,
        topCards,
      },
      null,
      2,
    ),
  );

  const markdown = [
    '# net external json intel',
    '',
    `- sourceUrl: ${SOURCE_URL}`,
    `- generatedAt: ${new Date().toISOString()}`,
    `- totalFetched: ${posts.length}`,
    '',
    ...topCards.flatMap((card, index) => [
      `## top ${index + 1}`,
      `- id: ${card.id}`,
      `- url: ${card.url}`,
      `- titleWordCount: ${card.titleWordCount}`,
      `- bodyLength: ${card.bodyLength}`,
      `- riskTag: ${card.riskTag}`,
      `- bodyPreview: ${card.bodyPreview}`,
      '',
    ]),
  ].join('\n');

  writeFileSync(OUTPUT_MD, markdown);
  console.log(JSON.stringify({ outputJson: OUTPUT_JSON, outputMd: OUTPUT_MD, cards: topCards.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
