/**
 * 河床系统 · 双向回流临时权威层（Temporary Authority）
 * ------------------------------------------------------------------
 * 移植自产品后端 lib/wenlu/bidirectional-reflux/temporary-authority-actor.ts，
 * 剥掉 server-only。进程内 in-memory，60s TTL，**绝不持久化**（不写 mind.json 的
 * 节点 base authority）——这是"双向回流"的临时层：当下与某过去判断强共鸣时，
 * 临时拔高它的打断权威，让它在同一情境里更易再次浮现；60s 后自动消退，不污染长期权威。
 *
 * 全局联动（非孤岛）：打断引擎读节点权威时，先过这一层取 effectiveAuthority；
 * 打断/引领命中某节点时 applyDelta 临时加权。base authority 仍只由 reflux 长期校准。
 *
 * 纯进程内、确定性（时间可注入）；不调 LLM、不碰 DB、不写盘。
 */

const DEFAULT_TTL_MS = 60_000;

export interface TemporaryAuthorityEntry {
  readonly nodeId: string;
  readonly delta: number;
  readonly appliedAt: number;
  readonly ttlMs?: number;
}

interface InternalEntry {
  nodeId: string;
  delta: number;
  appliedAt: number;
  ttlMs: number;
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * 进程内临时权威层（单例由调用方持有）。同一 nodeId 多次 applyDelta 累加（对外 clamp[0,1]）。
 */
export class TemporaryAuthorityActor {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 写入一次临时 delta（in-memory，不持久化）。delta ∈ [-1,1]，ttl ∈ (0,60s]。 */
  applyDelta(entry: TemporaryAuthorityEntry): void {
    if (!entry.nodeId) return;
    if (!Number.isFinite(entry.delta) || Math.abs(entry.delta) > 1) return;
    const ttl = entry.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > DEFAULT_TTL_MS) return;
    const existing = this.entries.get(entry.nodeId);
    this.entries.set(entry.nodeId, {
      nodeId: entry.nodeId,
      delta: existing ? clamp(existing.delta + entry.delta, -1, 1) : entry.delta,
      appliedAt: entry.appliedAt,
      ttlMs: ttl,
    });
  }

  /** 读时叠加临时 delta + clamp[0,1] + 顺手 GC 过期项。过期/不存在 → 返回 base。 */
  computeEffectiveAuthority(nodeId: string, baseAuthority: number): number {
    if (!Number.isFinite(baseAuthority)) return 0;
    const entry = this.entries.get(nodeId);
    if (!entry) return clamp(baseAuthority, 0, 1);
    if (this.isExpired(entry)) {
      this.entries.delete(nodeId);
      return clamp(baseAuthority, 0, 1);
    }
    return clamp(baseAuthority + entry.delta, 0, 1);
  }

  /** 立即清理过期项，返回清理数量。 */
  runGcOnce(): number {
    let evicted = 0;
    for (const [id, e] of this.entries) {
      if (this.isExpired(e)) {
        this.entries.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  size(): number {
    return this.entries.size;
  }

  private isExpired(e: InternalEntry): boolean {
    return this.now() >= e.appliedAt + e.ttlMs;
  }
}
