/**
 * 技能反哺（Skill Reflux）· Classifier（分类入库：状态机 + 双门，classifier.ts）
 * ------------------------------------------------------------------
 * 定位：管线第 5 阶段（分类入库），处在验证（任务 8）之后、分发（任务 12）之前。
 * 负责候选状态机推进（Req 9）与 Promotion_Gate 合取硬门判定（Req 16），治理上
 * **系统自动判定为主、人工兜底、人工优先**（Req 10）。
 *
 * 复用 / 整合既有内核（不另起一套）：
 *  - **物化**：晋升即经 `skillRepo.promote` 把候选物化为 active 公共技能（任务 3）；
 *    `enforce` 模式下再经注入的 `onPromoteToKb` 把技能喂给 `skill-kb.addSkill`，
 *    使其可被一期 `router.routeTask` 命中。
 *  - **Conflict_Free 判定**：复用 `deduplicator.isConflictFree`（任务 6，内部复用
 *    `tools/conflictDetector`），不另立冲突硬门。
 *  - **软性类评审**：复用 `verifier.reviewSoft`（任务 8，LLM 评审打分）。
 *  - **安全/合规裁决（enforce）**：整合 `sovereign/constitution.adjudicate`——其
 *    `confidence`/`intervention(contested)` 信号既作为晋升安全判定，又作为
 *    Human_Review_Escalation 的"系统判不准"信号（Req 10.5 / Req 16）。
 *
 * 状态机（Req 9）：
 * ```
 * seeded ──(forge 绑定预测)──► evidence_pending ──pred hit──► proven ──[Promotion_Gate]──► active
 *   │                                └──pred miss──► rejected             │
 *   ├─(master_tool/soft)──► seeded ─(真值闸点亮/反向点亮/复用≥N[+软性LLM评审])─► proven
 *   │                                                                     │
 *   │                            proven ──[Human_Review_Escalation: 判不准]──► pending_review
 *   │                                       └─ 人工 admin (POST /api/capabilities/review, 写 reviewed_by)
 *   │                                            ├─ approved ──► active (人工终态, 自动门不推翻)
 *   │                                            └─ rejected ──► rejected (人工终态, 自动门不推翻)
 *   └─(模糊重复)──► suspect_duplicate ──[升级]──► pending_review
 * ```
 *
 * 依赖注入：`skillRepo` / `deduplicator` / `verifier` / `constitution` / `store` 全部可注入，
 * 便于纯单元测试脱离真实 PG / 真实 LLM / 真实宪法权重。
 *
 * _Requirements: 9.1-9.11, 16.1-16.5, 10.1-10.8, 10.11, 2.9_
 */

import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { SkillRepo } from "./skillRepo.js";
import type { Deduplicator, ConflictFreeResult } from "./deduplicator.js";
import type { Verifier } from "./verifier.js";
import type {
  CandidateStatus,
  Skill,
  SkillCandidate,
  SkillSpec,
} from "./types.js";
import type { SourceSignal, Verdict } from "../sovereign/types.js";
import type { FlywheelMode } from "../skill-flywheel/index.js";

// ─────────────────────────────────────────────────────────────────
// 升级触发 / 闸门裁决类型
// ─────────────────────────────────────────────────────────────────

/**
 * 安全预审 / 脱敏的三态裁决：
 * - `pass`：明确通过；
 * - `fail`：明确失败（→ 自动拒绝，Req 10.3）；
 * - `boundary`：边界存疑（既非明确通过、也非明确失败 → 升级人工兜底，Req 10.5d）。
 */
export type GateOutcome = "pass" | "fail" | "boundary";

/** Human_Review_Escalation 的具体触发条件（Req 10.5）。 */
export type EscalationTrigger =
  | "constitution" // (a) constitution 低置信 / 矛盾未决
  | "suspect_duplicate" // (b) 疑似重复未决
  | "conflict_ambiguous" // (c) High_Score 但 Conflict 模糊
  | "safety_boundary"; // (d) 安全 / 脱敏边界存疑

/** `evaluate` 的判定结果取值。 */
export type ClassifyOutcome =
  | "promoted" // 自动门晋升为 active
  | "rejected" // 自动门拒绝（明确不满足准入）
  | "escalated" // 升级 pending_review，进既有人工队列
  | "pending" // proven 但双门未满足：不晋升也不拒绝，等待更多证据
  | "held" // autonomous 降权：不主动晋升（Req 9.8）
  | "human_approved" // 人工已决终态 approved（自动门不推翻，Req 10.7）
  | "human_rejected"; // 人工已决终态 rejected（自动门不推翻，Req 10.7）

/** `evaluate` 的完整判定结果。 */
export interface ClassifyDecision {
  outcome: ClassifyOutcome;
  candidateId: string;
  /** 物化得到的 active 公共技能（promoted / human_approved 时返回）。 */
  skill?: Skill;
  /** 命中的升级触发条件（escalated 时）。 */
  escalationTrigger?: EscalationTrigger;
  /** 人类可读判定原因（便于审计 / 测试）。 */
  reason: string;
}

/**
 * 晋升评估的外部上下文（由调用方提供，classifier 自身无法派生的判定输入）。
 */
export interface PromotionContext {
  /** 安全预审裁决（缺省 `pass`）。 */
  safety?: GateOutcome;
  /** 脱敏裁决（缺省 `pass`）。 */
  sanitize?: GateOutcome;
  /** 是否高分（success_rate ≥ High_Score），High_Score 分支用（缺省 false）。 */
  highScore?: boolean;
  /** 飞轮模式（observe/enforce，缺省 observe）。 */
  mode?: FlywheelMode;
  /**
   * enforce 模式下交给 `constitution.adjudicate` 的信号集；
   * 缺省 / 空数组则跳过宪法裁决（observe 模式不裁决）。
   */
  signals?: ReadonlyArray<SourceSignal>;
  /** 贡献者认知权威（0~1，缺省 0）。值越高阈值折扣越大（权威教师效应）。 */
  teacherAuthority?: number;
}

/** 候选状态转移结果（状态机推进类方法返回）。 */
export interface TransitionResult {
  candidateId: string;
  /** 转移后的候选状态。 */
  status: CandidateStatus;
  /** 本次调用是否真的改变了状态。 */
  changed: boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────
// 依赖注入：宪法裁决 / 数据访问
// ─────────────────────────────────────────────────────────────────

/** 宪法裁决器最小契约（`sovereign/constitution` 的 `Constitution` 实例结构上即满足）。 */
export interface ConstitutionAdjudicator {
  adjudicate(signals: ReadonlyArray<SourceSignal>): Verdict;
}

/** 人工审核终态裁决（经既有 `POST /api/capabilities/review` 写入，`reviewed_by` 非空）。 */
export interface HumanReviewVerdict {
  decision: "approved" | "rejected";
  /** 审核人标识（reviewed_by）。 */
  reviewed_by: string;
}

/**
 * Classifier 所需的数据访问抽象（候选状态机相关，skillRepo 未覆盖的部分）。
 * 默认实现走真实 PG（`createPgClassifierStore`）；单测注入内存实现
 * （`createInMemoryClassifierStore`）。
 */
export interface ClassifierStore {
  /** 取候选完整记录；不存在返回 null。 */
  getCandidate(candidateId: string): Promise<SkillCandidate | null>;
  /** 设候选状态。 */
  setCandidateStatus(candidateId: string, status: CandidateStatus): Promise<void>;
  /** 绑定 forge 自动预测 id（进入 evidence_pending 时）。 */
  bindPrediction(candidateId: string, predictionId: string): Promise<void>;
  /** 贡献方自身复用成功计数 +1，返回最新计数（Req 9.11）。 */
  incrementReuseSuccess(candidateId: string): Promise<number>;
  /** 按绑定预测 id 回查候选 id（settle_prediction 用）。 */
  findCandidateIdByPrediction(predictionId: string): Promise<string | null>;
  /**
   * 反向点亮（Req 9.10 / 2.9）：按 task_id 回查 `skill_invocation_event` 中
   * candidate_id 非空的记录，返回去重后的候选 id 列表。
   */
  findInvocationCandidateIds(taskId: string): Promise<string[]>;
  /**
   * 读人工已决终态裁决（终态最高优先，Req 10.6/10.7）；未接入人工队列 / 无裁决返回 null。
   * （PG 侧真实人工队列接线归任务 16；本任务以可注入端口形式整合。）
   */
  getHumanVerdict(candidateId: string): Promise<HumanReviewVerdict | null>;
  /** 升级：把候选送入既有人工队列（`getPendingCapabilities`）。 */
  enqueueForReview(candidateId: string): Promise<void>;
}

/** Classifier 依赖（skillRepo/deduplicator/verifier/store 必填；其余可选）。 */
export interface ClassifierDeps {
  /** 技能数据访问层：晋升经 `promote` 物化为 active（任务 3）。 */
  skillRepo: SkillRepo;
  /** 去重器：复用 `isConflictFree` 做 Conflict_Free 判定（任务 6）。 */
  deduplicator: Pick<Deduplicator, "isConflictFree">;
  /** 验证器：复用 `reviewSoft` 做软性类 LLM 评审（任务 8）。 */
  verifier: Pick<Verifier, "reviewSoft">;
  /** 候选状态机数据访问层；默认 `createPgClassifierStore()`。 */
  store?: ClassifierStore;
  /**
   * 宪法裁决器（enforce 模式安全/合规裁决 + 升级信号）；不注入则跳过宪法整合。
   * 生产注入 `new Constitution(weights)`，单测注入返回固定 Verdict 的 mock。
   */
  constitution?: ConstitutionAdjudicator;
  /**
   * enforce 模式下把晋升技能喂给 `skill-kb.addSkill` 的回调（使其可被 routeTask 命中）。
   * 不注入则只物化进 `skill` 表、不改路由（observe 语义）。
   */
  onPromoteToKb?: (spec: SkillSpec) => void | Promise<void>;
  /** 反哺配置（取 Promotion_Threshold_N / High_Score）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
}

// ─────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────

/**
 * constitution 升级判定的置信下限：低于此值视为"系统判不准"（Req 10.5a）。
 * 与 `deriveIntervention` 的弱建议阈值对齐（< 0.45 即非 strong/soft 的确定裁决）。
 */
const CONFIDENCE_FLOOR = 0.45;

// ─────────────────────────────────────────────────────────────────
// 纯函数：阈值 / Skill → SkillSpec
// ─────────────────────────────────────────────────────────────────

/**
 * 取该候选的晋升阈值。权威教师折扣：teacherAuthority=1 时阈值打折为 ceil(base*(1-discount))，
 * 等效于"更少样本即可晋升"——不是对分数加权，而是降低通过门槛。
 */
function thresholdOf(
  kind: SkillCandidate["kind"],
  config: RefluxConfig,
  teacherAuthority = 0,
): number {
  const base =
    kind === "executable"
      ? config.Promotion_Threshold_N_hard
      : config.Promotion_Threshold_N_soft;
  if (teacherAuthority <= 0) return base;
  const clamped = Math.min(Math.max(teacherAuthority, 0), 1);
  const discount = config.Teacher_Authority_Discount;
  return Math.max(1, Math.ceil(base * (1 - clamped * discount)));
}

/**
 * 把物化后的 active 技能映射为一期 `SkillSpec`（enforce 下喂给 `skill-kb.addSkill`）。
 * Skill 不含一期的 when/done/verify 字段，这里据现有字段合成最小可路由规格。
 */
export function skillToSpec(skill: Skill): SkillSpec {
  return {
    id: skill.id,
    name: skill.title,
    when: {
      taskPattern: skill.applicable_scenario || skill.title || skill.description,
      preconditions: [],
    },
    exec: { vars: skill.exec_vars ?? [], steps: skill.exec_steps ?? [] },
    done: skill.description,
    verify: { kind: "exit-code", spec: "" },
    platform: skill.platform,
    // os_scope=variant 视为平台专属（不可跨平台自动复用）。
    platformLocked: skill.os_scope === "variant",
    taxonomy: skill.taxonomy,
    provenance: skill.provenance,
  };
}

// ─────────────────────────────────────────────────────────────────
// Classifier 对外接口
// ─────────────────────────────────────────────────────────────────

/** Classifier 对外接口（对齐 design.md「Components and Interfaces · Classifier」）。 */
export interface Classifier {
  /**
   * 7.1 forge 信号：seeded → evidence_pending，绑定自动预测 id（Req 9.1/9.2）。
   */
  onForgeSeed(candidateId: string, predictionId: string): Promise<TransitionResult>;
  /**
   * 7.1 预测结算：evidence_pending → proven（hit）/ rejected（miss，自动拒绝 Req 10.3）。
   * 按绑定预测 id 回查候选（Req 9.3/9.4）。
   */
  onPredictionSettled(
    predictionId: string,
    result: "hit" | "miss",
  ): Promise<TransitionResult | null>;
  /**
   * 7.2 真值闸点亮：verify_task passed / settle_prediction hit 直接把 seeded 候选点亮为
   * proven（客观裁定，Req 9.5）。
   */
  lightByTruthGate(candidateId: string): Promise<TransitionResult>;
  /**
   * 7.2 复用成功点亮：贡献方自身复用成功 +1（未 active 前仅算 contributor_reuse_success，
   * Req 9.11）；达 Promotion_Threshold_N → proven（软性类需 LLM 评审通过，Req 9.7）。
   */
  recordReuseSuccess(candidateId: string): Promise<TransitionResult>;
  /**
   * 7.2 软性类评审点亮：经 `verifier.reviewSoft` 评审通过把 seeded 软技能候选点亮 proven
   * （Req 9.7）。
   */
  reviewSoftCandidate(candidateId: string): Promise<TransitionResult>;
  /**
   * 7.3 反向点亮（Req 9.10/2.9）：任务经 verify_task passed / settle_prediction hit 成功时，
   * 按 task_id 回查 `skill_invocation_event` 中 candidate_id 非空记录，点亮对应 seeded 候选。
   * 返回被点亮（状态发生变化）的候选转移结果列表。
   */
  onTruthGateTaskSuccess(taskId: string): Promise<TransitionResult[]>;
  /**
   * 7.5/7.6 晋升评估（双门 + 升级判定 + 人工优先）：对一个候选执行 Promotion_Gate 合取硬门
   * 与 Human_Review_Escalation 升级判定，自动晋升/拒绝或升级 pending_review；人工已决终态
   * 最高优先，自动门不推翻。
   */
  evaluate(candidateId: string, ctx?: PromotionContext): Promise<ClassifyDecision>;
}

// ─────────────────────────────────────────────────────────────────
// Classifier 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建 Classifier 实例。
 * @param deps 依赖（skillRepo/deduplicator/verifier 必填）；store/constitution/onPromoteToKb/config 可选。
 */
export function createClassifier(deps: ClassifierDeps): Classifier {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const skillRepo = deps.skillRepo;
  const deduplicator = deps.deduplicator;
  const verifier = deps.verifier;
  const store = deps.store ?? createPgClassifierStore();
  const constitution = deps.constitution;
  const onPromoteToKb = deps.onPromoteToKb;

  /** 软性类候选：经 `verifier.reviewSoft` 评审是否通过。 */
  async function reviewSoftPass(candidate: SkillCandidate): Promise<boolean> {
    const d = candidate.draft ?? {};
    const result = await verifier.reviewSoft({
      title: typeof d.title === "string" ? d.title : "",
      description: typeof d.description === "string" ? d.description : "",
      applicable_scenario:
        typeof d.applicable_scenario === "string" ? d.applicable_scenario : undefined,
      draft: d,
    });
    return result.pass === true;
  }

  /**
   * 复用 / 反向点亮的共用内核：对一个 seeded 候选记一次有效点亮（reuse +1），
   * 达阈值则转 proven（软性类需 LLM 评审通过）。非 seeded 不动。
   */
  async function lightCandidate(candidate: SkillCandidate): Promise<TransitionResult> {
    const id = candidate.id;
    if (candidate.status !== "seeded") {
      return {
        candidateId: id,
        status: candidate.status,
        changed: false,
        reason: `候选非 seeded（当前 ${candidate.status}），不点亮`,
      };
    }
    const count = await store.incrementReuseSuccess(id);
    const threshold = thresholdOf(candidate.kind, config);
    if (count < threshold) {
      return {
        candidateId: id,
        status: "seeded",
        changed: false,
        reason: `复用成功 ${count}/${threshold}，未达阈值，保持 seeded`,
      };
    }
    // 达阈值：软性类需 LLM 评审通过才点亮 proven（Req 9.7）。
    if (candidate.kind === "soft") {
      const pass = await reviewSoftPass(candidate);
      if (!pass) {
        return {
          candidateId: id,
          status: "seeded",
          changed: false,
          reason: `复用成功 ${count}/${threshold} 已达阈值，但软性类 LLM 评审未通过，保持 seeded`,
        };
      }
    }
    await store.setCandidateStatus(id, "proven");
    return {
      candidateId: id,
      status: "proven",
      changed: true,
      reason: `复用成功 ${count}/${threshold} 达阈值${candidate.kind === "soft" ? "且软性评审通过" : ""}，点亮 proven`,
    };
  }

  /** 升级到 pending_review 并入既有人工队列。 */
  async function escalate(
    candidateId: string,
    trigger: EscalationTrigger,
    reason: string,
  ): Promise<ClassifyDecision> {
    await store.setCandidateStatus(candidateId, "pending_review");
    await store.enqueueForReview(candidateId);
    return { outcome: "escalated", candidateId, escalationTrigger: trigger, reason };
  }

  return {
    async onForgeSeed(candidateId: string, predictionId: string): Promise<TransitionResult> {
      const cand = await store.getCandidate(candidateId);
      if (!cand) throw new Error(`onForgeSeed 失败：候选不存在 candidateId=${candidateId}`);
      if (cand.status !== "seeded") {
        return {
          candidateId,
          status: cand.status,
          changed: false,
          reason: `候选非 seeded（当前 ${cand.status}），不绑定预测`,
        };
      }
      await store.bindPrediction(candidateId, predictionId);
      await store.setCandidateStatus(candidateId, "evidence_pending");
      return {
        candidateId,
        status: "evidence_pending",
        changed: true,
        reason: `forge 绑定预测 ${predictionId}，进入 evidence_pending`,
      };
    },

    async onPredictionSettled(
      predictionId: string,
      result: "hit" | "miss",
    ): Promise<TransitionResult | null> {
      const candidateId = await store.findCandidateIdByPrediction(predictionId);
      if (!candidateId) return null;
      const cand = await store.getCandidate(candidateId);
      if (!cand) return null;
      // 仅对 evidence_pending 的候选结算（Req 9.3/9.4）。
      if (cand.status !== "evidence_pending") {
        return {
          candidateId,
          status: cand.status,
          changed: false,
          reason: `候选非 evidence_pending（当前 ${cand.status}），预测结算不改状态`,
        };
      }
      const next: CandidateStatus = result === "hit" ? "proven" : "rejected";
      await store.setCandidateStatus(candidateId, next);
      return {
        candidateId,
        status: next,
        changed: true,
        reason:
          result === "hit"
            ? `绑定预测 ${predictionId} 命中，转 proven`
            : `绑定预测 ${predictionId} 落空，自动拒绝 rejected`,
      };
    },

    async lightByTruthGate(candidateId: string): Promise<TransitionResult> {
      const cand = await store.getCandidate(candidateId);
      if (!cand) throw new Error(`lightByTruthGate 失败：候选不存在 candidateId=${candidateId}`);
      if (cand.status !== "seeded") {
        return {
          candidateId,
          status: cand.status,
          changed: false,
          reason: `候选非 seeded（当前 ${cand.status}），真值闸不重复点亮`,
        };
      }
      await store.setCandidateStatus(candidateId, "proven");
      return {
        candidateId,
        status: "proven",
        changed: true,
        reason: "真值闸（verify_task passed / settle_prediction hit）客观点亮 proven",
      };
    },

    async recordReuseSuccess(candidateId: string): Promise<TransitionResult> {
      const cand = await store.getCandidate(candidateId);
      if (!cand) throw new Error(`recordReuseSuccess 失败：候选不存在 candidateId=${candidateId}`);
      return lightCandidate(cand);
    },

    async reviewSoftCandidate(candidateId: string): Promise<TransitionResult> {
      const cand = await store.getCandidate(candidateId);
      if (!cand) throw new Error(`reviewSoftCandidate 失败：候选不存在 candidateId=${candidateId}`);
      if (cand.kind !== "soft") {
        return {
          candidateId,
          status: cand.status,
          changed: false,
          reason: "非软性类候选，reviewSoft 不适用",
        };
      }
      if (cand.status !== "seeded") {
        return {
          candidateId,
          status: cand.status,
          changed: false,
          reason: `候选非 seeded（当前 ${cand.status}），不评审点亮`,
        };
      }
      const pass = await reviewSoftPass(cand);
      if (!pass) {
        return {
          candidateId,
          status: "seeded",
          changed: false,
          reason: "软性类 LLM 评审未通过，保持 seeded",
        };
      }
      await store.setCandidateStatus(candidateId, "proven");
      return {
        candidateId,
        status: "proven",
        changed: true,
        reason: "软性类 LLM 评审通过，点亮 proven",
      };
    },

    async onTruthGateTaskSuccess(taskId: string): Promise<TransitionResult[]> {
      const candidateIds = await store.findInvocationCandidateIds(taskId);
      const results: TransitionResult[] = [];
      for (const id of candidateIds) {
        const cand = await store.getCandidate(id);
        if (!cand) continue;
        const r = await lightCandidate(cand);
        if (r.changed) results.push(r);
      }
      return results;
    },

    async evaluate(candidateId: string, ctx: PromotionContext = {}): Promise<ClassifyDecision> {
      const cand = await store.getCandidate(candidateId);
      if (!cand) throw new Error(`evaluate 失败：候选不存在 candidateId=${candidateId}`);

      const safety: GateOutcome = ctx.safety ?? "pass";
      const sanitize: GateOutcome = ctx.sanitize ?? "pass";
      const mode: FlywheelMode = ctx.mode ?? "observe";

      // 0) 人工已决终态最高优先（Req 10.6/10.7）：自动门读到人工终态不改写、不推翻。
      const human = await store.getHumanVerdict(candidateId);
      if (human) {
        if (human.decision === "approved") {
          // 人工 approved 即终态 active；若尚未物化则补物化（幂等：已物化直接返回）。
          if (cand.merged_into) {
            const skill = (await skillRepo.get(cand.merged_into)) ?? undefined;
            return {
              outcome: "human_approved",
              candidateId,
              skill,
              reason: `人工终态 approved（reviewed_by=${human.reviewed_by}），已物化，自动门不推翻`,
            };
          }
          const skill = await skillRepo.promote(candidateId);
          if (mode === "enforce" && onPromoteToKb) await onPromoteToKb(skillToSpec(skill));
          return {
            outcome: "human_approved",
            candidateId,
            skill,
            reason: `人工终态 approved（reviewed_by=${human.reviewed_by}），物化为 active，自动门不推翻`,
          };
        }
        // 人工 rejected：终态 rejected。
        if (cand.status !== "rejected") await store.setCandidateStatus(candidateId, "rejected");
        return {
          outcome: "human_rejected",
          candidateId,
          reason: `人工终态 rejected（reviewed_by=${human.reviewed_by}），自动门不推翻`,
        };
      }

      // 1) 既有自动终态：rejected 不复活；已物化（merged_into）幂等返回 promoted。
      if (cand.status === "rejected") {
        return { outcome: "rejected", candidateId, reason: "候选已是 rejected 终态" };
      }
      if (cand.merged_into) {
        const skill = (await skillRepo.get(cand.merged_into)) ?? undefined;
        return { outcome: "promoted", candidateId, skill, reason: "候选已物化为 active（幂等）" };
      }

      // 2) 升级触发 (b)：疑似重复未决（Req 10.5b）。
      if (cand.status === "suspect_duplicate") {
        return escalate(
          candidateId,
          "suspect_duplicate",
          "候选被标记 suspect_duplicate（疑似重复未决），升级人工兜底",
        );
      }

      // 3) 安全 / 脱敏裁决（Req 10.3 自动拒绝 / Req 10.5d 边界升级）。
      if (safety === "fail" || sanitize === "fail") {
        await store.setCandidateStatus(candidateId, "rejected");
        return {
          outcome: "rejected",
          candidateId,
          reason:
            safety === "fail" ? "安全预审明确失败，自动拒绝" : "脱敏明确不通过，自动拒绝",
        };
      }
      if (safety === "boundary" || sanitize === "boundary") {
        return escalate(
          candidateId,
          "safety_boundary",
          safety === "boundary"
            ? "安全预审边界存疑（既非明确通过、也非明确失败），升级人工兜底"
            : "脱敏边界存疑（既非明确通过、也非明确失败），升级人工兜底",
        );
      }

      // 4) Promotion_Gate 首个合取项：必须 proven（finish_task done 不充当 proven，Req 16.5）。
      if (cand.status !== "proven") {
        return {
          outcome: "pending",
          candidateId,
          reason: `候选未 proven（当前 ${cand.status}），不满足 Promotion_Gate，等待证据`,
        };
      }

      // 5) 升级触发 (a)：enforce 模式 constitution 低置信 / 矛盾未决（Req 10.5a / 16）。
      if (mode === "enforce" && constitution && ctx.signals && ctx.signals.length > 0) {
        const verdict = constitution.adjudicate(ctx.signals);
        const lowConfidence = verdict.confidence < CONFIDENCE_FLOOR;
        const contested = verdict.intervention === "hold" || verdict.intervention === "silent";
        if (lowConfidence || contested) {
          return escalate(
            candidateId,
            "constitution",
            `constitution 裁决判不准（confidence=${verdict.confidence.toFixed(2)}, intervention=${verdict.intervention}），升级人工兜底`,
          );
        }
      }

      // 6) Conflict_Free 判定（复用 deduplicator.isConflictFree）。
      const cf: ConflictFreeResult = await deduplicator.isConflictFree(candidateId);

      // 7) Promotion_Gate 第二合取项：复用≥N ∨（High_Score ∧ Conflict_Free）。
      const authority = ctx.teacherAuthority ?? 0;
      const threshold = thresholdOf(cand.kind, config, authority);
      const reuseBranch = cand.contributor_reuse_success >= threshold;
      const highScore = ctx.highScore === true;

      // 升级触发 (c)：需走 High_Score 分支（复用未达 N）且 Conflict 模糊（Req 10.5c）。
      if (!reuseBranch && highScore && cf.ambiguous) {
        return escalate(
          candidateId,
          "conflict_ambiguous",
          "High_Score 但 Conflict 模糊（无法判定 Conflict_Free），升级人工兜底",
        );
      }

      const highScoreBranch = highScore && cf.conflictFree;
      const secondGate = reuseBranch || highScoreBranch;
      if (!secondGate) {
        return {
          outcome: "pending",
          candidateId,
          reason: `双门第二合取项未满足（复用 ${cand.contributor_reuse_success}/${threshold}，High_Score=${highScore}，Conflict_Free=${cf.conflictFree}），不晋升`,
        };
      }

      // 8) Source_Weight（Req 9.8）：autonomous 降权、不主动晋升。
      if (cand.source_weight === "autonomous") {
        return {
          outcome: "held",
          candidateId,
          reason: "autonomous 来源降权：双门满足但不主动晋升（等待 user_task 证据或人工）",
        };
      }

      // 9) 自动门晋升：物化为 active（Req 16.1/10.2）；enforce 下喂 skill-kb 使其可被路由命中。
      const skill = await skillRepo.promote(candidateId);
      if (mode === "enforce" && onPromoteToKb) await onPromoteToKb(skillToSpec(skill));
      return {
        outcome: "promoted",
        candidateId,
        skill,
        reason: `Promotion_Gate 合取满足（proven ∧ 安全 ∧ 脱敏 ∧ ${reuseBranch ? `复用≥${threshold}` : "High_Score∧Conflict_Free"}），自动晋升 active`,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 内存数据访问实现（纯单元测试用，不连真实 PG）
// ─────────────────────────────────────────────────────────────────

/** 内存 ClassifierStore 的可选初始化（注入候选 / 反向点亮映射 / 人工裁决）。 */
export interface InMemoryClassifierStoreInit {
  /** 初始候选列表。 */
  candidates?: SkillCandidate[];
  /** task_id → 候选 id 列表（模拟 skill_invocation_event 中 candidate_id 非空记录）。 */
  invocationByTask?: Record<string, string[]>;
  /** 候选 id → 人工终态裁决（模拟既有人工队列裁决结果）。 */
  humanVerdicts?: Record<string, HumanReviewVerdict>;
}

/** 内存 ClassifierStore 句柄（额外暴露 enqueued 便于断言"是否进人工队列"）。 */
export interface InMemoryClassifierStore extends ClassifierStore {
  /** 已升级入人工队列的候选 id 集合（测试断言用）。 */
  readonly enqueued: Set<string>;
  /** 设置 / 更新人工终态裁决（模拟人工 admin 给出结论）。 */
  setHumanVerdict(candidateId: string, verdict: HumanReviewVerdict): void;
}

/**
 * 创建内存 ClassifierStore（与 PG 实现同契约，行为对齐）。仅供纯单元测试。
 */
export function createInMemoryClassifierStore(
  init: InMemoryClassifierStoreInit = {},
): InMemoryClassifierStore {
  const candidates = new Map<string, SkillCandidate>();
  for (const c of init.candidates ?? []) {
    candidates.set(c.id, JSON.parse(JSON.stringify(c)) as SkillCandidate);
  }
  const invocationByTask = new Map<string, string[]>(
    Object.entries(init.invocationByTask ?? {}),
  );
  const humanVerdicts = new Map<string, HumanReviewVerdict>(
    Object.entries(init.humanVerdicts ?? {}),
  );
  const enqueued = new Set<string>();

  const clone = (c: SkillCandidate): SkillCandidate =>
    JSON.parse(JSON.stringify(c)) as SkillCandidate;

  return {
    enqueued,
    setHumanVerdict(candidateId: string, verdict: HumanReviewVerdict): void {
      humanVerdicts.set(candidateId, verdict);
    },
    async getCandidate(candidateId: string): Promise<SkillCandidate | null> {
      const c = candidates.get(candidateId);
      return c ? clone(c) : null;
    },
    async setCandidateStatus(candidateId: string, status: CandidateStatus): Promise<void> {
      const c = candidates.get(candidateId);
      if (c) {
        c.status = status;
        c.updated_at = new Date().toISOString();
      }
    },
    async bindPrediction(candidateId: string, predictionId: string): Promise<void> {
      const c = candidates.get(candidateId);
      if (c) c.linked_prediction_id = predictionId;
    },
    async incrementReuseSuccess(candidateId: string): Promise<number> {
      const c = candidates.get(candidateId);
      if (!c) return 0;
      c.contributor_reuse_success = (c.contributor_reuse_success ?? 0) + 1;
      return c.contributor_reuse_success;
    },
    async findCandidateIdByPrediction(predictionId: string): Promise<string | null> {
      for (const c of candidates.values()) {
        if (c.linked_prediction_id === predictionId) return c.id;
      }
      return null;
    },
    async findInvocationCandidateIds(taskId: string): Promise<string[]> {
      return [...new Set(invocationByTask.get(taskId) ?? [])];
    },
    async getHumanVerdict(candidateId: string): Promise<HumanReviewVerdict | null> {
      return humanVerdicts.get(candidateId) ?? null;
    },
    async enqueueForReview(candidateId: string): Promise<void> {
      enqueued.add(candidateId);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 ClassifierStore。候选表 / 调用事件表（006 迁移新增、无 RLS）走系统级 `query`。
 *
 * 说明：`getHumanVerdict` / `enqueueForReview` 的真实人工队列接线归任务 16
 * （`getPendingCapabilities` + `POST /api/capabilities/review` + admin 鉴权）。本实现：
 *  - `getHumanVerdict` 暂返 null（无人工终态时自动门正常运转）；任务 16 接入后由其覆盖；
 *  - `enqueueForReview` 仅靠候选 `pending_review` 状态被 `getPendingCapabilities` 读取，
 *    此处为可观测的占位（不另写队列表）。
 */
export function createPgClassifierStore(): ClassifierStore {
  return {
    async getCandidate(candidateId: string): Promise<SkillCandidate | null> {
      const { query } = await import("../db/pool.js");
      const res = await query<Record<string, unknown>>(
        `SELECT * FROM skill_candidate WHERE id = $1`,
        [candidateId],
      );
      if (res.rows.length === 0) return null;
      return mapCandidateRow(res.rows[0]);
    },

    async setCandidateStatus(candidateId: string, status: CandidateStatus): Promise<void> {
      const { query } = await import("../db/pool.js");
      await query(
        `UPDATE skill_candidate SET status = $2, updated_at = now() WHERE id = $1`,
        [candidateId, status],
      );
    },

    async bindPrediction(candidateId: string, predictionId: string): Promise<void> {
      const { query } = await import("../db/pool.js");
      await query(
        `UPDATE skill_candidate SET linked_prediction_id = $2, updated_at = now() WHERE id = $1`,
        [candidateId, predictionId],
      );
    },

    async incrementReuseSuccess(candidateId: string): Promise<number> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ contributor_reuse_success: number }>(
        `UPDATE skill_candidate
            SET contributor_reuse_success = contributor_reuse_success + 1, updated_at = now()
          WHERE id = $1
        RETURNING contributor_reuse_success`,
        [candidateId],
      );
      return res.rows[0]?.contributor_reuse_success ?? 0;
    },

    async findCandidateIdByPrediction(predictionId: string): Promise<string | null> {
      const { query } = await import("../db/pool.js");
      const res = await query<{ id: string }>(
        `SELECT id FROM skill_candidate WHERE linked_prediction_id = $1 LIMIT 1`,
        [predictionId],
      );
      return res.rows[0]?.id ?? null;
    },

    async findInvocationCandidateIds(taskId: string): Promise<string[]> {
      const { query } = await import("../db/pool.js");
      // 反向点亮（Req 9.10）：按 task_id 回查 candidate_id 非空记录，去重返回。
      const res = await query<{ candidate_id: string }>(
        `SELECT DISTINCT candidate_id FROM skill_invocation_event
          WHERE task_id = $1 AND candidate_id IS NOT NULL`,
        [taskId],
      );
      return res.rows.map((r) => r.candidate_id);
    },

    async getHumanVerdict(_candidateId: string): Promise<HumanReviewVerdict | null> {
      // 真实人工队列裁决接线归任务 16；当前无人工终态来源，返回 null。
      return null;
    },

    async enqueueForReview(_candidateId: string): Promise<void> {
      // pending_review 状态本身即被既有 getPendingCapabilities 读取，此处不另写队列表。
    },
  };
}

/** PG 行 → SkillCandidate 领域对象映射（与 skillRepo 的 mapCandidate 等价）。 */
function mapCandidateRow(row: Record<string, unknown>): SkillCandidate {
  const toIso = (ts: unknown): string =>
    ts instanceof Date ? ts.toISOString() : ts == null ? "" : String(ts);
  return {
    id: String(row.id),
    kind: row.kind as SkillCandidate["kind"],
    draft: (row.draft ?? {}) as Record<string, unknown>,
    category: (row.category as string | null) ?? undefined,
    source_role: row.source_role as SkillCandidate["source_role"],
    source_weight: row.source_weight as SkillCandidate["source_weight"],
    user_neutral: (row.user_neutral as boolean | null) ?? undefined,
    status: row.status as CandidateStatus,
    contributor_id: (row.contributor_id as string | null) ?? undefined,
    linked_prediction_id: (row.linked_prediction_id as string | null) ?? undefined,
    linked_verifiable_id: (row.linked_verifiable_id as string | null) ?? undefined,
    trajectory_ref: (row.trajectory_ref as SkillCandidate["trajectory_ref"]) ?? undefined,
    contributor_reuse_success: (row.contributor_reuse_success as number) ?? 0,
    merged_into: (row.merged_into as string | null) ?? undefined,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}
