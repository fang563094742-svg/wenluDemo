/**
 * MAP-Elites 能力星图（纯函数核心）—— 飞轮的「探索地图」。
 *
 * ─── 第一性原理（联网核实：Mouret & Clune 2015, MAP-Elites / Quality-Diversity）───
 * 一维新颖度只会「找新东西」；MAP-Elites 是它的完全体：把行为空间切成多维网格，
 * **每个格子(niche)只保留最强的那个解(elite)**。效果是它不再随便找新，而是**系统性照亮
 * 整个能力地图**——哪些格子空着(从没探索的能力组合)，它就被吸过去填。
 *
 * 关键特性（原论文证明）：保留各种「次优但不同」的解，反而能组合出单点优化永远到不了的
 * 高峰（踏脚石效应/stepping stones）。问路据此积累一张「能力星图」，越点越亮、永不收敛。
 *
 * 本 demo 的行为维度（behavioral descriptor）取两轴，足以照亮且确定性可测：
 *  - 领域轴 domain：能力属于哪个领域（web/file/process/gui/net/data/code/knowledge/other）。
 *  - 难度轴 difficulty：1-5。
 * 格子键 = `${domain}#${difficulty}`。每格只留 quality 最高的 elite。
 *
 * 纯函数（无副作用、无 I/O、不依赖时钟），便于 property 测试证明尺子正确。
 */

/** 行为描述子的领域轴枚举（覆盖 demo 的能力面）。 */
export const CAPABILITY_DOMAINS = [
  "web", "file", "process", "gui", "net", "data", "code", "knowledge", "other",
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

/** 难度轴范围。 */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;

/** 星图总格子数（领域 × 难度），用于覆盖率计算。 */
export const TOTAL_CELLS = CAPABILITY_DOMAINS.length * (MAX_DIFFICULTY - MIN_DIFFICULTY + 1);

/** 一个能力解（候选填入星图的 elite）。 */
export interface CapabilitySolution {
  /** 解标识（能力名/任务 id）。 */
  id: string;
  /** 能力描述（用于领域分类与展示）。 */
  desc: string;
  /** 领域轴。 */
  domain: CapabilityDomain;
  /** 难度轴 1-5。 */
  difficulty: number;
  /** 质量分（越高越强，如客观验证难度×新颖度）。同格只留最高质量者。 */
  quality: number;
}

/** 星图：格子键 → 该格当前 elite。 */
export type CapabilityMap = Map<string, CapabilitySolution>;

/** 计算格子键。难度自动夹到 [1,5]。 */
export function cellKey(domain: CapabilityDomain, difficulty: number): string {
  const d = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, Math.round(difficulty)));
  return `${domain}#${d}`;
}

/**
 * 从能力描述文本推断领域轴（关键词匹配，确定性）。无法判定归 "other"。
 */
export function classifyDomain(desc: string): CapabilityDomain {
  const t = (desc || "").toLowerCase();
  const has = (re: RegExp) => re.test(t);
  if (has(/http|url|web|爬|抓取|搜索|bing|baidu|browse|网页|联网|api/)) return "web";
  if (has(/file|文件|读写|目录|路径|read_file|write_file|json|csv|\.txt/)) return "file";
  if (has(/process|进程|命令|shell|exec|run_command|bash|kill|端口|port/)) return "process";
  if (has(/gui|osascript|chrome|app|应用|窗口|界面|点击|截图|ocr|屏幕/)) return "gui";
  if (has(/net|网络|socket|tcp|ping|dns|ssh|连接/)) return "net";
  if (has(/data|数据|数据库|sql|sqlite|统计|分析|表格/)) return "data";
  if (has(/code|代码|编译|build|test|git|脚本|函数|重构|tsc|npm/)) return "code";
  if (has(/知识|学习|概念|理解|belief|记忆|学会/)) return "knowledge";
  return "other";
}

/**
 * 尝试把一个候选解填入星图（MAP-Elites 的核心 update）。
 *
 * 规则：仅当该格为空、或候选 quality 严格高于现有 elite 时，才占据该格（精英替换）。
 * 不修改入参 map，返回 `{ map, placed, improved }`（不可变更新，便于测试）。
 *
 * @param map 现有星图。
 * @param sol 候选解。
 * @returns
 *   - `map`：更新后的新星图。
 *   - `placed`：是否占据了该格（空格首次填入 → true）。
 *   - `improved`：是否以更高质量替换了旧 elite。
 */
export function tryPlace(
  map: CapabilityMap,
  sol: CapabilitySolution,
): { map: CapabilityMap; placed: boolean; improved: boolean } {
  const key = cellKey(sol.domain, sol.difficulty);
  const next = new Map(map);
  const cur = next.get(key);
  if (cur === undefined) {
    next.set(key, sol);
    return { map: next, placed: true, improved: false };
  }
  if (sol.quality > cur.quality) {
    next.set(key, sol);
    return { map: next, placed: false, improved: true };
  }
  return { map: next, placed: false, improved: false };
}

/** 星图覆盖率（0-1）：已点亮格子数 / 总格子数。QD 的核心健康指标。 */
export function coverage(map: CapabilityMap): number {
  return +(map.size / TOTAL_CELLS).toFixed(4);
}

/** QD-score：所有 elite 质量之和。衡量「又广又强」（覆盖广 + 各格都强）。 */
export function qdScore(map: CapabilityMap): number {
  let sum = 0;
  for (const s of map.values()) sum += s.quality;
  return +sum.toFixed(4);
}

/**
 * 列出所有「空格子」（从没探索的能力组合）——这是飞轮最该被吸引去填的方向。
 *
 * @param map 现有星图。
 * @returns 空格子的 {domain, difficulty} 列表。
 */
export function emptyCells(map: CapabilityMap): Array<{ domain: CapabilityDomain; difficulty: number }> {
  const out: Array<{ domain: CapabilityDomain; difficulty: number }> = [];
  for (const domain of CAPABILITY_DOMAINS) {
    for (let d = MIN_DIFFICULTY; d <= MAX_DIFFICULTY; d++) {
      if (!map.has(cellKey(domain, d))) out.push({ domain, difficulty: d });
    }
  }
  return out;
}

/**
 * 推荐下一个该填的空格（自动课程的星图侧选题）：在空格里挑「难度最贴近当前能力边界」的。
 *
 * 策略：取已点亮格子的最高难度 peak，推荐空格中难度 = min(peak+1, 5) 的那批里领域最少被
 * 探索的——既往上啃(踮脚)，又往广里铺(填新领域)。空图时从难度1的新领域起步。
 *
 * @param map 现有星图。
 * @returns 推荐空格；无空格(星图全满)返回 null。
 */
export function recommendNextCell(
  map: CapabilityMap,
): { domain: CapabilityDomain; difficulty: number } | null {
  const empties = emptyCells(map);
  if (empties.length === 0) return null;
  // 当前已点亮的最高难度。
  let peak = 0;
  for (const s of map.values()) peak = Math.max(peak, s.difficulty);
  const targetDiff = map.size === 0 ? MIN_DIFFICULTY : Math.min(peak + 1, MAX_DIFFICULTY);
  // 统计各领域已点亮数，优先推未探索/最少探索的领域。
  const domainCount = new Map<CapabilityDomain, number>();
  for (const s of map.values()) domainCount.set(s.domain, (domainCount.get(s.domain) ?? 0) + 1);
  // 候选：难度==targetDiff 的空格；若没有，退而取任意空格。
  const atTarget = empties.filter((e) => e.difficulty === targetDiff);
  const pool = atTarget.length > 0 ? atTarget : empties;
  pool.sort((a, b) => (domainCount.get(a.domain) ?? 0) - (domainCount.get(b.domain) ?? 0));
  return pool[0];
}

/** 从一组能力解重建星图（每格留最高质量者）。用于从 mind 历史重算星图。 */
export function buildMap(solutions: readonly CapabilitySolution[]): CapabilityMap {
  let map: CapabilityMap = new Map();
  for (const s of solutions) map = tryPlace(map, s).map;
  return map;
}
