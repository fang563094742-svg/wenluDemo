/**
 * 持续执行内核 · 等待条件判定 + 超时（wait-eval.ts）
 * ------------------------------------------------------------------
 * 纯逻辑：给定 WakeCondition + 接线点注入的"真实探测结果"与当前时间，判定是否满足/超时。
 * 真实探测（fs.existsSync / TCP / fetch）由接线点做，库不绑定 IO，保独立性与可测性。
 * _Requirements: 2.2, 2.3, 2.5_
 */

import { type WakeCondition } from "./types.js";

/** 接线点注入的真实探测结果（库只做判定，不做 IO）。 */
export interface WakeProbeResult {
  /** file_appears / http_callback：目标是否就绪。 */
  ready?: boolean;
  /** window_state / opponent_moved：观测到的当前状态摘要，用于与 spec.expect 比对。 */
  observed?: string;
}

/** 是否满足唤醒条件。 */
export function isWakeSatisfied(wake: WakeCondition, probe: WakeProbeResult | undefined): boolean {
  if (!wake || !probe) return false;
  switch (wake.kind) {
    case "file_appears":
    case "http_callback":
    case "external_signal":
      return probe.ready === true;
    case "window_state":
    case "opponent_moved": {
      const expect = String((wake.spec as Record<string, unknown>)?.expect ?? "").trim();
      if (!expect) return probe.ready === true;
      return typeof probe.observed === "string" && probe.observed.includes(expect);
    }
    default:
      return probe.ready === true;
  }
}

/** 是否等待超时（startedAtMs + timeoutMs < now）。 */
export function isWaitTimeout(startedAtMs: number, timeoutMs: number, nowMs: number): boolean {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(timeoutMs)) return false;
  return nowMs - startedAtMs > Math.max(0, timeoutMs);
}

/** 规整超时上限（最多 10 分钟，缺省 5 分钟）。 */
export function clampWaitTimeout(timeoutMs: number | undefined): number {
  const v = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000;
  return Math.min(v, 600_000);
}
