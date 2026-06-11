/**
 * 判断力校准引擎（纯函数核心）。
 *
 * ─── 第一性原理 ───
 * 联网核实（arxiv 2511.23092 等）证明：当一个 LLM 的「自评分数」能决定它的指标/奖励时，
 * 会出现**分数通胀而准确率不升**——而且不是故意作弊，是结构性偏差。所以判断力能否真正
 * 提升，唯一决定因素是「结算权是否脱离它自己的控制」。本模块只承载**尺子**（如何把已被
 * 客观裁定的预测换算成判断力分数），裁判权（谁来判 hit/miss）由调用方用不可篡改的客观
 * 信号（verdictCmd 退出码）保证，绝不在本模块、也绝不交给被测对象自己。
 *
 * 两层分离：
 *  - 假设层（hypothesis）：自由、无限、零惩罚、**不计入判断力**。探索空间，不设笼子。
 *  - 判断层（grounded）：附客观裁判命令、由现实裁定过的预测，**才计入判断力**。
 *    因为只有过了现实这一关的才算「判断」，判断集的准确性由构造保证（而非概率运气）。
 *
 * 评分用严格适当评分规则（Brier score）：唯一能最大化期望分的策略是诚实报出真实概率，
 * 高估/低估/放水都被扣分。这是有数学证明的（见 property 测试）。
 *
 * 本模块是纯函数（无副作用、无 I/O、不依赖时钟），便于 property-based 测试证明尺子正确。
 */

/** 一条「已被客观裁定」的预测的最小信息（够算分即可）。 */
export interface GradedPrediction {
  /** 预测时报出的概率/信心，0-1。 */
  confidence: number;
  /** 客观裁定结果：true=命中(现实证实)，false=落空。 */
  hit: boolean;
}

/**
 * Brier 分数：单条预测的「概率预测 vs 现实」平方误差。
 *
 * `(p - o)²`，o∈{1 命中, 0 落空}。报 0.9 且命中→0.01（极小）；报 0.9 却落空→0.81（剧痛）。
 * 这就是「乱报高信心要付剧痛代价」的数学来源。返回 [0,1]，越小越好。
 *
 * @param confidence 报出的概率 0-1（越界自动夹紧）。
 * @param hit 客观裁定是否命中。
 */
export function brierScore(confidence: number, hit: boolean): number {
  const p = clamp01(confidence);
  const o = hit ? 1 : 0;
  return (p - o) * (p - o);
}

/** 把任意数夹到 [0,1]。 */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 平均 Brier 分数（对一组已客观裁定的预测）。空集返回 null（无样本不下结论）。
 */
export function meanBrier(graded: readonly GradedPrediction[]): number | null {
  if (graded.length === 0) return null;
  let sum = 0;
  for (const g of graded) sum += brierScore(g.confidence, g.hit);
  return sum / graded.length;
}

/**
 * 判断力分数（0-100），仅由**已被客观裁定**的预测算出。
 *
 * `(1 - 平均Brier) × 100`。诚实且准 → Brier→0 → 分数→100。
 * 注意：本函数**不接受**任何主观裁定的预测——调用方必须只传客观裁定过的，
 * 这是「判断极准」与「不被通胀」的根本保证。
 *
 * @param graded 已客观裁定的预测集合。
 * @param minSample 最小样本数，低于此返回 null（样本不足不下结论，不污染指标）。默认 3。
 * @returns 判断力分数 0-100；样本不足返回 null。
 */
export function judgmentScore(
  graded: readonly GradedPrediction[],
  minSample = 3,
): number | null {
  if (graded.length < minSample) return null;
  const mb = meanBrier(graded);
  if (mb === null) return null;
  return Math.round((1 - mb) * 100);
}

/** 校准表的一个信心区间桶。 */
export interface CalibrationBin {
  /** 区间下界（含），0/0.1/.../0.9。 */
  lo: number;
  /** 区间上界（不含，最后一桶含 1.0）。 */
  hi: number;
  /** 落入本桶的预测数。 */
  count: number;
  /** 本桶预测的平均报出信心。 */
  meanConfidence: number;
  /** 本桶预测的实际命中率（现实裁定）。 */
  actualHitRate: number;
  /** 偏差 = 实际命中率 − 平均信心（正=低估自己，负=高估自己），单位「比例」。 */
  bias: number;
}

/**
 * 校准表：把已客观裁定的预测按信心分 10 桶，算每桶「报出信心 vs 实际命中率」。
 *
 * 这是「判断力是不是幻觉」的硬镜子：理想校准下每桶 bias≈0（说 70% 的事真有 70% 命中）。
 * 只返回有样本的桶。
 */
export function calibrationTable(graded: readonly GradedPrediction[]): CalibrationBin[] {
  const buckets: GradedPrediction[][] = Array.from({ length: 10 }, () => []);
  for (const g of graded) {
    const p = clamp01(g.confidence);
    let idx = Math.floor(p * 10);
    if (idx > 9) idx = 9; // p===1 落入最后一桶
    buckets[idx].push(g);
  }
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < 10; i++) {
    const b = buckets[i];
    if (b.length === 0) continue;
    const meanConf = b.reduce((s, g) => s + clamp01(g.confidence), 0) / b.length;
    const hitRate = b.filter((g) => g.hit).length / b.length;
    const meanConfidence = +meanConf.toFixed(3);
    const actualHitRate = +hitRate.toFixed(3);
    bins.push({
      lo: i / 10,
      hi: i === 9 ? 1 : (i + 1) / 10,
      count: b.length,
      meanConfidence,
      actualHitRate,
      // bias 由已四舍五入的字段相减得出，保证与 actualHitRate/meanConfidence 内部一致。
      bias: +(actualHitRate - meanConfidence).toFixed(3),
    });
  }
  return bins;
}

/**
 * 找出「系统性高估」最严重的信心区间（实际命中率远低于报出信心）。
 *
 * 用于在每轮决策前给被测对象注入「实时校准镜」：你在 X% 区间历史高估 Y 点，下注请扣减。
 * 这让现实真的反过来改变它下一次怎么报信心（Tetlock superforecaster 式的自我校准更新）。
 *
 * @param graded 已客观裁定的预测集合。
 * @param minBinCount 桶内最小样本数，低于此不算（避免单条噪声误导）。默认 3。
 * @returns 最严重高估的桶（bias 最负）；无显著高估返回 null。
 */
export function worstOverconfidenceBin(
  graded: readonly GradedPrediction[],
  minBinCount = 3,
): CalibrationBin | null {
  const bins = calibrationTable(graded).filter((b) => b.count >= minBinCount);
  let worst: CalibrationBin | null = null;
  for (const b of bins) {
    if (b.bias < 0 && (worst === null || b.bias < worst.bias)) worst = b;
  }
  return worst;
}
