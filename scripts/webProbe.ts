import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

type ProbeResult = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  title: string | null;
  keyword: string | null;
  keywordFound: boolean;
  error: string | null;
};

type FetchOutcome = {
  body: string;
  finalUrl: string;
  status: number;
};

type CliArgs = {
  url: string;
  keyword?: string;
  out?: string;
};

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15000;

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return decodeHtml(match[1].replace(/\s+/g, " ").trim()) || null;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function fetchText(urlText: string, redirectsLeft = MAX_REDIRECTS): Promise<FetchOutcome> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      url,
      {
        headers: {
          "user-agent": "wenlu-web-probe/1.0",
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        },
        timeout: DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (location && status >= 300 && status < 400) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("too many redirects"));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          fetchText(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ body, finalUrl: url.toString(), status });
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error(`timeout after ${DEFAULT_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export async function probeUrl(url: string, keyword?: string): Promise<ProbeResult> {
  try {
    const fetched = await fetchText(url);
    const title = extractTitle(fetched.body);
    const normalizedKeyword = keyword?.trim() ? keyword.trim() : null;
    const keywordFound = normalizedKeyword ? fetched.body.toLowerCase().includes(normalizedKeyword.toLowerCase()) : false;
    return {
      requestedUrl: url,
      finalUrl: fetched.finalUrl,
      status: fetched.status,
      title,
      keyword: normalizedKeyword,
      keywordFound,
      error: null,
    };
  } catch (error) {
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 0,
      title: null,
      keyword: keyword?.trim() || null,
      keywordFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  let keyword: string | undefined;
  let out: string | undefined;
  let url: string | undefined;

  while (args.length > 0) {
    const current = args.shift();
    if (!current) continue;
    if (current === "--keyword") {
      keyword = args.shift();
      continue;
    }
    if (current === "--out") {
      out = args.shift();
      continue;
    }
    if (!url) {
      url = current;
    }
  }

  if (!url) {
    throw new Error("usage: tsx scripts/webProbe.ts <url> [--keyword <text>] [--out <file>]");
  }

  return { url, keyword, out };
}

function writeResult(outPath: string, result: ProbeResult) {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function main() {
  const { url, keyword, out } = parseArgs(process.argv.slice(2));
  const result = await probeUrl(url, keyword);
  if (out) {
    writeResult(out, result);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.error) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
