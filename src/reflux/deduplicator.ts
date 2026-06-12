/**
 * 技能反哺（Skill Reflux）· Deduplicator（去重 / 合并，deduplicator.ts）
 * ------------------------------------------------------------------
 * 定位：管线第 4 阶段（去重/合并），处在脱敏（任务 4）之后、验证（任务 8）之前。
 *
 * **复用 `tools/conflictDetector`，不另起一套查重逻辑**（Req 6 / Glossary）：
 *  - 命令级/语义级查重与 Promotion_Gate 的 `Conflict_Free` 判定统一复用既有
 *    `createConflictDetector` 的 `checkSemantics`（冲突键 `conflictKeys`、互斥资源
 *    `exclusiveResources`、双副作用 `bothHaveSideEffects` 判定）。
 *  - 把候选/技能的值/结构分离执行体（`exec.steps`，op + `${var}` 占位 args）映射为
 *    `ToolSemantics` 后交给 conflictDetector 判定是否"指向同一资源"，再结合归一化命令
 *    指纹得出 merge / new / suspect_duplicate 三态。
 *
 * 分类型查重（Req 6.4）：
 *  - 可执行类：命令级查重（归一化命令指纹 + conflictDetector 资源冲突判定）。
 *  - 软性类：语义查重——**先按 category/tags 缩小候选集（分桶），单次最多比对 K 个**
 *    （K 取 `config.Dedup_K`），避免与全库 O(n²) 两两比对（Req 20.5）；LLM 语义比对经
 *    依赖注入（`DedupSemanticJudge`）便于 mock，未注入时退化为确定性 tags/title 相似度。
 *
 * 合并策略（Req 6.5）：`computeMergeStrategy` 纯函数——(a) 主步骤取已验证次数更多者；
 *  (b) 差异步骤入 `alternative_steps`；(c) 保留最早创建时间与最新更新时间。
 *
 * 跨用户合并（Req 6.3/6.6）：经 `skillRepo.merge` 把贡献者写入 `skill_contributor`
 * （PK 去重、同一用户只计一次），刷新 `cross_user_breadth = count(distinct user)`。
 *
 * 疑似重复（Req 6.7/6.8）：相似度处于模糊区间 → 标 `suspect_duplicate`，保持冻结状态、
 * 不进验证 / 不晋升 / 不分发，留待后续周期凭更多使用证据重判。
 *
 * 三态返回（Req 6.1/6.2/6.7）：`merge | new | suspect_duplicate`。
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 20.5_
 */

import {
  createConflictDetector,
  type ConflictDetector,
} from "../tools/conflictDetector.js";
import { createSemanticRegistry } from "../tools/semanticRegistry.js";
import {
  TOOL_SEMANTICS,
  classifyShellCommand,
  type ToolSemantics,
  type Purity,
} from "../tools/toolSemantics.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { SkillRepo } from "./skillRepo.js";
import type { Skill, SkillCandidate, SkillExecStep } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// 对外结果 / 决策类型
// ─────────────────────────────────────────────────────────────────

/** 去重三态决策。 */
export type DedupDecision = "merge" | "new" | "suspect_duplicate";

/** `dedup` 的判定结果。 */
export interface DedupResult {
  /** 三态决策。 */
  decision: DedupDecision;
  /** 被判定的候选 id。 */
  candidateId: string;
  /** decision=merge 命中的目标技能 id。 */
  targetSkillId?: string;
  /** decision=merge 完成后经 `skillRepo.merge` 返回的目标技能（含刷新后的广度）。 */
  skill?: Skill;
  /** decision=merge 时计算出的合并策略（主步骤/差异步骤/时间）。 */
  mergeStrategy?: MergeStrategy;
  /** 本次实际比对的同桶技能数（断言分桶规避 O(n²)：≤ Dedup_K）。 */
  comparedCount: number;
  /** 判定原因摘要（便于审计/测试）。 */
  reason: string;
}

/** 合并策略产物（Req 6.5）。 */
export interface MergeStrategy {
  /** 主步骤：取已验证次数更多者的步骤定义。 */
  main_steps: SkillExecStep[];
  /** 差异步骤：另一侧不在主步骤中的步骤，作为备选保留。 */
  alternative_steps: SkillExecStep[];
  /** 保留最早创建时间。 */
  created_at: string;
  /** 保留最新更新时间。 */
  updated_at: string;
}

/** Conflict_Free 判定结果（供 Promotion_Gate / 任务 7 复用）。 */
export interface ConflictFreeResult {
  /** 是否无冲突（未与任何 active 技能重复或疑似重复）。 */
  conflictFree: boolean;
  /** 是否处于"无法判定"的模糊区间（命中疑似重复）。 */
  ambiguous: boolean;
  /** 命中的目标技能 id（重复/疑似重复时）。 */
  matchedSkillId?: string;
  /** 原因摘要。 */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入：语义比对（LLM）/ 数据访问 / 配置 / 冲突检测器
// ─────────────────────────────────────────────────────────────────

/** 软技能语义比对的轻量视图（喂给 LLM 判定，不含执行体）。 */
export interface SemanticView {
  title: string;
  description: string;
  category?: string;
  tags: string[];
}

/**
 * 软技能语义比对器（依赖注入点，便于 mock）。
 * 受 `Dedup_K` 约束：`dedup` 单次最多调用本接口比对 K 个候选（Req 20.5）。
 */
export interface DedupSemanticJudge {
  /** 比对两条软技能的语义关系。 */
  compare(
    a: SemanticView,
    b: SemanticView,
  ): Promise<{ relation: "duplicate" | "distinct" | "ambiguous" }>;
}

/**
 * 去重所需的数据访问抽象（默认走真实 PG；单测注入内存实现）。
 * `findBucket` 是分桶缩集入口：仅返回与候选 **同 kind** 且 **category 命中或 tags 重叠**
 * 的 active 公共技能，从源头规避全库 O(n²)（Req 20.5）。
 */
export interface DedupStore {
  /** 取候选完整记录（含 draft）；不存在返回 null。 */
  getCandidate(candidateId: string): Promise<SkillCandidate | null>;
  /** 分桶缩集：按 kind + category/tags 取 active 公共技能候选集。 */
  findBucket(input: BucketQuery): Promise<Skill[]>;
  /** 标记候选为 `suspect_duplicate`（冻结：不验证/不晋升/不分发）。 */
  markSuspectDuplicate(candidateId: string): Promise<void>;
}

/** 分桶查询条件。 */
export interface BucketQuery {
  kind: SkillCandidate["kind"];
  category?: string;
  tags: string[];
}

/** Deduplicator 依赖（repo 必填；其余可选，缺省走 PG + 默认配置 + 确定性比对）。 */
export interface DeduplicatorDeps {
  /** 技能数据访问层：复用 `merge`（写贡献者、刷新 cross_user_breadth）。 */
  repo: SkillRepo;
  /** 数据访问层；默认 `createPgDedupStore(repo)`（真实 PG）。 */
  store?: DedupStore;
  /** 软技能语义比对器；未注入则用确定性 tags/title 相似度（不烧 token）。 */
  judge?: DedupSemanticJudge;
  /** 反哺配置（取 Dedup_K）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
  /** 冲突检测器；默认基于空 SemanticRegistry 的 `createConflictDetector`。 */
  conflictDetector?: ConflictDetector;
}

// ─────────────────────────────────────────────────────────────────
// 相似度阈值（命令级 / 语义确定性回退用）
// ─────────────────────────────────────────────────────────────────

/** 命令级 token Jaccard：≥ 此值且非完全相同 → 模糊区间（疑似重复）。 */
const FUZZY_SIM = 0.6;
/** 软技能确定性回退：tags/title token Jaccard ≥ 此值视为重复。 */
const SOFT_DUP_SIM = 0.8;
/** 软技能确定性回退：≥ 此值且 < 重复阈值视为模糊（疑似重复）。 */
const SOFT_FUZZY_SIM = 0.5;

// ─────────────────────────────────────────────────────────────────
// 纯函数：指纹 / token / 语义派生 / 合并策略
// ─────────────────────────────────────────────────────────────────

/** 读取候选 draft 中的执行体步骤（值/结构分离，op + ${var} 占位 args）。 */
function candidateSteps(c: SkillCandidate): SkillExecStep[] {
  const exec = (c.draft?.exec ?? {}) as { steps?: SkillExecStep[] };
  return Array.isArray(exec.steps) ? exec.steps : [];
}

/** 读取候选 draft 中的 tags（无则回退 taxonomy 维度作为伪标签）。 */
function candidateTags(c: SkillCandidate): string[] {
  const d = c.draft ?? {};
  const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];
  if (tags.length > 0) return tags.map((t) => String(t));
  const tax = (d.taxonomy ?? {}) as { industry?: string; app?: string; taskType?: string };
  return [tax.industry, tax.app, tax.taskType].filter((x): x is string => !!x);
}

/** 候选语义视图（软技能比对用）。 */
function candidateView(c: SkillCandidate): SemanticView {
  const d = c.draft ?? {};
  return {
    title: typeof d.title === "string" ? d.title : "",
    description: typeof d.description === "string" ? d.description : "",
    category: c.category,
    tags: candidateTags(c),
  };
}

/** 技能语义视图。 */
function skillView(s: Skill): SemanticView {
  return { title: s.title, description: s.description, category: s.category, tags: s.tags };
}

/**
 * 归一化命令指纹（Req 6.4 可执行类命令级查重）：
 * 把每个步骤压成 `op(k=v,...)`，op/键/值统一小写去空白；args 值因值/结构分离已是
 * `${var}` 占位，故指纹与具体取值无关、只反映结构。
 */
export function commandFingerprint(steps: SkillExecStep[]): string {
  return steps
    .map((s) => {
      const op = String(s.op ?? "").trim().toLowerCase();
      const args = Object.keys(s.args ?? {})
        .sort()
        .map((k) => `${k.trim().toLowerCase()}=${String(s.args[k]).trim().toLowerCase()}`)
        .join(",");
      return args ? `${op}(${args})` : op;
    })
    .join(" | ");
}

/** 步骤 token 集合（op + arg 键），用于 Jaccard 相似度。 */
function stepTokenSet(steps: SkillExecStep[]): Set<string> {
  const set = new Set<string>();
  for (const s of steps) {
    const op = String(s.op ?? "").trim().toLowerCase();
    if (op) set.add(`op:${op}`);
    for (const k of Object.keys(s.args ?? {})) set.add(`arg:${k.trim().toLowerCase()}`);
  }
  return set;
}

/** 文本 token 集合（小写、去标点、按空白切分）。 */
function textTokenSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    for (const tok of String(t ?? "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/i)) {
      if (tok) set.add(tok);
    }
  }
  return set;
}

/** Jaccard 相似度：交集 / 并集（空集合定义为 0）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 把一条技能的执行体派生为 `ToolSemantics`（喂给 conflictDetector）。
 * 逐步映射 op：已知工具取 `TOOL_SEMANTICS`，否则按 shell 命令二次分类
 * （`classifyShellCommand`）；聚合 conflictKeys/exclusiveResources，purity 取最重。
 */
export function deriveToolSemantics(name: string, steps: SkillExecStep[]): ToolSemantics {
  const conflictKeys = new Set<string>();
  const exclusiveResources = new Set<string>();
  let purity: Purity = "pure-read";

  for (const step of steps) {
    const op = String(step.op ?? "").trim();
    const known = TOOL_SEMANTICS[op];
    if (known) {
      known.conflictKeys.forEach((k) => conflictKeys.add(k));
      known.exclusiveResources.forEach((r) => exclusiveResources.add(r));
      purity = mostSeverePurity(purity, known.purity);
      continue;
    }
    // 未知 op：当作 shell 命令做二次分类（命令文本 = op + args 值）。
    const cmd = [op, ...Object.values(step.args ?? {})].join(" ").trim();
    const shell = classifyShellCommand(cmd);
    purity = mostSeverePurity(purity, shell.purity);
    // 写类命令共享 "filesystem-write" 冲突键，使"同写同一资源"被判为冲突（指向同一资源）。
    if (shell.purity !== "pure-read") conflictKeys.add("filesystem-write");
    // 以 op 作为该步骤的逻辑资源键，便于"同 op 序列"指向同一资源。
    if (op) conflictKeys.add(`op:${op.toLowerCase()}`);
  }

  return {
    name,
    purity,
    rollbackable: false,
    idempotent: purity === "pure-read",
    determinism: "mostly-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: purity !== "pure-read",
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 1000,
    conflictKeys: [...conflictKeys],
    exclusiveResources: [...exclusiveResources],
    composableAfter: [],
    composableBefore: [],
    chainable: false,
  };
}

/** purity 严重度排序：pure-read < idempotent-write < non-idempotent-write < destructive。 */
function mostSeverePurity(a: Purity, b: Purity): Purity {
  const order: Purity[] = [
    "pure-read",
    "idempotent-write",
    "non-idempotent-write",
    "destructive",
  ];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * 计算合并策略（Req 6.5，纯函数）：
 *  (a) 主步骤 = 已验证次数更多者（target.verifiedCount vs candidate=0，并列取 target）；
 *  (b) 差异步骤 = 另一侧按指纹不在主步骤中的步骤，作为 alternative_steps；
 *  (c) created_at = 两者最早；updated_at = 两者最新。
 */
export function computeMergeStrategy(target: Skill, candidate: SkillCandidate): MergeStrategy {
  const targetSteps = target.exec_steps ?? [];
  const candSteps = candidateSteps(candidate);
  const targetVerified = target.provenance?.verifiedCount ?? 0;
  const candVerified = 0; // 候选尚未验证

  // 主步骤取验证多者；并列时取 target（已存在公共技能更稳定）。
  const targetIsMain = targetVerified >= candVerified;
  const main = targetIsMain ? targetSteps : candSteps;
  const other = targetIsMain ? candSteps : targetSteps;

  // 差异步骤：other 中单步指纹不在 main 单步指纹集合内者。
  const mainStepKeys = new Set(main.map((s) => commandFingerprint([s])));
  const alternative = other.filter((s) => !mainStepKeys.has(commandFingerprint([s])));

  const times = [target.created_at, target.updated_at, candidate.created_at, candidate.updated_at]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => ({ raw: t, ms: Date.parse(t) }))
    .filter((t) => Number.isFinite(t.ms));
  const created_at = times.length
    ? times.reduce((a, b) => (a.ms <= b.ms ? a : b)).raw
    : (target.created_at ?? candidate.created_at ?? new Date().toISOString());
  const updated_at = times.length
    ? times.reduce((a, b) => (a.ms >= b.ms ? a : b)).raw
    : (target.updated_at ?? candidate.updated_at ?? new Date().toISOString());

  return { main_steps: main, alternative_steps: alternative, created_at, updated_at };
}

// ─────────────────────────────────────────────────────────────────
// Deduplicator 工厂
// ─────────────────────────────────────────────────────────────────

/** 去重器对外接口。 */
export interface Deduplicator {
  /** 对一个候选执行查重/合并，返回三态决策（merge 时已落库刷新广度）。 */
  dedup(candidateId: string): Promise<DedupResult>;
  /**
   * Conflict_Free 判定（Promotion_Gate / 任务 7 复用）：候选是否未与任何 active
   * 技能重复或疑似重复。**只读、无副作用**（不改候选状态）。
   */
  isConflictFree(candidateId: string): Promise<ConflictFreeResult>;
}

/** 一次查重的内部判定（纯读，不落库）。 */
interface Evaluation {
  decision: DedupDecision;
  targetSkillId?: string;
  comparedCount: number;
  reason: string;
}

/**
 * 创建去重器实例。
 * @param deps 依赖（repo 必填）；不传 store/judge/config/conflictDetector 时走默认。
 */
export function createDeduplicator(deps: DeduplicatorDeps): Deduplicator {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const repo = deps.repo;
  const store = deps.store ?? createPgDedupStore(repo);
  const judge = deps.judge;
  const detector = deps.conflictDetector ?? createConflictDetector(createSemanticRegistry());

  /** 两条可执行技能是否"指向同一资源"（复用 conflictDetector：不可并行即冲突）。 */
  function sharesResource(candSteps: SkillExecStep[], skill: Skill): boolean {
    const a = deriveToolSemantics("__candidate__", candSteps);
    const b = deriveToolSemantics(`skill:${skill.id}`, skill.exec_steps ?? []);
    const res = detector.checkSemantics(a, b);
    return !res.canParallel; // 不可并行 = 冲突键/互斥资源/双副作用重叠 → 指向同一资源
  }

  /** 可执行类命令级查重（指纹 + conflictDetector 资源判定）。 */
  function evaluateExecutable(candidate: SkillCandidate, bucket: Skill[]): Evaluation {
    const candSteps = candidateSteps(candidate);
    const candFp = commandFingerprint(candSteps);
    const candTokens = stepTokenSet(candSteps);
    const k = Math.max(0, Math.floor(config.Dedup_K));
    const considered = bucket.slice(0, k); // 单次最多比对 K 个，规避 O(n²)
    let comparedCount = 0;
    let fuzzy: { id: string; reason: string } | undefined;

    for (const skill of considered) {
      comparedCount++;
      const skillFp = commandFingerprint(skill.exec_steps ?? []);
      const sameResource = sharesResource(candSteps, skill);
      if (candFp === skillFp && skillFp !== "") {
        if (sameResource) {
          return {
            decision: "merge",
            targetSkillId: skill.id,
            comparedCount,
            reason: `命令指纹一致且 conflictDetector 判定指向同一资源（skill=${skill.id}）`,
          };
        }
        // 指纹一致但 conflictDetector 判为可并行（不指向同一资源）→ 模糊。
        fuzzy = fuzzy ?? { id: skill.id, reason: `命令指纹一致但资源判定不一致（skill=${skill.id}）` };
        continue;
      }
      // 指纹不同：高 token 相似且指向同一资源 → 模糊区间（疑似重复）。
      const sim = jaccard(candTokens, stepTokenSet(skill.exec_steps ?? []));
      if (sim >= FUZZY_SIM && sameResource) {
        fuzzy = fuzzy ?? {
          id: skill.id,
          reason: `命令相似度 ${sim.toFixed(2)}≥${FUZZY_SIM} 且指向同一资源（skill=${skill.id}）`,
        };
      }
    }

    if (fuzzy) {
      return { decision: "suspect_duplicate", targetSkillId: fuzzy.id, comparedCount, reason: fuzzy.reason };
    }
    return { decision: "new", comparedCount, reason: "命令级查重无重复，作为新候选" };
  }

  /** 软性类语义查重（分桶缩集 + ≤K 次 LLM 比对；无 judge 时确定性回退）。 */
  async function evaluateSoft(candidate: SkillCandidate, bucket: Skill[]): Promise<Evaluation> {
    const k = Math.max(0, Math.floor(config.Dedup_K));
    const considered = bucket.slice(0, k); // 单次最多比对 K 个（Req 20.5）
    const candView = candidateView(candidate);
    let comparedCount = 0;
    let fuzzy: { id: string; reason: string } | undefined;

    for (const skill of considered) {
      comparedCount++;
      const sv = skillView(skill);
      if (judge) {
        const { relation } = await judge.compare(candView, sv);
        if (relation === "duplicate") {
          return {
            decision: "merge",
            targetSkillId: skill.id,
            comparedCount,
            reason: `LLM 语义比对判定重复（skill=${skill.id}）`,
          };
        }
        if (relation === "ambiguous") {
          fuzzy = fuzzy ?? { id: skill.id, reason: `LLM 语义比对判定模糊（skill=${skill.id}）` };
        }
        continue;
      }
      // 确定性回退：tags + title/description token Jaccard。
      const sim = jaccard(
        textTokenSet(candView.title, candView.description, ...candView.tags),
        textTokenSet(sv.title, sv.description, ...sv.tags),
      );
      if (sim >= SOFT_DUP_SIM) {
        return {
          decision: "merge",
          targetSkillId: skill.id,
          comparedCount,
          reason: `语义相似度 ${sim.toFixed(2)}≥${SOFT_DUP_SIM} 判定重复（skill=${skill.id}）`,
        };
      }
      if (sim >= SOFT_FUZZY_SIM) {
        fuzzy = fuzzy ?? {
          id: skill.id,
          reason: `语义相似度 ${sim.toFixed(2)} 处于模糊区间（skill=${skill.id}）`,
        };
      }
    }

    if (fuzzy) {
      return { decision: "suspect_duplicate", targetSkillId: fuzzy.id, comparedCount, reason: fuzzy.reason };
    }
    return { decision: "new", comparedCount, reason: "语义查重无重复，作为新候选" };
  }

  /** 纯读判定：缩集分桶 → 按 kind 走命令级/语义级查重。 */
  async function evaluate(candidate: SkillCandidate): Promise<Evaluation> {
    const bucket = await store.findBucket({
      kind: candidate.kind,
      category: candidate.category,
      tags: candidateTags(candidate),
    });
    if (bucket.length === 0) {
      return { decision: "new", comparedCount: 0, reason: "同桶无 active 技能，作为新候选" };
    }
    return candidate.kind === "executable"
      ? evaluateExecutable(candidate, bucket)
      : evaluateSoft(candidate, bucket);
  }

  return {
    async dedup(candidateId: string): Promise<DedupResult> {
      const candidate = await store.getCandidate(candidateId);
      if (!candidate) {
        throw new Error(`dedup 失败：候选不存在 candidateId=${candidateId}`);
      }
      const ev = await evaluate(candidate);

      if (ev.decision === "merge" && ev.targetSkillId) {
        // 计算合并策略（Req 6.5）；跨用户合并经 repo.merge 写贡献者、刷新广度（Req 6.3/6.6）。
        const target = await store.findBucket({
          kind: candidate.kind,
          category: candidate.category,
          tags: candidateTags(candidate),
        }).then((b) => b.find((s) => s.id === ev.targetSkillId));
        const mergeStrategy = target ? computeMergeStrategy(target, candidate) : undefined;
        const skill = await repo.merge(candidateId, ev.targetSkillId);
        return {
          decision: "merge",
          candidateId,
          targetSkillId: ev.targetSkillId,
          skill,
          mergeStrategy,
          comparedCount: ev.comparedCount,
          reason: ev.reason,
        };
      }

      if (ev.decision === "suspect_duplicate") {
        // 标记疑似重复：冻结状态、不验证/不晋升/不分发（Req 6.7/6.8）。
        await store.markSuspectDuplicate(candidateId);
        return {
          decision: "suspect_duplicate",
          candidateId,
          targetSkillId: ev.targetSkillId,
          comparedCount: ev.comparedCount,
          reason: ev.reason,
        };
      }

      return { decision: "new", candidateId, comparedCount: ev.comparedCount, reason: ev.reason };
    },

    async isConflictFree(candidateId: string): Promise<ConflictFreeResult> {
      const candidate = await store.getCandidate(candidateId);
      if (!candidate) {
        throw new Error(`isConflictFree 失败：候选不存在 candidateId=${candidateId}`);
      }
      const ev = await evaluate(candidate);
      if (ev.decision === "new") {
        return { conflictFree: true, ambiguous: false, reason: "未与任何 active 技能重复或疑似重复" };
      }
      // merge（与既有重复）或 suspect_duplicate（疑似重复未决）均非 Conflict_Free。
      return {
        conflictFree: false,
        ambiguous: ev.decision === "suspect_duplicate",
        matchedSkillId: ev.targetSkillId,
        reason: ev.reason,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 DedupStore。
 * - 候选读取复用 `SkillRepo.getCandidate`；
 * - 分桶缩集走系统级 `query`：同 kind、active，且（category 命中 或 tags 数组重叠）；
 * - 标记疑似重复走系统级 `query`（候选表无 RLS，006 迁移新增）。
 */
export function createPgDedupStore(repo: SkillRepo): DedupStore {
  return {
    async getCandidate(candidateId: string): Promise<SkillCandidate | null> {
      return repo.getCandidate(candidateId);
    },

    async findBucket(input: BucketQuery): Promise<Skill[]> {
      const { query } = await import("../db/pool.js");
      const conds: string[] = [`status = 'active'`, `kind = $1`];
      const params: unknown[] = [input.kind];
      const orParts: string[] = [];
      if (input.category) {
        params.push(input.category);
        orParts.push(`category = $${params.length}`);
      }
      if (input.tags.length > 0) {
        params.push(input.tags);
        orParts.push(`tags && $${params.length}`); // 数组重叠：命中任一标签
      }
      if (orParts.length > 0) conds.push(`(${orParts.join(" OR ")})`);
      const res = await query<{ id: string }>(
        `SELECT id FROM skill WHERE ${conds.join(" AND ")}
         ORDER BY success_rate DESC, use_count DESC, created_at DESC`,
        params,
      );
      // 经 repo.get 取完整技能（含变体/provenance/广度），保持映射一致。
      const skills: Skill[] = [];
      for (const row of res.rows) {
        const s = await repo.get(row.id);
        if (s) skills.push(s);
      }
      return skills;
    },

    async markSuspectDuplicate(candidateId: string): Promise<void> {
      const { query } = await import("../db/pool.js");
      await query(
        `UPDATE skill_candidate SET status = 'suspect_duplicate', updated_at = now() WHERE id = $1`,
        [candidateId],
      );
    },
  };
}
