/**
 * cachePolicy.ts — 基于 ToolSemantics 的缓存决策层。
 *
 * ToolSemantics 声明了 cacheability/freshnessTtlMs/determinism/sourceVolatility，
 * 但声明本身不做事。这个模块是运行时裁判——决定：
 * 1. 是否查缓存（cache-before-execute）
 * 2. 是否写缓存（cache-after-execute）
 * 3. TTL 动态调整（基于历史命中率 + 源波动性）
 *
 * 不自己做 I/O，只输出 CacheDecision。实际存取由上层（pipeline/executor）负责。
 */

import type { ToolSemantics, Determinism } from "./toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// Cache Key
// ═══════════════════════════════════════════════════════════════════════

export interface CacheKey {
  toolName: string;
  paramsHash: string;      // 参数的确定性哈希
  contextHash?: string;    // 上下文相关部分的哈希（如当前目录）
}

export interface CacheEntry {
  key: CacheKey;
  value: unknown;
  storedAt: number;       // timestamp ms
  expiresAt: number;
  hitCount: number;
  determinism: Determinism;
}

// ═══════════════════════════════════════════════════════════════════════
// Cache Decision
// ═══════════════════════════════════════════════════════════════════════

export interface CacheDecision {
  shouldCheckCache: boolean;
  shouldWriteCache: boolean;
  effectiveTtlMs: number;
  reason: string;
  confidence: number;     // 0-1，缓存结果的可信度
}

// ═══════════════════════════════════════════════════════════════════════
// 决策器
// ═══════════════════════════════════════════════════════════════════════

export interface CacheStats {
  totalQueries: number;
  hits: number;
  misses: number;
  staleHits: number;      // 命中了过期条目
}

export function decideCachePolicy(
  semantics: ToolSemantics,
  params: Record<string, unknown>,
  stats?: CacheStats,
): CacheDecision {
  // 1. 不可缓存的工具，直接跳过
  if (!semantics.cacheability || semantics.freshnessTtlMs === 0) {
    return {
      shouldCheckCache: false,
      shouldWriteCache: false,
      effectiveTtlMs: 0,
      reason: `${semantics.name} is not cacheable`,
      confidence: 0,
    };
  }

  // 2. 确定性工具 → 高置信度缓存
  if (semantics.determinism === "deterministic") {
    return {
      shouldCheckCache: true,
      shouldWriteCache: true,
      effectiveTtlMs: semantics.freshnessTtlMs,
      reason: "deterministic tool, full TTL",
      confidence: 1.0,
    };
  }

  // 3. mostly-deterministic → 正常缓存但带降级置信度
  if (semantics.determinism === "mostly-deterministic") {
    const adjustedTtl = adjustTtlByVolatility(semantics.freshnessTtlMs, semantics.sourceVolatility);
    return {
      shouldCheckCache: true,
      shouldWriteCache: true,
      effectiveTtlMs: adjustedTtl,
      reason: "mostly-deterministic, TTL adjusted by volatility",
      confidence: 0.8,
    };
  }

  // 4. non-deterministic → 有条件缓存
  if (semantics.determinism === "non-deterministic") {
    // 如果 sourceVolatility 是 real-time，直接不缓存
    if (semantics.sourceVolatility === "real-time") {
      return {
        shouldCheckCache: false,
        shouldWriteCache: false,
        effectiveTtlMs: 0,
        reason: "non-deterministic + real-time source, skip cache",
        confidence: 0,
      };
    }

    // 历史命中率高 → 值得缓存
    const hitRate = stats ? stats.hits / Math.max(stats.totalQueries, 1) : 0;
    const worthCaching = hitRate > 0.3 || !stats;  // 没有历史时给一次机会

    const adjustedTtl = adjustTtlByVolatility(semantics.freshnessTtlMs, semantics.sourceVolatility);

    return {
      shouldCheckCache: worthCaching,
      shouldWriteCache: worthCaching,
      effectiveTtlMs: adjustedTtl * 0.5,  // 非确定性工具 TTL 减半
      reason: worthCaching
        ? `non-deterministic but historically useful (hit rate: ${(hitRate * 100).toFixed(0)}%)`
        : `non-deterministic with low hit rate (${(hitRate * 100).toFixed(0)}%), skipping`,
      confidence: 0.5,
    };
  }

  // 兜底
  return {
    shouldCheckCache: false,
    shouldWriteCache: false,
    effectiveTtlMs: 0,
    reason: "unknown determinism level",
    confidence: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TTL 动态调整
// ═══════════════════════════════════════════════════════════════════════

function adjustTtlByVolatility(baseTtlMs: number, volatility: string): number {
  switch (volatility) {
    case "static":
      return baseTtlMs * 2;        // 静态源可以缓存更久
    case "slow-changing":
      return baseTtlMs;            // 正常
    case "fast-changing":
      return baseTtlMs * 0.5;     // 快变源减半
    case "real-time":
      return 0;                    // 实时不缓存
    default:
      return baseTtlMs;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Cache Key 生成
// ═══════════════════════════════════════════════════════════════════════

export function buildCacheKey(
  toolName: string,
  params: Record<string, unknown>,
  contextFactors?: Record<string, string>,
): CacheKey {
  // 对参数做稳定排序后序列化
  const sortedParams = JSON.stringify(params, Object.keys(params).sort());
  const paramsHash = simpleHash(sortedParams);

  let contextHash: string | undefined;
  if (contextFactors && Object.keys(contextFactors).length > 0) {
    const sortedCtx = JSON.stringify(contextFactors, Object.keys(contextFactors).sort());
    contextHash = simpleHash(sortedCtx);
  }

  return { toolName, paramsHash, contextHash };
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ═══════════════════════════════════════════════════════════════════════
// 内存缓存实现（简单 LRU）
// ═══════════════════════════════════════════════════════════════════════

export interface ToolCache {
  get(key: CacheKey): CacheEntry | null;
  set(key: CacheKey, value: unknown, ttlMs: number, determinism: Determinism): void;
  invalidate(toolName: string): void;
  invalidateByKey(key: CacheKey): void;
  stats(toolName?: string): CacheStats;
  size(): number;
  clear(): void;
}

export function createToolCache(maxEntries: number = 1000): ToolCache {
  const entries = new Map<string, CacheEntry>();
  const toolStats = new Map<string, CacheStats>();

  function keyStr(key: CacheKey): string {
    return `${key.toolName}:${key.paramsHash}:${key.contextHash || ""}`;
  }

  function getStats(toolName: string): CacheStats {
    if (!toolStats.has(toolName)) {
      toolStats.set(toolName, { totalQueries: 0, hits: 0, misses: 0, staleHits: 0 });
    }
    return toolStats.get(toolName)!;
  }

  function get(key: CacheKey): CacheEntry | null {
    const k = keyStr(key);
    const entry = entries.get(k);
    const s = getStats(key.toolName);
    s.totalQueries++;

    if (!entry) {
      s.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      s.staleHits++;
      entries.delete(k);
      return null;
    }

    s.hits++;
    entry.hitCount++;
    return entry;
  }

  function set(key: CacheKey, value: unknown, ttlMs: number, determinism: Determinism): void {
    const k = keyStr(key);

    // LRU 淘汰
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest) entries.delete(oldest);
    }

    entries.set(k, {
      key,
      value,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      hitCount: 0,
      determinism,
    });
  }

  function invalidate(toolName: string): void {
    for (const [k, entry] of entries) {
      if (entry.key.toolName === toolName) {
        entries.delete(k);
      }
    }
  }

  function invalidateByKey(key: CacheKey): void {
    entries.delete(keyStr(key));
  }

  function stats(toolName?: string): CacheStats {
    if (toolName) return getStats(toolName);
    const agg: CacheStats = { totalQueries: 0, hits: 0, misses: 0, staleHits: 0 };
    for (const s of toolStats.values()) {
      agg.totalQueries += s.totalQueries;
      agg.hits += s.hits;
      agg.misses += s.misses;
      agg.staleHits += s.staleHits;
    }
    return agg;
  }

  function size(): number {
    return entries.size;
  }

  function clear(): void {
    entries.clear();
    toolStats.clear();
  }

  return { get, set, invalidate, invalidateByKey, stats, size, clear };
}
