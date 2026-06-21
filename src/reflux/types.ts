/**
 * 技能反哺（Skill Reflux）· 二期云反哺基础类型（types.ts）
 * ------------------------------------------------------------------
 * 定位：`skill-flywheel`（一期本地飞轮）的二期云反哺扩展。
 *
 * 本文件**复用并扩展** `src/skill-flywheel` 的权威类型 `SkillSpec`/`SkillPlatform`/
 * `SkillExecStep`/`SkillTaxonomy`/`SkillVerifyContract`（值/结构分离 `exec.vars`/`exec.steps`、
 * 平台契约 `platform`、多维分类 `taxonomy`、来源信誉 `provenance`），
 * 在其之上扩展二期反哺所需的 `Skill`/`PlatformVariant`/`SkillCandidate`/`HarvestSignal`/
 * `TrajectoryEvent`/`InvocationEvent`/`SkillSummary` 等类型。
 *
 * 关键约束：
 * - 平台枚举统一复用 `SkillPlatform = "mac" | "win" | "linux" | "any"`，**禁止使用 `win32`/`darwin`**。
 * - 不重复定义 `SkillSpec`/`SkillPlatform`，一律从 `skill-flywheel` barrel 导入复用。
 * - 轨迹输入复用 `execution-kernel.ExecutionStep`（与 `distillSkill` 的 `DistillInput.trace` 同型），不另造轨迹类型。
 *
 * _Requirements: 1.2, 全局支撑；Configurable Parameters_
 */

import type {
  SkillSpec,
  SkillPlatform,
  SkillExecStep,
  SkillTaxonomy,
  SkillVerifyContract,
} from "../skill-flywheel/index.js";
import type { ExecutionStep } from "../execution-kernel/index.js";

// ── 复用一期权威类型（re-export，二期内部统一从本 barrel 引用，不另起一套） ──
export type {
  SkillSpec,
  SkillPlatform,
  SkillExecStep,
  SkillTaxonomy,
  SkillVerifyContract,
};
// 轨迹/蒸馏输入复用 execution-kernel 的 ExecutionStep，不另造轨迹类型。
export type { ExecutionStep };

// ── 二期反哺基础枚举 ──

/**
 * 技能类型（Skill_Kind）：
 * - `soft`：软/知识类，与 OS 无关（OS_Scope=any）。
 * - `executable`：可执行类，OS 相关，以 Platform_Variant 承载各平台实现。
 */
export type SkillKind = "soft" | "executable";

/**
 * 可执行技能的具体操作系统（Platform_Variant 的 os），仅 `mac`/`win`/`linux`；
 * 与 `SkillPlatform` 对齐，但不含 `any`（`any` 是 soft 技能顶层 OS_Scope）。
 */
export type VariantOS = Exclude<SkillPlatform, "any">;

/**
 * 候选状态机取值（Candidate_Status）。
 * `pending_review` 为 `proven` 之后、`active` 之前的旁路状态（Human_Review_Escalation 触发时进入，
 * 既不自动晋升也不自动拒绝，等待人工终态）；`suspect_duplicate` 为去重模糊区间标记。
 */
export type CandidateStatus =
  | "seeded"
  | "evidence_pending"
  | "proven"
  | "pending_review"
  | "rejected"
  | "suspect_duplicate";

/** 公共技能的库内状态：active（可分发）/ retired（淘汰，单向、不物删）。 */
export type SkillStatus = "active" | "retired";

/**
 * 信号角色（Signal_Role，Req 2）：采集阶段对一条信号的角色标注。
 * - `truth_gate`：客观证明"有效"的信号（verify_task passed / settle_prediction hit）。
 * - `executable_seed`：可执行技能坯子（forge_capability / master_tool）。
 * - `soft_seed`：软技能坯子（add_rule / consolidate）。
 * - `correction_signal`：用户纠正/预测失败的教训信号（OPT-1 学习加速扩容）。
 */
export type SignalRole = "truth_gate" | "executable_seed" | "soft_seed" | "correction_signal";

/**
 * 来源权重（Source_Weight，Req 2.8）：
 * - `autonomous`：自主呼吸循环产出，降权、不主动晋升。
 * - `user_task`：真实用户任务/对话触发，优先晋升。
 */
export type SourceWeight = "autonomous" | "user_task";

/** 技能来源（对应 skill.source）。 */
export type SkillSource = "user_taught" | "self_learned" | "admin_seeded";

/**
 * 平台变体的验证状态（Req 7/8）：在一期单一 `verified` 布尔之上扩展的两级细化状态。
 * - `unverified`：未验证。
 * - `server-verified`：服务端 shell 预检通过的弱证据，不代表任何用户平台可用。
 * - `connector-verified`：在该平台真实连接器上验证通过，是判定该平台可用性的唯一依据。
 */
export type VerifyStatus = "unverified" | "server-verified" | "connector-verified";

/** OS 适用范围（OS_Scope）：soft 为 `any`，executable 以 `variant` 承载各平台。 */
export type OSScope = "any" | "variant";

// ── 质量分（Quality_Score）：与一期 reputationOf = verifiedCount/totalCount 统一映射 ──

/**
 * 质量分度量（Quality_Score，Req 10/12）。
 * 与一期 `provenance` 为同一事实的两种视图：
 * `use_count = provenance.totalCount`、`success_count = provenance.verifiedCount`、
 * `success_rate = success_count/use_count = reputationOf`。
 */
export interface QualityScore {
  /** 复用总次数（= provenance.totalCount）。 */
  use_count: number;
  /** 复用成功次数（= provenance.verifiedCount）。 */
  success_count: number;
  /** 成功率（= success_count/use_count = reputationOf）。 */
  success_rate: number;
  /** 静默继承计数（Silent_Inheritance，Req 12.4/12.5）。 */
  silent_count: number;
}

// ── 平台变体（Platform_Variant，Req 8/15；对应表 skill_platform_variant） ──

/**
 * 可执行技能在某一具体平台上的实现条目（Platform_Variant）。
 * 仅当在该平台真实连接器验证通过时，`verify_status` 才标为 `connector-verified`。
 */
export interface PlatformVariant {
  /** 变体所属技能 id。 */
  skill_id: string;
  /** 目标平台（mac/win/linux，与 SkillPlatform 对齐，不含 any）。 */
  os: VariantOS;
  /** 该平台的具体命令/脚本（值/结构分离，args 值用 ${var} 占位）。 */
  command: string;
  /** 验证状态（unverified / server-verified / connector-verified）。 */
  verify_status: VerifyStatus;
  /** 验证时间。 */
  verified_at?: string;
  /** 验证来源连接器标识。 */
  verified_by?: string;
  /** 连续失败计数（达阈值触发降级，Req 8.6）。 */
  fail_streak: number;
}

// ── 公共技能（Public_Skill，Req 1/10/12；对应表 skill；与 SkillSpec 对齐为同一权威表示） ──

/**
 * 公共技能库中的技能（Skill）。
 * 与 `skill-flywheel` 的 `SkillSpec` 对齐：值/结构分离的执行体（`exec_vars`/`exec_steps`，
 * 对应 `SkillSpec.exec.vars`/`exec.steps`）、平台契约 `platform`、多维分类 `taxonomy`、
 * 来源信誉 `provenance`；并在其上扩展二期反哺所需字段（`kind`/`status`/质量分/`cross_user_breadth` 等）。
 */
export interface Skill {
  id: string;
  /** 技能类型（soft / executable）。 */
  kind: SkillKind;
  title: string;
  description: string;
  /** 适用场景（applicable_scenario，渐进加载摘要字段）。 */
  applicable_scenario?: string;
  /** 值/结构分离执行体：占位变量列表（对齐 SkillSpec.exec.vars）。 */
  exec_vars: string[];
  /** 值/结构分离执行体：仅保留结构的步骤（对齐 SkillSpec.exec.steps，args 值用 ${var} 占位）。 */
  exec_steps: SkillExecStep[];
  /** 多维分类（对齐 SkillSpec.taxonomy）。 */
  taxonomy: SkillTaxonomy;
  category: string;
  tags: string[];
  /** 顶层平台契约（对齐 SkillSpec.platform），取值 mac/win/linux/any。 */
  platform: SkillPlatform[];
  /** OS 适用范围：any（soft）/ variant（executable）。 */
  os_scope: OSScope;
  source: SkillSource;
  /** 是否用户中立（User_Neutral，Req 18）。 */
  user_neutral: boolean;
  /** 是否纳入 Starter_Skill_Set（Req 17）。 */
  is_starter: boolean;
  /** 库内状态（active / retired）。 */
  status: SkillStatus;
  version: number;
  /** 来源信誉（对齐 SkillSpec.provenance）：{createdAt, verifiedCount, totalCount}。 */
  provenance: SkillSpec["provenance"];
  /** 质量分（与 provenance 为同一事实的两种视图）。 */
  quality: QualityScore;
  /** 跨用户广度（Cross_User_Breadth）：= skill_contributor 中不同 user_id 数。 */
  cross_user_breadth: number;
  /** 可执行技能的各平台变体（soft 技能为空）。 */
  variants?: PlatformVariant[];
  created_at: string;
  updated_at: string;
  retired_at?: string;
}

// ── 技能候选（Skill_Candidate，Req 9/16；对应表 skill_candidate） ──

/**
 * 处于状态机中、尚未进入 active 公共库的待沉淀技能记录（Skill_Candidate）。
 */
export interface SkillCandidate {
  id: string;
  kind: SkillKind;
  /** 蒸馏后草稿（title/description/steps/intent 等，与 SkillSpec 字段对齐）。 */
  draft: Record<string, unknown>;
  category?: string;
  /** 来源信号角色。 */
  source_role: SignalRole;
  /** 来源权重。 */
  source_weight: SourceWeight;
  /** 是否用户中立（User_Neutral）。 */
  user_neutral?: boolean;
  status: CandidateStatus;
  /** 贡献者 userId（A3 per-user 隔离式，迁移期 System_User 固定为 local）。 */
  contributor_id?: string;
  /** forge_capability 自动挂载的预测 id（relatedTo=g_capability）。 */
  linked_prediction_id?: string;
  /** 关联的可验证任务 id。 */
  linked_verifiable_id?: string;
  /** 轨迹引用（关联到产生该信号的执行轨迹）。 */
  trajectory_ref?: TrajectoryRef;
  /** 贡献方自身复用成功次数（未 active 前的"复用成功"，Req 9.11）。 */
  contributor_reuse_success: number;
  /** 已合并进的目标技能 id（去重合并时）。 */
  merged_into?: string;
  created_at: string;
  updated_at: string;
}

/** 轨迹引用：把信号关联到产生它的执行轨迹（任务线 cur.id 或主循环时间窗）。 */
export interface TrajectoryRef {
  /** 任务线 id（cur.id）。 */
  task_id?: string;
  /** 整形为 ExecutionStep[] 的轨迹片段，作为 distillSkill 的 DistillInput.trace。 */
  steps?: ExecutionStep[];
}

// ── 采集信号（HarvestSignal，Req 2；对应表 skill_harvest_queue） ──

/**
 * 采集打标入队的原始信号（Harvest_Signal，待蒸馏）。
 * 采集路径**零 LLM**，只做廉价入队（Req 20.2）。
 */
export interface HarvestSignal {
  id?: string;
  /** 信号角色。 */
  signal_role: SignalRole;
  /** 产生该信号的工具名（verify_task / forge_capability / master_tool / add_rule 等）。 */
  source_tool: string;
  /** 来源权重。 */
  source_weight: SourceWeight;
  /** 贡献者 userId。 */
  contributor_id: string;
  /** 原始负载（工具运行结果 / SkillSpec 等）。 */
  payload: Record<string, unknown>;
  /** forge_capability 关联的自动预测 id。 */
  linked_prediction_id?: string;
  /** 关联的可验证任务 id。 */
  linked_verifiable_id?: string;
  /** 任务线 id（用于轨迹关联）。 */
  task_id?: string;
  /** 队列状态（pending / distilled / rejected）。 */
  status?: "pending" | "distilled" | "rejected";
  enqueued_at?: string;
}

// ── 轨迹事件（TrajectoryEvent，Req 3；对应表 trajectory_event，append-only 明细表） ──

/**
 * 轨迹环形缓冲的单条明细（Trajectory_Event）。
 * 按 (user_id, ts DESC) 取最近 N 条；保留策略为"最近 N 条 + 最近 T 小时"双条件。
 */
export interface TrajectoryEvent {
  id?: number;
  user_id: string;
  /** 呼吸循环周期号。 */
  cycle?: number;
  /** 任务线 id。 */
  task_id?: string;
  /** 动作名（executeTool 的工具名）。 */
  action_name: string;
  /** 入参摘要。 */
  args_summary?: string;
  /** 结果摘要。 */
  result_summary?: string;
  ts?: string;
}

// ── 技能调用事件（InvocationEvent，Req 2.9/9.10/12；对应表 skill_invocation_event） ──

/**
 * 技能/命令调用事件（Invocation_Event）。
 * 同时服务于 master_tool 候选的反向点亮（Req 9.10）与静默继承检测（Req 12）。
 */
export interface InvocationEvent {
  id?: number;
  user_id: string;
  /** 命中的公共技能 id（可空）。 */
  skill_id?: string;
  /** 命中的候选 id（反向点亮用，可空）。 */
  candidate_id?: string;
  /** 命令指纹（用于匹配已知技能/命令）。 */
  command_fingerprint?: string;
  /** 任务线 id。 */
  task_id?: string;
  /** 调用平台。 */
  platform?: SkillPlatform;
  /** 调用结果（pending / success / fail）。 */
  outcome: "pending" | "success" | "fail";
  invoked_at?: string;
}

// ── 技能摘要（Skill_Summary，Req 11.4）：渐进加载默认返回的轻量视图 ──

/**
 * 渐进加载默认返回的轻量视图（Skill_Summary）。
 * 不含 `exec_steps`/`script`，仅在继承方显式 expand 时才展开完整内容。
 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  applicable_scenario?: string;
  category: string;
  tags: string[];
  /** 质量分（success_rate 与 use_count 组合度量）。 */
  quality_score: number;
  /** 平台变体数量（不展开具体变体内容）。 */
  platform_variant_count: number;
  /** 是否已在继承方平台 connector-verified（分发时标注"未在你平台验证"用）。 */
  platform_verified?: boolean;
}
