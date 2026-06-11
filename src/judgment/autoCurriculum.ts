/**
 * 自动课程引擎（纯函数核心）—— 把三齿轮焊成自转飞轮的「总调度」。
 *
 * ─── 第一性原理（联网核实：Voyager 自动课程 / IMGEP / ZPD ProCuRL）───
 * Voyager 等终身学习体的核心是「自动课程」：系统据当前能力边界，自动生成下一个**刚好
 * 够得着**的挑战，让能力像滚雪球一样复合。本模块不重造度量，而是把前三阶段的产物
 * **综合成一个选题决策**：
 *  - 元认知（selfModel）：对各候选方向的（已偏差校正）胜任度 → 决定「够不够得着」。
 *  - 学习进度（learningProgress）：哪条线正在快速变强 → 决定「值不值得投」。
 *  - 能力星图（mapElites）：哪些格子还黑着 → 决定「该往哪扩版图」。
 *
 * 产物是一个 `CurriculumDirective`：下一步该攻哪个领域×难度、为什么、以及是否该跳新疆域。
 * 这是飞轮的闭环出口——把「知道自己几斤几两 + 知道往哪学最快 + 知道版图哪里黑」三者，
 * 收敛成一条可执行的选题指令，喂回 breathe 让它真的照着做。
 *
 * 纯函数（无副作用、无 I/O、不依赖时钟），便于 property 测试证明决策正确。
 */

import { learnabilityScore } from "./selfModel.js";

/** 一个候选挑战（来自能力星图的空格 + 该方向的胜任度/学习进度信号）。 */
export interface CurriculumCandidate {
  /** 领域轴。 */
  domain: string;
  /** 难度轴 1-5。 */
  difficulty: number;
  /** 对该方向（已偏差校正的）胜任度估计 0-1。 */
  competence: number;
  /** 该方向的学习进度 0-1（来自 learningProgress 引擎）。 */
  learningProgress: number;
  /** 该格是否为星图空格（true=从没点亮，扩版图价值高）。 */
  isEmptyCell: boolean;
}

/** 课程指令：飞轮给 breathe 的下一步选题。 */
export interface CurriculumDirective {
  /** 推荐攻击的领域。 */
  domain: string;
  /** 推荐难度。 */
  difficulty: number;
  /** 选题综合分（0-1，越高越该选）。 */
  score: number;
  /** 该方向是否填补星图空格。 */
  fillsEmptyCell: boolean;
  /** 人类可读的理由（喂回意识）。 */
  rationale: string;
}

/** 候选评分各分量权重。够得着(ZPD)是基础，学习进度是动力，填空格是探索红利。 */
export const CURRICULUM_WEIGHTS = {
  learnability: 0.4,
  learningProgress: 0.4,
  emptyCellBonus: 0.2,
} as const;

/**
 * 单个候选的课程价值分（0-1）：踮脚够得着 × 正在变强 × 填补版图空白。
 *
 * `score = w_l·learnability(competence) + w_p·learningProgress + w_e·(isEmptyCell?1:0)`。
 * ZPD 甜区(胜任度≈0.5) + 高学习进度 + 填空格 → 满分候选。
 *
 * @param c 候选挑战。
 * @returns 课程价值分 0-1。
 */
export function curriculumScore(c: CurriculumCandidate): number {
  const learn = learnabilityScore(clamp01(c.competence));
  const lp = clamp01(c.learningProgress);
  const empty = c.isEmptyCell ? 1 : 0;
  const s =
    CURRICULUM_WEIGHTS.learnability * learn +
    CURRICULUM_WEIGHTS.learningProgress * lp +
    CURRICULUM_WEIGHTS.emptyCellBonus * empty;
  return +clamp01(s).toFixed(4);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 自动课程选题：从候选挑战里挑课程价值最高的，产出可执行的课程指令。
 *
 * 这是飞轮的总调度出口。若所有候选价值都低迷（< stagnationFloor），判定当前能力边界
 * 已榨干，指令「跳新疆域」（选一个填空格、难度适中的方向强行探索）。
 *
 * @param candidates 候选挑战（通常来自星图空格 + 邻近已点亮格）。
 * @param stagnationFloor 停滞地板，最高分低于此 → 跳新疆域信号。默认 0.3。
 * @returns 课程指令；空候选返回 null。
 */
export function planNextChallenge(
  candidates: readonly CurriculumCandidate[],
  stagnationFloor = 0.3,
): CurriculumDirective | null {
  if (candidates.length === 0) return null;
  let best: { c: CurriculumCandidate; score: number } | null = null;
  for (const c of candidates) {
    const score = curriculumScore(c);
    if (best === null || score > best.score) best = { c, score };
  }
  const { c, score } = best!;
  const stagnant = score < stagnationFloor;

  let rationale: string;
  if (stagnant) {
    // 停滞：所有够得着的方向都没动力了 → 跳去填一个全新空格（强行开疆）。
    const newFrontier = pickExplorationFrontier(candidates) ?? c;
    return {
      domain: newFrontier.domain,
      difficulty: newFrontier.difficulty,
      score: +score.toFixed(4),
      fillsEmptyCell: newFrontier.isEmptyCell,
      rationale: `当前能力边界已榨干（最高课程分仅 ${(score * 100).toFixed(0)}%）——跳新疆域：开领域「${newFrontier.domain}」难度${newFrontier.difficulty}，强行扩张版图。`,
    };
  }
  rationale =
    `下一步攻：领域「${c.domain}」难度${c.difficulty}（课程分 ${(score * 100).toFixed(0)}%）。` +
    `理由：胜任度${Math.round(c.competence * 100)}%${nearSweetSpot(c.competence) ? "（踮脚够得着）" : ""}` +
    `、学习进度${Math.round(c.learningProgress * 100)}%` +
    (c.isEmptyCell ? "、且填补星图空白格" : "") + "。";
  return {
    domain: c.domain,
    difficulty: c.difficulty,
    score: +score.toFixed(4),
    fillsEmptyCell: c.isEmptyCell,
    rationale,
  };
}

/** 是否靠近 ZPD 甜区（胜任度 0.3-0.7）。 */
function nearSweetSpot(competence: number): boolean {
  const p = clamp01(competence);
  return p >= 0.3 && p <= 0.7;
}

/**
 * 挑探索前沿：停滞时强行开疆的方向——优先空格、难度适中（不一上来啃最硬的）。
 */
function pickExplorationFrontier(
  candidates: readonly CurriculumCandidate[],
): CurriculumCandidate | null {
  const empties = candidates.filter((c) => c.isEmptyCell);
  const pool = empties.length > 0 ? empties : candidates;
  if (pool.length === 0) return null;
  // 难度离 3 最近者优先（适中开疆，避免一步登天或原地踏步）。
  return [...pool].sort(
    (a, b) => Math.abs(a.difficulty - 3) - Math.abs(b.difficulty - 3),
  )[0];
}
