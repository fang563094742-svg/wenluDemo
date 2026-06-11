import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APPLE_TIMEOUT_MS = 8_000;
const MAX_BUFFER = 1024 * 1024;
const POST_ACTIVATION_DELAY_MS = 400;

export interface FrontAppSnapshot {
  appName: string;
  bundleId: string | null;
  windowTitle: string;
  pid: number | null;
  capturedAt: string;
}

export interface NativeAppFocusEvidence {
  ok: boolean;
  requestedApp: string;
  resolvedApp: string;
  activated: boolean;
  blocker: string | null;
  before: FrontAppSnapshot | null;
  after: FrontAppSnapshot | null;
  runningApps: string[];
  generatedAt: string;
}

function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function appNamesMatch(expected: string, actual: string): boolean {
  const a = normalizeAppName(expected);
  const b = normalizeAppName(actual);
  return a === b || a.includes(b) || b.includes(a);
}

async function runExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: APPLE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: "utf-8",
  });
  return stdout.trim();
}

async function runAppleScript(script: string): Promise<string> {
  return runExec("osascript", ["-e", script]);
}

async function resolveBundleId(appName: string): Promise<string | null> {
  try {
    const raw = await runAppleScript(`id of application ${appleQuote(appName)}`);
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function classifyBlocker(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/not authorized|授权|Automation|AppleEvent|1743/i.test(raw)) return "automation-denied";
  if (/timed out|timeout/i.test(raw)) return "activation-timeout";
  if (/can.?t get application|Application isn.?t running|not found|找不到/i.test(raw)) return "app-not-found";
  if (/(-600|isn.?t running)/i.test(raw)) return "app-not-running";
  return "activation-failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listForegroundApps(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const script = `
tell application "System Events"
  get name of every process whose background only is false
end tell
`;
  try {
    const raw = await runAppleScript(script);
    return raw
      .split(/,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function captureFrontAppSnapshot(): Promise<FrontAppSnapshot | null> {
  if (process.platform !== "darwin") return null;
  const script = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set appPid to unix id of frontApp
  set titleValue to ""
  try
    tell frontApp
      if (count of windows) > 0 then
        set titleValue to value of attribute "AXTitle" of front window
      end if
    end tell
  end try
  return appName & linefeed & (appPid as text) & linefeed & titleValue
end tell
`;
  try {
    const raw = await runAppleScript(script);
    const [appName = "", pidRaw = "", windowTitle = ""] = raw.split(/\n/);
    return {
      appName: appName.trim(),
      bundleId: await resolveBundleId(appName.trim()),
      windowTitle: windowTitle.trim(),
      pid: Number.isFinite(Number(pidRaw.trim())) ? Number(pidRaw.trim()) : null,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function activateApp(appName: string): Promise<void> {
  const script = `tell application ${appleQuote(appName)} to activate`;
  await runAppleScript(script);
}

async function writeEvidence(path: string, evidence: NativeAppFocusEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
}

export async function ensureNativeAppPriority(
  requestedApp: string,
  evidencePath: string,
): Promise<NativeAppFocusEvidence> {
  const before = await captureFrontAppSnapshot();
  const runningApps = await listForegroundApps();
  const resolvedApp =
    runningApps.find((app) => appNamesMatch(requestedApp, app)) ?? requestedApp;

  let blocker: string | null = null;
  let activated = false;

  try {
    await activateApp(resolvedApp);
    activated = true;
    await sleep(POST_ACTIVATION_DELAY_MS);
  } catch (error) {
    blocker = classifyBlocker(error);
  }

  const after = await captureFrontAppSnapshot();
  const ok = Boolean(
    activated &&
      after &&
      (appNamesMatch(requestedApp, after.appName) ||
        (after.bundleId && before?.bundleId !== after.bundleId)),
  );

  const evidence: NativeAppFocusEvidence = {
    ok,
    requestedApp,
    resolvedApp,
    activated,
    blocker: ok ? null : blocker ?? "front-app-mismatch",
    before,
    after,
    runningApps,
    generatedAt: new Date().toISOString(),
  };

  await writeEvidence(evidencePath, evidence);
  return evidence;
}
