#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APPLE_TIMEOUT_MS = 8000;
const MAX_BUFFER = 1024 * 1024;

function appleQuote(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function normalizeAppName(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function appNamesMatch(expected, actual) {
  const a = normalizeAppName(expected); const b = normalizeAppName(actual);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
async function runExec(file, args, timeout = APPLE_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(file, args, { timeout, maxBuffer: MAX_BUFFER, encoding: 'utf-8' });
  return stdout.trim();
}
async function runAppleScript(script) { return runExec('osascript', ['-e', script]); }
async function resolveBundleId(appName) {
  try { const raw = await runAppleScript(`id of application ${appleQuote(appName)}`); return raw.trim() || null; } catch { return null; }
}
function classifyBlocker(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/not authorized|授权|Automation|AppleEvent|1743/i.test(raw)) return 'automation-denied';
  if (/timed out|timeout/i.test(raw)) return 'activation-timeout';
  if (/can.?t get application|Application isn.?t running|not found|找不到/i.test(raw)) return 'app-not-found';
  if (/(-600|isn.?t running)/i.test(raw)) return 'app-not-running';
  return 'activation-failed';
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function listForegroundApps() {
  const script = `
tell application "System Events"
  get name of every process whose background only is false
end tell
`;
  try { const raw = await runAppleScript(script); return raw.split(/,\s*/).map((item) => item.trim()).filter(Boolean); } catch { return []; }
}
async function captureFrontAppSnapshot() {
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
    const [appName = '', pidRaw = '', windowTitle = ''] = raw.split(/\n/);
    return { appName: appName.trim(), bundleId: await resolveBundleId(appName.trim()), windowTitle: windowTitle.trim(), pid: Number.isFinite(Number(pidRaw.trim())) ? Number(pidRaw.trim()) : null, capturedAt: new Date().toISOString() };
  } catch { return null; }
}
async function activateApp(appName) { await runAppleScript(`tell application ${appleQuote(appName)} to activate`); }
async function ensureNativeAppPriority(requestedApp, focusEvidencePath) {
  const before = await captureFrontAppSnapshot();
  const runningApps = await listForegroundApps();
  const resolvedApp = runningApps.find((app) => appNamesMatch(requestedApp, app)) ?? requestedApp;
  let blocker = null; let activationAttempted = false;
  try { activationAttempted = true; await activateApp(resolvedApp); await sleep(400); } catch (error) { blocker = classifyBlocker(error); }
  const after = await captureFrontAppSnapshot();
  const ok = blocker === null && after !== null && appNamesMatch(resolvedApp, after.appName);
  const result = { ok, requestedApp, resolvedApp, activationAttempted, blocker: ok ? null : blocker ?? 'frontmost-mismatch', before, after, runningApps, capturedAt: new Date().toISOString() };
  if (focusEvidencePath) { await mkdir(dirname(focusEvidencePath), { recursive: true }); await writeFile(focusEvidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8'); }
  return result;
}
async function truthCapture(root, targetApp) {
  const scriptPath = resolve(root, 'native_app_probe/chess_truth_capture.sh');
  try {
    const { stdout } = await execFileAsync(scriptPath, [targetApp], { encoding: 'utf-8', timeout: 15000, maxBuffer: MAX_BUFFER });
    const jsonPath = stdout.trim().split(/\n/).filter(Boolean).at(-1) || '';
    if (!jsonPath) return { ok: false, blocker: 'truth-capture-empty', jsonPath: null, payload: null };
    const raw = await readFile(jsonPath, 'utf-8');
    return { ok: true, blocker: null, jsonPath, payload: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, blocker: /timed out/i.test(String(error)) ? 'truth-capture-timeout' : 'truth-capture-failed', jsonPath: null, payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const selfPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(selfPath), '..');
const appName = process.argv[2] || 'Finder';
const outDir = resolve(process.argv[3] || `${root}/native_app_probe/evidence`);
const mode = process.argv[4] || 'activate';
const stamp = new Date().toISOString().replace(/:/g, '-');
const evidencePath = resolve(outDir, `native_app_acceptance_${stamp}.json`);
const focusEvidencePath = evidencePath.replace(/\.json$/, '.focus.json');
await mkdir(outDir, { recursive: true });
const beforeTruth = await truthCapture(root, appName);
let action;
if (mode === 'activate') action = await ensureNativeAppPriority(appName, focusEvidencePath);
else if (mode === 'observe') { const snapshot = await captureFrontAppSnapshot(); action = { ok: !!snapshot, blocker: snapshot ? null : 'snapshot-failed', before: snapshot, after: snapshot, requestedApp: appName }; }
else action = { ok: false, blocker: `unknown-mode:${mode}`, before: null, after: null, requestedApp: appName };
const afterTruth = await truthCapture(root, appName);
const runningApps = await listForegroundApps();
const afterApp = action?.after?.appName || afterTruth?.payload?.frontApp || '';
const success = mode === 'activate' ? Boolean(action?.ok && afterTruth?.ok && afterTruth?.payload?.isTargetFront === true && appNamesMatch(appName, afterApp)) : Boolean(afterTruth?.ok && (afterTruth?.payload?.frontApp || '').length > 0);
const result = {
  ok: success,
  requestedApp: appName,
  mode,
  blocker: success ? null : (action?.blocker || afterTruth?.blocker || 'front-app-mismatch'),
  checkSummary: {
    actionOk: Boolean(action?.ok), beforeTruthOk: Boolean(beforeTruth?.ok), afterTruthOk: Boolean(afterTruth?.ok), targetFrontAfter: Boolean(afterTruth?.payload?.isTargetFront), runningAppsSeen: runningApps.some((app) => appNamesMatch(appName, app)), frontAppAfter: afterTruth?.payload?.frontApp || action?.after?.appName || null,
  },
  evidence: { beforeTruth, action, afterTruth, runningApps },
  capturedAt: new Date().toISOString(),
};
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
