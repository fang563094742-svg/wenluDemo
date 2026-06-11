import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const DEFAULT_DEBUG_LOG_DIR = resolvePath(process.cwd(), ".codex-runtime", "debug-logs");

export function resolveDebugLogPath(fileName: string): string {
  const configured = process.env.WENLU_DEBUG_LOG_DIR?.trim();
  const logDir = configured ? resolvePath(configured) : DEFAULT_DEBUG_LOG_DIR;
  return resolvePath(logDir, fileName);
}

export function appendDebugLog(fileName: string, content: string): void {
  const logPath = resolveDebugLogPath(fileName);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, content, "utf-8");
  } catch {
    // Debug logging should never crash the app.
  }
}
