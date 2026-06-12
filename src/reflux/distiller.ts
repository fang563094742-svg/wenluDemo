/**
 * 技能反哺（Skill Reflux）· Distiller（蒸馏，distiller.ts）
 * ------------------------------------------------------------------
 * 定位：`skill-flywheel` 一期蒸馏内核 `distillSkill` 的二期云反哺扩展（Req 4）。
 *
 * **复用一期蒸馏内核，不重写**：
 *  - 蒸馏内核统一复用 `skill-flywheel.distillSkill`（其已含三道闸：未验证拒绝、
 *    值/结构分离 `${var}` 占位、`scanResidualPrivacy` 去隐私），二期不另造蒸馏逻辑。
 *  - 轨迹输入复用 `execution-kernel.ExecutionStep`（与 `distillSkill` 的 `DistillInput.trace`
 *    同型），不另造轨迹类型。
 *
 * 在内核之上**扩展**（这是二期相对一期的增量）：
 *  - 批量化：`distillPendingBatch(B)` 拉一批 pending 信号，按 `task_id`/时间窗关联
 *    `trajectory_event` 整形为 `ExecutionStep[]` 作为 `DistillInput.trace`（Req 4.1/4.2）。
 *  - 缺轨迹保护：无可关联轨迹的信号**不蒸馏为可执行类**（Req 3.5/5.1）。
 *  - 二期语义补全：在 `distillSkill` 产出的 `SkillSpec` 之上补
 *    `kind`/`applicable_scenario`/`user_neutral`/`platform_variant`/来源信号类别与
 *    Source_Weight（Req 4.3–4.7、18.4、15.2）；User_Neutral 主闸内嵌于扩展判定（ADR-2）。
 *  - 脱敏内联：调用任务 4 的 `sanitizeCandidate`（复用 `scanResidualPrivacy`，Req 5）。
 *  - LLM 预算分配：蒸馏 ≤2 / 去重 ≤2 / 软评审 ≤1（取 `config.Pipeline_LLM_Budget`），
 *    超出蒸馏配额的信号保留 `pending`、留待下一批次（Req 20.3/20.2）。
 *
 * LLM 调用通过**依赖注入**（`DistillClassifier`）便于 mock：不硬编码任何 provider；
 * 未注入 LLM 时退化为确定性扩展（不烧 token、不计预算）。
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 3.5, 18.4, 15.2, 20.2, 20.3_
 */

import {
  distillSkill,
  newSkillId,
  type DistillInput,
  type SkillSpec,
  type SkillPlatform,
  type SkillTaxonomy,
} from "../skill-flywheel/index.js";
import type { ExecutionStep, ActionOutcome } from "../execution-kernel/index.js";
import { normalizePlatform, normalizeVariantOs } from "../db/platformNormalize.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import { sanitizeCandidate, type SanitizeAudit } from "./sanitizer.js";
import type {
  HarvestSignal,
  SkillCandidate,
  SkillKind,
  SignalRole,
  TrajectoryEvent,
  VariantOS,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// LLM 预算分配（Req 20.3）
// ─────────────────────────────────────────────────────────────────

/** 单条反哺管线的 LLM 预算按阶段分配结果。 */
export interface LlmBudgetAllocation {
  /** 蒸馏阶段（首轮 + 必要时一次重试）配额，上限 2。 */
  distill: number;
  /** 语义去重阶段配额，上限 2。 */
  dedup: number;
  /** 软技能评审阶段配额，上限 1。 */
  softReview: number;
}

/**
 * 把 `Pipeline_LLM_Budget` 按设计固定优先级切成各阶段配额：
 * 蒸馏 ≤2 → 去重 ≤2 → 软评审 ≤1（默认 total=5 → {2,2,1}）。
 * total 偏小时按此优先级依次截断，保证不超总预算（Req 20.3）。
 */
export function allocateLlmBudget(total: number): LlmBudgetAllocation {
  const t = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const distill = Math.min(2, t);
  const dedup = Math.min(2, Math.max(0, t - distill));
  const softReview = Math.min(1, Math.max(0, t - distill - dedup));
  return { distill, dedup, softReview };
}

// ─────────────────────────────────────────────────────────────────
// 二期扩展：LLM 分类器（依赖注入，便于 mock）
// ─────────────────────────────────────────────────────────────────

/** LLM 蒸馏扩展判定的输入。 */
export interface DistillClassifyInput {
  /** 任务目标（已由 distillSkill 在 SkillSpec.when.taskPattern 占位化）。 */
  goal: string;
  /** distillSkill 产出的结构化技能（已含值/结构分离 + 去隐私）。 */
  skill: SkillSpec;
  /** 来源信号角色。 */
  signalRole: SignalRole;
  /** 产生信号的工具名。 */
  sourceTool: string;
  /** 是否有可关联轨迹（无轨迹禁止判为 executable，Req 3.5）。 */
  hasTrajectory: boolean;
}

/**
 * LLM 蒸馏扩展输出 schema（对齐 design.md「二期扩展 LLM 输出 schema」）。
 * User_Neutral 主闸内嵌于此（不额外烧 token，ADR-2）。
 */
export interface DistillExtension {
  /** 技能类型（soft / executable）。 */
  kind: SkillKind;
  /** 适用场景（渐进加载摘要字段）。 */
  applicable_scenario?: string;
  /** 是否用户中立（Req 18.4：false=预设了用户个人特质，非中立）。 */
  user_neutral: boolean;
  /** 多维分类（缺省沿用 SkillSpec.taxonomy）。 */
  taxonomy?: SkillTaxonomy;
  /** 顶层平台契约（缺省沿用 SkillSpec.platform[0]）。 */
  platform?: SkillPlatform;
  /** 仅 executable：从轨迹提炼的当前平台实现变体（os∈mac/win/linux）。 */
  platform_variant?: { os: VariantOS; command: string };
}

/**
 * 蒸馏扩展分类器接口（依赖注入点）。
 * 生产环境可注入一个包裹 `src/llm` provider 的实现；单测注入 mock。
 */
export interface DistillClassifier {
  classify(input: DistillClassifyInput): Promise<DistillExtension>;
}

// ─────────────────────────────────────────────────────────────────
// 数据访问抽象（依赖注入，便于单测脱离真实 PG）
// ─────────────────────────────────────────────────────────────────

/**
 * 蒸馏所需的数据访问抽象。默认实现走真实 PG（见 `createPgDistillStore`）；
 * 单测注入内存实现。SQL 细节封装在 store 内，核心蒸馏/扩展逻辑保持可纯测。
 */
export interface DistillStore {
  /** 按 enqueued_at 升序拉取至多 limit 条 pending 信号。 */
  fetchPendingSignals(limit: number): Promise<HarvestSignal[]>;
  /**
   * 关联某信号的轨迹明细（Req 4.1/4.2）：
   *  - 有 task_id → 按 (contributor_id, task_id) 取该任务线轨迹；
   *  - 无 task_id → 按 contributor_id + enqueued_at 时间窗（windowMs）取主循环内轨迹。
   * 返回原始 TrajectoryEvent[]，整形为 ExecutionStep[] 由蒸馏器负责（保持可纯测）。
   */
  fetchTrajectory(signal: HarvestSignal, windowMs: number): Promise<TrajectoryEvent[]>;
  /** 更新信号队列状态（distilled / rejected）；保留 pending 的信号不调用本方法。 */
  markSignalStatus(signalId: string, status: "distilled" | "rejected"): Promise<void>;
  /** 持久化一条候选，返回其 id。 */
  insertCandidate(candidate: SkillCandidate): Promise<string>;
}

/** 蒸馏器依赖（全部可选，默认走真实 PG + 默认配置 + 确定性扩展）。 */
export interface DistillerDeps {
  /** 数据访问层；默认 `createPgDistillStore()`（真实 PG）。 */
  store?: DistillStore;
  /** LLM 扩展分类器；注入则受蒸馏预算约束，未注入则用确定性扩展（不计预算）。 */
  llm?: DistillClassifier;
  /** 反哺配置（取 Pipeline_LLM_Budget / B）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
  /**
   * 主循环内（无 task_id）轨迹关联时间窗（毫秒）；默认 10 分钟。
   * 任务线内（有 task_id）按 task_id 精确关联，不受此窗约束。
   */
  trajectoryWindowMs?: number;
}

// ─────────────────────────────────────────────────────────────────
// 蒸馏报告
// ─────────────────────────────────────────────────────────────────

/** 单条信号被拒绝的记录（distillSkill 三道闸或脱敏未过）。 */
export interface DistillRejection {
  signalId: string;
  reason: string;
}

/** `distillPendingBatch` 的批量蒸馏报告。 */
export interface DistillReport {
  /** 本批实际拉取的 pending 信号数。 */
  pulled: number;
  /** 成功蒸馏并持久化的候选（含已回填 id）。 */
  candidates: SkillCandidate[];
  /** 因无可关联轨迹而**未蒸馏为可执行类**的信号 id（Req 3.5/5.1，保留 pending）。 */
  skippedNoTrajectory: string[];
  /** 被三道闸/脱敏拒绝的信号（已标 rejected）。 */
  rejected: DistillRejection[];
  /** 因超出蒸馏 LLM 配额而保留 pending 的信号 id（Req 20.3，留待下一批次）。 */
  deferredBudget: string[];
  /** 本批实际消耗的蒸馏 LLM 调用次数。 */
  llmCallsUsed: number;
  /** 本批 LLM 预算分配。 */
  budget: LlmBudgetAllocation;
}

// ─────────────────────────────────────────────────────────────────
// 轨迹整形（TrajectoryEvent → ExecutionStep；纯函数，可纯测）
// ─────────────────────────────────────────────────────────────────

/** 结果摘要里出现失败语义的粗判模式（用于推断步骤 outcome）。 */
const FAILURE_HINT = /(fail|error|denied|refused|timeout|失败|错误|拒绝|超时)/i;

/** 从结果摘要粗推单步动作结果四态：无失败语义视为 achieved。 */
function inferOutcome(resultSummary?: string): ActionOutcome {
  if (resultSummary && FAILURE_HINT.test(resultSummary)) return "wrong_effect";
  return "achieved";
}

/**
 * 把一批轨迹明细整形为 `ExecutionStep[]`（与 distillSkill 的 DistillInput.trace 同型）。
 * 按时间正序排列（明细表读取通常为 ts DESC，这里翻正）。
 */
export function shapeTrajectory(events: TrajectoryEvent[]): ExecutionStep[] {
  const sorted = [...events].sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : 0;
    const tb = b.ts ? Date.parse(b.ts) : 0;
    if (ta !== tb) return ta - tb;
    return (Number(a.id ?? 0) || 0) - (Number(b.id ?? 0) || 0);
  });
  return sorted.map((ev) => {
    const action = [ev.action_name, ev.args_summary].filter(Boolean).join(" ").trim();
    return {
      intent: ev.task_id ? `task:${ev.task_id}` : ev.action_name,
      action: action || ev.action_name,
      diff: ev.result_summary ?? "",
      outcome: inferOutcome(ev.result_summary),
      createdAt: ev.ts ?? new Date().toISOString(),
    } satisfies ExecutionStep;
  });
}

// ─────────────────────────────────────────────────────────────────
// 辅助：目标提取 / 合成 soft SkillSpec / 确定性扩展 / 变体提炼
// ─────────────────────────────────────────────────────────────────

/** 从信号 payload 提取任务目标文本（goal/title/description 优先，回退工具名）。 */
function extractGoal(signal: HarvestSignal): string {
  const p = signal.payload ?? {};
  const cand = [p.goal, p.title, p.description, p.name].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return cand ?? signal.source_tool ?? "skill";
}

/**
 * 为「无 exec 轨迹的 soft 信号」合成最小 SkillSpec，供脱敏/扩展使用。
 * 不走 distillSkill 可执行内核（soft 无可执行体），但 when.taskPattern 仍受
 * scanResidualPrivacy 去隐私校验（脱敏阶段）约束。
 */
function synthSoftSkill(goal: string, platform: SkillPlatform, taxonomy: SkillTaxonomy): SkillSpec {
  return {
    id: newSkillId(),
    name: goal.slice(0, 60),
    when: { taskPattern: goal, preconditions: [] },
    exec: { vars: [], steps: [] },
    done: "目标达成",
    verify: { kind: "state-assert", spec: "" },
    platform: [platform],
    platformLocked: false,
    taxonomy,
    provenance: { createdAt: new Date().toISOString(), verifiedCount: 0, totalCount: 0 },
  };
}

/** 把 SkillSpec 的首个 exec 步骤还原为平台变体命令（op + 占位化 args）。 */
function deriveVariantCommand(skill: SkillSpec): string {
  const steps = skill.exec?.steps ?? [];
  if (steps.length === 0) return "";
  const first = steps[0];
  const args = Object.values(first.args ?? {}).join(" ");
  return [first.op, args].filter(Boolean).join(" ").trim();
}

/**
 * 未注入 LLM 时的确定性扩展（不烧 token、不计预算）：
 *  - kind：soft_seed → soft；其余在有轨迹时 executable、无轨迹时 soft；
 *  - user_neutral：保守判为 true（个人理解的剔除由 Sanitizer 负责）；
 *  - taxonomy/platform 沿用 SkillSpec；executable 提炼 platform_variant。
 */
function deterministicExtension(input: DistillClassifyInput): DistillExtension {
  const kind: SkillKind =
    input.signalRole === "soft_seed" ? "soft" : input.hasTrajectory ? "executable" : "soft";
  const platform = input.skill.platform?.[0] ?? "any";
  const variantOs = normalizeVariantOs(platform);
  const platform_variant =
    kind === "executable" && input.hasTrajectory && variantOs
      ? { os: variantOs as VariantOS, command: deriveVariantCommand(input.skill) }
      : undefined;
  return {
    kind,
    applicable_scenario: input.skill.when?.taskPattern || input.goal,
    user_neutral: true,
    taxonomy: input.skill.taxonomy,
    platform,
    platform_variant,
  };
}

// ─────────────────────────────────────────────────────────────────
// Distiller 工厂
// ─────────────────────────────────────────────────────────────────

/** 蒸馏器对外接口。 */
export interface Distiller {
  /** 批量蒸馏一批 pending 信号（limit 缺省取 config.B）。 */
  distillPendingBatch(limit?: number): Promise<DistillReport>;
}

/**
 * 创建蒸馏器实例。
 * @param deps 可选依赖；不传则走真实 PG + 默认配置 + 确定性扩展（无 LLM）。
 */
export function createDistiller(deps: DistillerDeps = {}): Distiller {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const store = deps.store ?? createPgDistillStore();
  const llm = deps.llm;
  const windowMs = deps.trajectoryWindowMs ?? DEFAULT_REFLUX_CONFIG.DISTILL_MAX_INTERVAL_ms;

  /** 调用扩展分类器：注入 LLM 则用之（计预算 + 失败重试一次），否则确定性扩展。 */
  async function classify(
    input: DistillClassifyInput,
    budget: { distillLeft: number },
  ): Promise<{ ext: DistillExtension; used: number }> {
    if (!llm) return { ext: deterministicExtension(input), used: 0 };
    let used = 0;
    let lastErr: unknown;
    // 蒸馏阶段配额：首轮 + 必要时一次重试（≤2），且不得超出剩余预算。
    const maxTries = Math.min(2, budget.distillLeft);
    for (let attempt = 0; attempt < maxTries; attempt++) {
      used++;
      try {
        const ext = await llm.classify(input);
        return { ext, used };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("LLM 蒸馏扩展无可用配额");
  }

  return {
    async distillPendingBatch(limit: number = config.B): Promise<DistillReport> {
      const budget = allocateLlmBudget(config.Pipeline_LLM_Budget);
      const signals = await store.fetchPendingSignals(Math.max(0, Math.floor(limit)));

      const report: DistillReport = {
        pulled: signals.length,
        candidates: [],
        skippedNoTrajectory: [],
        rejected: [],
        deferredBudget: [],
        llmCallsUsed: 0,
        budget,
      };

      // 蒸馏阶段 LLM 预算（跨本批共享）：耗尽后剩余「需 LLM」的信号保留 pending。
      let distillLeft = budget.distill;

      for (const signal of signals) {
        const signalId = signal.id ?? "";
        try {
          // 1) 关联轨迹并整形为 ExecutionStep[]（Req 4.1/4.2）。
          const events = await store.fetchTrajectory(signal, windowMs);
          const steps = shapeTrajectory(events);
          const hasTrajectory = steps.length > 0;

          // 2) 缺轨迹保护：可执行取向信号（非 soft_seed）无轨迹 → 不蒸馏为可执行类，
          //    保留 pending（Req 3.5/5.1），不计预算、不落候选。
          if (!hasTrajectory && signal.signal_role !== "soft_seed") {
            report.skippedNoTrajectory.push(signalId);
            continue;
          }

          // 3) 复用 distillSkill 内核得 SkillSpec（有轨迹）；soft 无轨迹时合成最小 spec。
          const goal = extractGoal(signal);
          const platform = normalizePlatform(
            typeof signal.payload?.platform === "string" ? signal.payload.platform : undefined,
          );
          const taxonomy: SkillTaxonomy = {
            taskType:
              typeof signal.payload?.taskType === "string"
                ? (signal.payload.taskType as string)
                : "generic",
            industry:
              typeof signal.payload?.industry === "string"
                ? (signal.payload.industry as string)
                : undefined,
            app:
              typeof signal.payload?.app === "string" ? (signal.payload.app as string) : undefined,
          };

          let skill: SkillSpec;
          if (hasTrajectory) {
            // 真值闸 / 可执行坯子的轨迹视为已客观验证（采集阶段只入队成功信号）。
            const verified = signal.signal_role !== "soft_seed";
            const input: DistillInput = {
              goal,
              trace: steps,
              verified,
              platform,
              taxonomy,
              verify: {
                kind: "state-assert",
                spec:
                  typeof signal.payload?.verifySpec === "string"
                    ? (signal.payload.verifySpec as string)
                    : "",
              },
            };
            const dr = distillSkill(input);
            if (!dr.ok) {
              // 三道闸（未验证 / 无有效步骤 / 去隐私未过）拒绝 → 标 rejected。
              await store.markSignalStatus(signalId, "rejected");
              report.rejected.push({ signalId, reason: dr.reason });
              continue;
            }
            skill = dr.skill;
          } else {
            skill = synthSoftSkill(goal, platform, taxonomy);
          }

          // 4) 预算闸：需 LLM 但蒸馏配额已耗尽 → 保留 pending、留待下一批次（Req 20.3）。
          if (llm && distillLeft <= 0) {
            report.deferredBudget.push(signalId);
            continue;
          }

          // 5) 二期扩展：kind/applicable_scenario/user_neutral/platform_variant（含 User_Neutral 主闸）。
          let ext: DistillExtension;
          try {
            const res = await classify(
              { goal, skill, signalRole: signal.signal_role, sourceTool: signal.source_tool, hasTrajectory },
              { distillLeft },
            );
            ext = res.ext;
            distillLeft -= res.used;
            report.llmCallsUsed += res.used;
          } catch (err) {
            // 扩展判定失败 → 该信号本批不蒸馏，保留 pending 留待下一批次。
            report.deferredBudget.push(signalId);
            continue;
          }

          // 缺轨迹仍不得判为可执行（即便 LLM 误判）（Req 3.5/5.1）。
          let kind: SkillKind = ext.kind;
          if (!hasTrajectory) kind = "soft";

          // 6) 组装草稿并内联脱敏（复用 scanResidualPrivacy，Req 5）。
          const draft: Record<string, unknown> = {
            title: skill.name,
            description: ext.applicable_scenario ?? goal,
            applicable_scenario: ext.applicable_scenario,
            kind,
            user_neutral: ext.user_neutral,
            exec: { vars: skill.exec.vars, steps: skill.exec.steps },
            taxonomy: ext.taxonomy ?? skill.taxonomy,
            platform: ext.platform ?? skill.platform[0],
            platform_variant: kind === "executable" ? ext.platform_variant : undefined,
            source_role: signal.signal_role,
            source_weight: signal.source_weight,
            source_tool: signal.source_tool,
          };

          const sanitized = sanitizeCandidate({ skill, draft });
          if (!sanitized.ok) {
            await store.markSignalStatus(signalId, "rejected");
            report.rejected.push({ signalId, reason: sanitized.reason });
            continue;
          }

          // 7) 落候选（status=seeded），回填脱敏审计。
          const audit: SanitizeAudit = sanitized.audit;
          const now = new Date().toISOString();
          const candidate: SkillCandidate = {
            id: "",
            kind,
            draft: { ...sanitized.draft, sanitized: true, removed_fields: audit.removed_fields },
            category:
              typeof (ext.taxonomy ?? skill.taxonomy).taskType === "string"
                ? (ext.taxonomy ?? skill.taxonomy).taskType
                : undefined,
            source_role: signal.signal_role,
            source_weight: signal.source_weight,
            user_neutral: ext.user_neutral,
            status: "seeded",
            contributor_id: signal.contributor_id,
            linked_prediction_id: signal.linked_prediction_id,
            linked_verifiable_id: signal.linked_verifiable_id,
            trajectory_ref: { task_id: signal.task_id, steps },
            contributor_reuse_success: 0,
            created_at: now,
            updated_at: now,
          };

          const id = await store.insertCandidate(candidate);
          candidate.id = id;
          await store.markSignalStatus(signalId, "distilled");
          report.candidates.push(candidate);
        } catch (err) {
          // 单条信号异常不影响整批（fail-open）：保留 pending，记为延后。
          report.deferredBudget.push(signalId);
        }
      }

      return report;
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 DistillStore。
 * - 队列/候选表（skill_harvest_queue / skill_candidate，006 迁移新增、无 RLS）走系统级 `query`；
 * - 轨迹明细（trajectory_event 受 RLS）走 `withUser(contributor_id)`，与 trajectoryBuffer 一致。
 */
export function createPgDistillStore(): DistillStore {
  // 动态依赖 pool，避免单测无 PG 环境时被牵连（单测注入内存 store，不触达此处）。
  return {
    async fetchPendingSignals(limit: number): Promise<HarvestSignal[]> {
      const { query } = await import("../db/pool.js");
      const res = await query<{
        id: string;
        signal_role: SignalRole;
        source_tool: string;
        source_weight: "user_task" | "autonomous";
        contributor_id: string;
        payload: Record<string, unknown>;
        linked_prediction_id: string | null;
        linked_verifiable_id: string | null;
        task_id: string | null;
        status: "pending" | "distilled" | "rejected";
        enqueued_at: Date | string;
      }>(
        `SELECT id, signal_role, source_tool, source_weight, contributor_id, payload,
                linked_prediction_id, linked_verifiable_id, task_id, status, enqueued_at
           FROM skill_harvest_queue
          WHERE status = 'pending'
          ORDER BY enqueued_at ASC
          LIMIT $1`,
        [Math.max(0, Math.floor(limit))],
      );
      return res.rows.map((r) => ({
        id: r.id,
        signal_role: r.signal_role,
        source_tool: r.source_tool,
        source_weight: r.source_weight,
        contributor_id: r.contributor_id,
        payload: r.payload ?? {},
        linked_prediction_id: r.linked_prediction_id ?? undefined,
        linked_verifiable_id: r.linked_verifiable_id ?? undefined,
        task_id: r.task_id ?? undefined,
        status: r.status,
        enqueued_at: r.enqueued_at instanceof Date ? r.enqueued_at.toISOString() : String(r.enqueued_at),
      }));
    },

    async fetchTrajectory(signal: HarvestSignal, windowMs: number): Promise<TrajectoryEvent[]> {
      const { withUser } = await import("../db/pool.js");
      return withUser(signal.contributor_id, async (client) => {
        if (signal.task_id) {
          // 任务线内：按 (user_id, task_id) 精确关联。
          const res = await client.query(
            `SELECT id, user_id, cycle, task_id, action_name, args_summary, result_summary, ts
               FROM trajectory_event
              WHERE user_id = $1 AND task_id = $2
              ORDER BY ts ASC, id ASC`,
            [signal.contributor_id, signal.task_id],
          );
          return res.rows.map(mapTrajectoryRow);
        }
        // 主循环内：按时间窗 [enqueued_at - windowMs, enqueued_at] 关联。
        const anchor = signal.enqueued_at ? Date.parse(signal.enqueued_at) : Date.now();
        const fromIso = new Date(anchor - Math.max(0, windowMs)).toISOString();
        const toIso = new Date(anchor).toISOString();
        const res = await client.query(
          `SELECT id, user_id, cycle, task_id, action_name, args_summary, result_summary, ts
             FROM trajectory_event
            WHERE user_id = $1 AND ts >= $2 AND ts <= $3
            ORDER BY ts ASC, id ASC`,
          [signal.contributor_id, fromIso, toIso],
        );
        return res.rows.map(mapTrajectoryRow);
      });
    },

    async markSignalStatus(signalId: string, status: "distilled" | "rejected"): Promise<void> {
      const { query } = await import("../db/pool.js");
      await query(`UPDATE skill_harvest_queue SET status = $2 WHERE id = $1`, [signalId, status]);
    },

    async insertCandidate(candidate: SkillCandidate): Promise<string> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ id: string }>(
        `INSERT INTO skill_candidate
           (kind, draft, category, source_role, source_weight, user_neutral, status,
            contributor_id, linked_prediction_id, linked_verifiable_id, trajectory_ref,
            contributor_reuse_success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          candidate.kind,
          JSON.stringify(candidate.draft),
          candidate.category ?? null,
          candidate.source_role,
          candidate.source_weight,
          candidate.user_neutral ?? null,
          candidate.status,
          candidate.contributor_id ?? null,
          candidate.linked_prediction_id ?? null,
          candidate.linked_verifiable_id ?? null,
          JSON.stringify(candidate.trajectory_ref ?? {}),
          candidate.contributor_reuse_success,
        ],
      );
      return res.rows[0]?.id ?? "";
    },
  };
}

interface TrajectoryRowLike {
  id: number | string;
  user_id: string;
  cycle: number | null;
  task_id: string | null;
  action_name: string;
  args_summary: string | null;
  result_summary: string | null;
  ts: Date | string;
  [key: string]: unknown;
}

function mapTrajectoryRow(row: TrajectoryRowLike): TrajectoryEvent {
  return {
    id: typeof row.id === "string" ? Number(row.id) : row.id,
    user_id: row.user_id,
    cycle: row.cycle ?? undefined,
    task_id: row.task_id ?? undefined,
    action_name: row.action_name,
    args_summary: row.args_summary ?? undefined,
    result_summary: row.result_summary ?? undefined,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
  };
}
