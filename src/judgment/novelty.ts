/**
 * 新颖度引擎（纯函数核心）—— 让进化「停不下来」的饥饿感来源。
 *
 * ─── 第一性原理（联网核实：Lehman & Stanley, Novelty Search / 开放式进化）───
 * 只盯「目标分数」优化的系统必然收敛到局部最优的舒适区（问路反复确认 payment-config 即此病）。
 * 真正持续进化的系统，奖励的是**行为新颖度**——做没做过的事——而非「又把已知的事做对」。
 *
 * 本模块只承载**尺子**：给一个候选行为算它相对历史行为档案的「新颖度」（0-1），
 * 越是从没碰过的领域越高、越是重复旧行为越趋零。调用方据此翻转激励：
 *   - 重复行为 → 新颖度≈0 → 奖励趋零（舒适区饿死）
 *   - 全新行为 → 新颖度高 → 奖励暴涨（疯狂探索新疆域）
 *
 * 纯函数（无副作用、无 I/O、不依赖时钟），便于 property-based 测试证明尺子正确。
 */

/** 把文本规整为去重用的小写紧凑形式（与 riverMain 的 normalizeForDedup 行为对齐，但自洽）。 */
function normalize(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[，。、；：！？,.;:!?"'`（）()\[\]{}<>/\\|@#$%^&*~_=+-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 把文本切成 token 集合：中文逐字、英文/数字整词。 */
export function tokenSet(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const seg of normalize(text).split(" ")) {
    if (!seg) continue;
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (const ch of seg) tokens.add(ch);
    } else {
      tokens.add(seg);
    }
  }
  return tokens;
}

/** Jaccard 相似度（0-1）：两段文本 token 集合的交并比。 */
export function jaccard(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ───────────────────────────────────────────────────────────────────
// 语义层：锚点加权相似度（根治字面 Jaccard 高估重复的缺陷）
//
// 第一性：一件事的语义 = 它在对「什么东西」动手（payment-config / 8899 / tokio / 文件路径），
// 而非用什么措辞。重复任务反复戳同一批锚点；真新任务带来全新锚点。故按 token 的「语义锚强度」
// 加权：英文标识符/数字/路径=强锚，中文用二元组捕捉概念，泛化虚词near-零权。
// 无需任何远程 API（端点不可靠时也稳），纯确定性、可 property 测试。
// ───────────────────────────────────────────────────────────────────

/** 中文高频虚词/自指词（语义近零，避免"客观验证问路demo"这类口头禅撑高相似度的反面、或撑低的误差）。 */
const LOW_VALUE_CN = new Set([
  "的", "了", "在", "是", "和", "与", "对", "把", "被", "也", "都", "就", "仍", "还",
  "这", "那", "其", "之", "并", "且", "我", "你", "他", "它", "们",
]);

/**
 * 语义加权 token：返回 `Map<token, weight>`。
 *  - 英文/数字/标识符（长度≥2）：权重 3（最强锚——文件名、端口、技术名、域名）。
 *  - 含 `.`/`/` 的路径或域名片段：权重 3。
 *  - 中文：滑动二元组，权重 1（"默认/入口/失效/配置"这类概念单元）；落单的单字权重 0.5。
 *  - 中文虚词：权重 0.1（近零）。
 */
export function weightedTokens(text: string): Map<string, number> {
  const w = new Map<string, number>();
  const add = (tok: string, weight: number) => {
    if (!tok) return;
    w.set(tok, Math.max(w.get(tok) ?? 0, weight));
  };
  const norm = normalize(text);
  // 先抽英文/数字/标识符整词（normalize 已把分隔符变空格，但保留点与斜杠前已被替换；这里再抓 a-z0-9 串）
  // 强锚权重 4：技术对象（文件名/端口/技术名/域名）是「在对什么动手」的最强语义信号，
  // 共享全部强锚=极可能在戳同一个东西，应主导相似度判定。
  for (const m of norm.matchAll(/[a-z0-9]{2,}/g)) add(`en:${m[0]}`, 4);
  // 中文串 → 滑动二元组
  for (const seg of norm.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (seg.length === 1) {
      if (!LOW_VALUE_CN.has(seg)) add(`cn:${seg}`, 0.5);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      // 二元组任一字为虚词则降权
      const lv = LOW_VALUE_CN.has(seg[i]) || LOW_VALUE_CN.has(seg[i + 1]);
      add(`cn:${bg}`, lv ? 0.1 : 1);
    }
  }
  return w;
}

/**
 * 锚点加权「方向性覆盖」相似度（0-1）：候选的语义质量有多少已被某条历史行为覆盖。
 *
 * `sim = Σ(候选与entry共有token的权重) / Σ(候选全部token的权重)`。
 * 即「候选在说的东西，这条旧行为是不是大都已经覆盖了」。覆盖越全 → 越重复 → 相似度越高。
 * 方向性（分母只用候选）使「重复戳同一批锚点」被精准识别，而换措辞骗不过去。
 */
export function weightedSimilarity(candidate: string, entry: string): number {
  const wc = weightedTokens(candidate);
  if (wc.size === 0) return 0;
  const we = weightedTokens(entry);
  let total = 0;
  let shared = 0;
  for (const [tok, weight] of wc) {
    total += weight;
    if (we.has(tok)) shared += weight;
  }
  return total > 0 ? shared / total : 0;
}

/**
 * 一条历史行为指纹（档案条目）。
 *  - `desc`：行为的文本描述（任务 goal / 预测 claim / 能力名+用途 / 学到的知识等）。
 *  - `domain`：可选的领域标签（如 "web-learn" / "forge-capability"），用于跨领域新颖度加权。
 */
export interface BehaviorFingerprint {
  desc: string;
  domain?: string;
}

/**
 * 新颖度评分：候选行为相对历史档案的「行为距离」。
 *
 * 定义：`novelty = 1 - max(候选 与 档案中每一条的 Jaccard 相似度)`。
 * 即「与最像的那条旧行为，有多不像」。空档案 → 新颖度 1（第一次做任何事都新）。
 *
 * 这是 Novelty Search 的核心度量（k-近邻的 k=1 特例，对 demo 足够且确定性强、可测）。
 *
 * @param candidateDesc 候选行为描述。
 * @param archive 历史行为指纹档案。
 * @returns 新颖度 0-1，越高越新。
 */
export function noveltyScore(
  candidateDesc: string,
  archive: readonly BehaviorFingerprint[],
): number {
  if (!candidateDesc || candidateDesc.trim().length === 0) return 0;
  if (archive.length === 0) return 1;
  let maxSim = 0;
  for (const f of archive) {
    // 语义锚点加权覆盖相似度（根治字面 Jaccard 对换措辞的重复高估）。
    const sim = weightedSimilarity(candidateDesc, f.desc);
    if (sim > maxSim) maxSim = sim;
    if (maxSim >= 1) break;
  }
  return +(1 - maxSim).toFixed(4);
}

/** 新颖度闸门默认阈值：低于此视为「重复行为」，应被零分/驳回。 */
export const NOVELTY_REJECT_THRESHOLD = 0.25;

/**
 * 新颖度闸判定：候选行为是否「太重复」（应被驳回/零分）。
 *
 * @param candidateDesc 候选行为描述。
 * @param archive 历史档案。
 * @param threshold 阈值，默认 {@link NOVELTY_REJECT_THRESHOLD}。
 * @returns true=重复（新颖度 < 阈值，应驳回）。
 */
export function isRepetitive(
  candidateDesc: string,
  archive: readonly BehaviorFingerprint[],
  threshold = NOVELTY_REJECT_THRESHOLD,
): boolean {
  return noveltyScore(candidateDesc, archive) < threshold;
}

/**
 * 新颖度奖励系数（0-1.5）：把新颖度映射成奖励倍率，翻转激励。
 *
 * - 新颖度 < 阈值（重复）：系数趋 0（舒适区饿死）。
 * - 新颖度高：系数 > 1（探索新疆域暴爽，可超额奖励）。
 *
 * 设计为分段线性：阈值以下线性压到 0；阈值以上从 0.x 线性升到 1.5。
 * 使「重复=几乎零分、全新=超额加成」。
 *
 * @param novelty 新颖度 0-1。
 * @param threshold 重复阈值。
 * @returns 奖励系数 0-1.5。
 */
export function noveltyRewardFactor(
  novelty: number,
  threshold = NOVELTY_REJECT_THRESHOLD,
): number {
  const n = novelty < 0 ? 0 : novelty > 1 ? 1 : novelty;
  if (n < threshold) {
    // 重复区：线性压到接近 0。
    return +((n / threshold) * 0.2).toFixed(4);
  }
  // 新颖区：从 0.2 线性升到 1.5。
  const t = (n - threshold) / (1 - threshold);
  return +(0.2 + t * 1.3).toFixed(4);
}

/**
 * 能力阶梯门：新挑战的难度必须 ≥ 已达成最高难度 × ratio，逼它不断啃更硬的骨头。
 *
 * 让「疯狂」有向上的方向，而非乱发散原地打转。
 *
 * @param candidateDifficulty 候选任务难度（1-5）。
 * @param clearedDifficulties 已客观打穿的任务难度列表。
 * @param ratio 阶梯系数，默认 0.8（允许略低于峰值，但不能一直啃软的）。
 * @returns true=达到阶梯门（允许）；false=太简单（应驳回或不计入能力增长）。
 */
export function meetsDifficultyLadder(
  candidateDifficulty: number,
  clearedDifficulties: readonly number[],
  ratio = 0.8,
): boolean {
  if (clearedDifficulties.length === 0) return true; // 起步期不设门
  const peak = Math.max(...clearedDifficulties);
  return candidateDifficulty >= peak * ratio;
}
