import { SAFE_COMMAND_WHITELIST } from "../config/config.js";
import type { ToolCall } from "./types.js";

export function splitTopLevelCommands(command: string): string[] {
  const subs: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "||" || two === "&&") {
      subs.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      subs.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  subs.push(current);
  return subs.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function isCommandWhitelisted(command: string, whitelist: string[]): boolean {
  const subCommands = splitTopLevelCommands(command);
  if (subCommands.length === 0) return false;
  return subCommands.every((sub) => {
    const main = sub.split(/\s+/)[0];
    const base = main.split("/").pop()?.split("\\").pop() ?? main;
    return whitelist.includes(base);
  });
}

export class HighRiskGuard {
  constructor(private readonly whitelist: string[] = SAFE_COMMAND_WHITELIST) {}

  private static readonly DANGEROUS_PATTERNS: readonly RegExp[] = [
    /(^|\s)(sudo|su)\b/i,
    /(^|\s)rm\b/i,
    /(^|\s)(chmod|chown|takeown|icacls)\b/i,
    /git\s+push\s+.*--force/i,
    /(^|\s)find\b.*(-delete|-exec)\b/i,
    /(^|\s)(mkfs|dd|diskpart|format)\b/i,
    /\\\\\.\\/i,
  ];

  isHighRisk(tc: ToolCall): boolean {
    if (tc.name === "delete_file" || tc.name === "focus_native_app") {
      return true;
    }
    if (tc.name !== "run_command") {
      return false;
    }
    const command = String(tc.arguments.command ?? "");
    if (!command.trim()) return true;
    if (HighRiskGuard.DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) {
      return true;
    }
    return !isCommandWhitelisted(command, this.whitelist);
  }
}
