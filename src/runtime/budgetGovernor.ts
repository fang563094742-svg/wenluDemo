/**
 * budgetGovernor.ts — 实时预算治理。
 *
 * 问题：agent 如果不限制资源消耗，会无限循环调远端 LLM、无限爬网页、
 * 做破坏性操作却不知道代价。这不是"智能"，这是失控。
 *
 * 设计：
 * 每种资源有独立的预算桶，每次消耗前先 acquire() 扣预算。
 * 超限时不崩溃，而是降级——可以选择切换到更便宜的策略。
 *
 * 资源维度：
 * 1. llm-tokens    — 远端 LLM 调用的 token 量
 * 2. network-calls — 外部网络请求次数
 * 3. disk-writes   — 文件写入次数
 * 4. cpu-time      — 长时间运算（编译/搜索等）
 * 5. destructive   — 破坏性操作（无上限，但每次都要确认）
 *
 * 策略：
 * - budget > 75%: 正常执行
 * - budget 50-75%: 警告 + 优先缓存
 * - budget 25-50%: 强制缓存 + 降级策略
 * - budget < 25%: 只允许最小必要操作 + 通知用户
 * - budget = 0%: 拒绝执行 + 通知用户
 */

// ═══════════════════════════════════════════════════════════════════════
// 资源维度
// ═══════════════════════════════════════════════════════════════════════

export type ResourceDimension =
  | "llm-tokens"
  | "network-calls"
  | "disk-writes"
  | "cpu-time-ms"
  | "destructive-ops"
  ;

export interface BudgetBucket {
  dimension: ResourceDimension;
  allocated: number;        // 总预算
  consumed: number;         // 已消耗
  reserved: number;         // 预留（给正在执行的操作）
  refillRate?: number;      // 每分钟回充量（0 = 不回充）
  lastRefill?: number;      // 上次回充时间戳
}

export interface BudgetConfig {
  buckets: Record<ResourceDimension, { allocated: number; refillRate?: number }>;
  degradationThresholds: {
    warn: number;     // 0.75
    degrade: number;  // 0.50
    restrict: number; // 0.25
    halt: number;     // 0.0
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Governor 状态
// ═══════════════════════════════════════════════════════════════════════

export type OperationalTier = "normal" | "warned" | "degraded" | "restricted" | "halted";

export interface GovernorSnapshot {
  tier: OperationalTier;
  buckets: BudgetBucket[];
  lowestBucketRatio: number;
  suggestions: DegradationSuggestion[];
}

export interface DegradationSuggestion {
  dimension: ResourceDimension;
  action: "use-cache" | "reduce-quality" | "skip-optional" | "batch-requests" | "notify-user";
  reason: string;
}

export interface AcquireRequest {
  dimension: ResourceDimension;
  amount: number;
  source: string;     // 哪个模块在请求
  priority: "critical" | "normal" | "optional";
}

export interface AcquireResult {
  granted: boolean;
  actualAmount: number;     // 可能部分授予
  tier: OperationalTier;
  suggestion?: DegradationSuggestion;
}

// ═══════════════════════════════════════════════════════════════════════
// Governor 接口
// ═══════════════════════════════════════════════════════════════════════

export interface BudgetGovernor {
  acquire(request: AcquireRequest): AcquireResult;
  release(dimension: ResourceDimension, amount: number): void;
  consume(dimension: ResourceDimension, amount: number): void;
  snapshot(): GovernorSnapshot;
  reset(dimension?: ResourceDimension): void;
  adjustBudget(dimension: ResourceDimension, newAllocated: number): void;
}

// ═══════════════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: BudgetConfig = {
  buckets: {
    "llm-tokens": { allocated: 100000, refillRate: 0 },        // 每次对话 10w token
    "network-calls": { allocated: 50, refillRate: 2 },          // 50次，每分钟回充 2
    "disk-writes": { allocated: 200, refillRate: 0 },           // 200次写操作
    "cpu-time-ms": { allocated: 300000, refillRate: 5000 },    // 5分钟 CPU，每分钟回充 5s
    "destructive-ops": { allocated: 5, refillRate: 0 },         // 破坏性操作最多 5 次
  },
  degradationThresholds: {
    warn: 0.75,
    degrade: 0.50,
    restrict: 0.25,
    halt: 0.0,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════════════════

export function createBudgetGovernor(config: Partial<BudgetConfig> = {}): BudgetGovernor {
  const cfg: BudgetConfig = {
    buckets: { ...DEFAULT_CONFIG.buckets, ...config.buckets },
    degradationThresholds: { ...DEFAULT_CONFIG.degradationThresholds, ...config.degradationThresholds },
  };

  // 初始化桶
  const buckets = new Map<ResourceDimension, BudgetBucket>();
  for (const [dim, spec] of Object.entries(cfg.buckets)) {
    buckets.set(dim as ResourceDimension, {
      dimension: dim as ResourceDimension,
      allocated: spec.allocated,
      consumed: 0,
      reserved: 0,
      refillRate: spec.refillRate,
      lastRefill: Date.now(),
    });
  }

  function refillBucket(bucket: BudgetBucket): void {
    if (!bucket.refillRate || !bucket.lastRefill) return;
    const elapsed = (Date.now() - bucket.lastRefill) / 60000; // 分钟
    const refill = Math.floor(elapsed * bucket.refillRate);
    if (refill > 0) {
      bucket.consumed = Math.max(0, bucket.consumed - refill);
      bucket.lastRefill = Date.now();
    }
  }

  function getBucketRatio(bucket: BudgetBucket): number {
    refillBucket(bucket);
    const used = bucket.consumed + bucket.reserved;
    return 1 - used / bucket.allocated;
  }

  function getTier(): OperationalTier {
    let lowest = 1;
    for (const bucket of buckets.values()) {
      const ratio = getBucketRatio(bucket);
      if (ratio < lowest) lowest = ratio;
    }

    if (lowest <= cfg.degradationThresholds.halt) return "halted";
    if (lowest <= cfg.degradationThresholds.restrict) return "restricted";
    if (lowest <= cfg.degradationThresholds.degrade) return "degraded";
    if (lowest <= cfg.degradationThresholds.warn) return "warned";
    return "normal";
  }

  function suggestDegradation(dimension: ResourceDimension): DegradationSuggestion | undefined {
    const bucket = buckets.get(dimension);
    if (!bucket) return undefined;
    const ratio = getBucketRatio(bucket);

    if (ratio > cfg.degradationThresholds.warn) return undefined;

    switch (dimension) {
      case "llm-tokens":
        return { dimension, action: "reduce-quality", reason: `Token budget at ${(ratio * 100).toFixed(0)}%, use shorter prompts or skip optional reasoning` };
      case "network-calls":
        return { dimension, action: "use-cache", reason: `Network budget at ${(ratio * 100).toFixed(0)}%, prefer cached results` };
      case "disk-writes":
        return { dimension, action: "batch-requests", reason: `Disk write budget at ${(ratio * 100).toFixed(0)}%, batch writes` };
      case "cpu-time-ms":
        return { dimension, action: "skip-optional", reason: `CPU budget at ${(ratio * 100).toFixed(0)}%, skip non-critical computation` };
      case "destructive-ops":
        return { dimension, action: "notify-user", reason: `Destructive op budget at ${(ratio * 100).toFixed(0)}%, ask user before proceeding` };
    }
  }

  function acquire(request: AcquireRequest): AcquireResult {
    const bucket = buckets.get(request.dimension);
    if (!bucket) {
      return { granted: true, actualAmount: request.amount, tier: getTier() };
    }

    refillBucket(bucket);
    const available = bucket.allocated - bucket.consumed - bucket.reserved;
    const tier = getTier();

    // halted：只有 critical 可以通过
    if (tier === "halted" && request.priority !== "critical") {
      return { granted: false, actualAmount: 0, tier, suggestion: suggestDegradation(request.dimension) };
    }

    // restricted：optional 不允许
    if (tier === "restricted" && request.priority === "optional") {
      return { granted: false, actualAmount: 0, tier, suggestion: suggestDegradation(request.dimension) };
    }

    // 预算不够
    if (available < request.amount) {
      if (request.priority === "critical") {
        // critical 可以超限，但记录
        bucket.reserved += request.amount;
        return { granted: true, actualAmount: request.amount, tier, suggestion: suggestDegradation(request.dimension) };
      }
      // 部分授予
      const partial = Math.max(0, available);
      if (partial > 0) {
        bucket.reserved += partial;
        return { granted: true, actualAmount: partial, tier, suggestion: suggestDegradation(request.dimension) };
      }
      return { granted: false, actualAmount: 0, tier, suggestion: suggestDegradation(request.dimension) };
    }

    // 正常授予
    bucket.reserved += request.amount;
    return { granted: true, actualAmount: request.amount, tier, suggestion: suggestDegradation(request.dimension) };
  }

  function release(dimension: ResourceDimension, amount: number): void {
    const bucket = buckets.get(dimension);
    if (bucket) {
      bucket.reserved = Math.max(0, bucket.reserved - amount);
    }
  }

  function consume(dimension: ResourceDimension, amount: number): void {
    const bucket = buckets.get(dimension);
    if (bucket) {
      bucket.reserved = Math.max(0, bucket.reserved - amount);
      bucket.consumed += amount;
    }
  }

  function snapshot(): GovernorSnapshot {
    const allBuckets = Array.from(buckets.values());
    let lowestRatio = 1;
    for (const b of allBuckets) {
      const r = getBucketRatio(b);
      if (r < lowestRatio) lowestRatio = r;
    }

    const suggestions: DegradationSuggestion[] = [];
    for (const b of allBuckets) {
      const s = suggestDegradation(b.dimension);
      if (s) suggestions.push(s);
    }

    return {
      tier: getTier(),
      buckets: allBuckets,
      lowestBucketRatio: lowestRatio,
      suggestions,
    };
  }

  function reset(dimension?: ResourceDimension): void {
    if (dimension) {
      const bucket = buckets.get(dimension);
      if (bucket) {
        bucket.consumed = 0;
        bucket.reserved = 0;
        bucket.lastRefill = Date.now();
      }
    } else {
      for (const bucket of buckets.values()) {
        bucket.consumed = 0;
        bucket.reserved = 0;
        bucket.lastRefill = Date.now();
      }
    }
  }

  function adjustBudget(dimension: ResourceDimension, newAllocated: number): void {
    const bucket = buckets.get(dimension);
    if (bucket) {
      bucket.allocated = newAllocated;
    }
  }

  return { acquire, release, consume, snapshot, reset, adjustBudget };
}
