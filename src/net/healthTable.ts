/**
 * 出网健康表（Egress Health Table）· EWMA 自适应择优
 * ------------------------------------------------------------------
 * 第一性原理：检索源 / 出口的真实表现（成功率、延迟）会随网络环境漂移，
 * 写死优先级（如永远先打 Bing）必然次优——实测百度 88ms 远快于 Bing 516ms。
 * 故按真实结果用 EWMA（指数加权移动平均）持续学习每个源的成功率与延迟，
 * 据此动态重排候选顺序，做到"自主判断最优选"。
 *
 * 设计：
 *   - 每个 key（出口名 / 搜索源名）维护 {successRate, latencyMs, samples}。
 *   - record(key, ok, latencyMs)：用 EWMA 更新（新样本权重 alpha）。
 *   - rank(keys)：按综合分降序——成功率为主（权重高）、延迟为辅（越低越好）。
 *   - 无历史样本的源给"乐观初值"，保证新源有机会被尝试（探索 vs 利用）。
 *
 * 纯状态容器 + 纯计算，无网络 / 无时钟依赖（latency 由调用方测量后传入），便于单测。
 * 可序列化进 mind（snapshot/restore），让学习跨重启留存。
 */

/** 单个源的健康统计。 */
export interface SourceHealth {
  /** 成功率 EWMA ∈ [0,1]。 */
  successRate: number;
  /** 延迟 EWMA（毫秒）。 */
  latencyMs: number;
  /** 累计样本数（用于区分"乐观初值"与"已学习"）。 */
  samples: number;
  /** 最近一次更新的成功标志（诊断用）。 */
  lastOk: boolean;
}

/** EWMA 平滑系数：新样本占比。0.3 = 较快跟随近期变化又不剧烈抖动。 */
const ALPHA = 0.3;

/** 无样本时的乐观初值：高成功率 + 低延迟，保证新源会被优先探索一次。 */
const OPTIMISTIC: SourceHealth = {
  successRate: 0.9,
  latencyMs: 200,
  samples: 0,
  lastOk: true,
};

/** 综合分里延迟的归一化基准（毫秒）：超过此值延迟得分趋近 0。 */
const LATENCY_SCALE_MS = 3000;

/** 成功率与延迟在综合分中的权重（成功率为主）。 */
const W_SUCCESS = 0.75;
const W_LATENCY = 0.25;

export class EgressHealthTable {
  private table = new Map<string, SourceHealth>();

  /** 读取某源健康（无则返回乐观初值副本）。 */
  get(key: string): SourceHealth {
    return this.table.get(key) ?? { ...OPTIMISTIC };
  }

  /**
   * 记录一次出网结果，用 EWMA 更新该源的成功率与延迟。
   * @param key 源标识
   * @param ok 是否成功
   * @param latencyMs 本次耗时（毫秒）；失败时通常传超时值或实际耗时
   */
  record(key: string, ok: boolean, latencyMs: number): void {
    const prev = this.table.get(key);
    const okVal = ok ? 1 : 0;
    const safeLatency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : LATENCY_SCALE_MS;

    if (!prev) {
      // 首样本：直接采用（不与乐观初值混合，避免初值污染真实信号）。
      this.table.set(key, {
        successRate: okVal,
        latencyMs: safeLatency,
        samples: 1,
        lastOk: ok,
      });
      return;
    }

    this.table.set(key, {
      successRate: ALPHA * okVal + (1 - ALPHA) * prev.successRate,
      latencyMs: ALPHA * safeLatency + (1 - ALPHA) * prev.latencyMs,
      samples: prev.samples + 1,
      lastOk: ok,
    });
  }

  /**
   * 某源的综合分 ∈ [0,1]（越高越优）：成功率为主，延迟为辅。
   * 延迟分 = 1 - min(latency, SCALE)/SCALE（越低延迟分越高）。
   */
  score(key: string): number {
    const h = this.get(key);
    const latencyScore = 1 - Math.min(h.latencyMs, LATENCY_SCALE_MS) / LATENCY_SCALE_MS;
    return W_SUCCESS * h.successRate + W_LATENCY * latencyScore;
  }

  /**
   * 按综合分降序重排候选源（稳定排序：同分保持原相对顺序）。
   * 这是"自主判断最优选"的落点——调用方按返回顺序逐个尝试。
   * @param keys 候选源标识（保持调用方给定的兜底顺序作为同分 tie-break）
   * @returns 重排后的源标识数组
   */
  rank(keys: readonly string[]): string[] {
    return keys
      .map((key, idx) => ({ key, idx, score: this.score(key) }))
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
      .map((e) => e.key);
  }

  /** 导出可序列化快照（存进 mind，跨重启留存学习）。 */
  snapshot(): Record<string, SourceHealth> {
    return Object.fromEntries(this.table.entries());
  }

  /** 从快照恢复（loadMind 时调用）。容错非法输入。 */
  restore(snap: Record<string, SourceHealth> | undefined | null): void {
    if (!snap || typeof snap !== "object") return;
    for (const [key, h] of Object.entries(snap)) {
      if (
        h &&
        typeof h.successRate === "number" &&
        typeof h.latencyMs === "number" &&
        typeof h.samples === "number"
      ) {
        this.table.set(key, {
          successRate: h.successRate,
          latencyMs: h.latencyMs,
          samples: h.samples,
          lastOk: h.lastOk ?? true,
        });
      }
    }
  }
}
