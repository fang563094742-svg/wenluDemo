/**
 * 技能反哺（Skill Reflux）· Harvester（采集，零 LLM）（harvester.ts）
 * ------------------------------------------------------------------
 * 对应 design.md「Harvester（采集，零 LLM）」与采集映射表，落地任务 10（10.1/10.2）。
 *
 * 定位：挂在 `riverMain` 既有工具分支末尾的**廉价打标入队**层（采集路径**零 LLM**，Req 20.2）。
 * 主循环只把信号写入 `skill_harvest_queue` / 把调用事件写入 `skill_invocation_event` /
 * 把轨迹明细写入 `trajectory_event`（经任务 9 的 `trajectoryBuffer`）；
 * 重活（蒸馏/去重/验证/LLM 评审）一律留给后台管线（Distiller 等）批量执行。
 *
 * 采集映射（design.md「Harvester 采集映射」表 / Req 2）：
 *  | 触发                              | signal_role      | 入队动作                                   |
 *  |-----------------------------------|------------------|--------------------------------------------|
 *  | verify_task passed                | truth_gate       | onVerifyPassed → enqueue（带 linked_verifiable_id）|
 *  | settle_prediction hit             | truth_gate       | onPredictionSettled('hit') → enqueue       |
 *  | settle_prediction miss            | —                | 不入队为成功信号                            |
 *  | forge_capability 成功             | executable_seed  | enqueue（带 linked_prediction_id）          |
 *  | master_tool 成功                  | executable_seed  | enqueue                                    |
 *  | add_rule / consolidate 概念       | soft_seed        | enqueue                                    |
 *  | finish_task done                  | —（仅数据源）    | stashTrajectory（仅落轨迹，不入队为成功信号）|
 *  | understand_user / userModel       | —（排除）        | Entry_Gate 隐私闸直接丢弃                    |
 *
 * Entry_Gate 隐私闸（Req 2.7 / 16.1）：凡来源于 `understand_user`、userModel、或针对具体主人的
 * 个人 beliefs 的信号一律拒绝采集、不入队、不送管线（零 LLM 的廉价键/串匹配，不调任何 LLM provider）。
 *
 * 轨迹关联（任务 10.2 / Req 3.1/3.3/3.4）：
 *  - 任务线内：用 `cur.id`（task_id）关联 `cur.log`（stashTrajectory 写 trajectory_event）；
 *  - forge：用 `linked_prediction_id` 关联自动预测；
 *  - 可验证任务：用 `linked_verifiable_id` 关联；
 *  - 环形缓冲维护复用任务 9 的 `trajectoryBuffer.recordAction`。
 *
 * 非侵入与鲁棒性（A4）：所有 hook 由 `riverMain`（任务 11 接线）追加式调用，全部 try/catch 吞错，
 * 失败仅记日志、绝不向上抛出破坏主链；采集路径不阻塞呼吸/对话主循环。
 *
 * DB 访问依赖注入（便于 mock）：
 *  - `skill_harvest_queue` / `skill_invocation_event`（006 迁移新增、无 RLS）走系统级 `query`；
 *  - `trajectory_event` 走任务 9 的 `trajectoryBuffer`（其内部经 `withUser` 设置会话变量）。
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 16.1, 16.2, 3.1, 3.3, 3.4, 20.2_
 */

import { query as defaultQuery } from "../db/pool.js";
import { createTrajectoryBuffer, type TrajectoryBuffer } from "./trajectoryBuffer.js";
import type {
  HarvestSignal,
  InvocationEvent,
  SignalRole,
  SkillPlatform,
  SourceWeight,
  TrajectoryEvent,
  TrajectoryRef,
} from "./types.js";

/**
 * 迁移期 System_User 固定身份（A3 per-user 隔离式之前的兜底贡献者）。
 * 与 requirements A3 一致：`local`，UUID 全零。
 */
export const SYSTEM_USER_LOCAL = "00000000-0000-0000-0000-000000000000";

/** 合法信号角色集合（Entry_Gate (a)：来自被识别的有效信号角色）。 */
const VALID_SIGNAL_ROLES: ReadonlySet<SignalRole> = new Set<SignalRole>([
  "truth_gate",
  "executable_seed",
  "soft_seed",
]);

/**
 * Entry_Gate 隐私闸模式（零 LLM 的廉价匹配）：凡 `source_tool` 或 payload 键命中任一模式，
 * 即视为来自 `understand_user`/userModel/对具体主人的个人 beliefs，拒绝采集（Req 2.7/16.1）。
 * 仅匹配"对特定主人的理解"，不误伤可泛化的方法/步骤/命令信号。
 */
const PRIVACY_SOURCE_PATTERNS: RegExp[] = [
  /understand_?user/i, // understand_user / understandUser
  /user_?model/i, // userModel / user_model
  /add_?belief/i, // add_belief（写入对主人的判断）
  /\bbeliefs?\b/i, // belief / beliefs（对主人的判断）
  /\bpersona\b/i, // persona（人物画像）
  /user_?profile/i, // userProfile / user_profile
  /owner_?(profile|note|trait|belief|preference)/i, // 对具体主人的画像/偏好
  /personal_?(trait|note|preference|belief|profile)/i, // 个人特质/偏好/理解
];

/** 判断一个标识串（工具名 / 字段键）是否属于"对具体主人的个人理解"来源。 */
function isPrivacyToken(token: string): boolean {
  return PRIVACY_SOURCE_PATTERNS.some((re) => re.test(token));
}

/**
 * Entry_Gate 隐私闸判定（零 LLM）：检查信号是否来自隐私来源（understand_user/userModel/
 * 个人 beliefs）。命中即应丢弃，不入队、不送管线（Req 2.7/16.1）。
 * 仅做廉价的来源工具名 + payload 浅层键匹配，不读取/不发送任何敏感值。
 */
export function isPrivacySignal(sig: HarvestSignal): boolean {
  if (isPrivacyToken(sig.source_tool ?? "")) return true;
  // payload 浅层键扫描（防御性）：仅看键名，不看值，避免把个人理解夹带入队。
  const payload = sig.payload ?? {};
  for (const key of Object.keys(payload)) {
    if (isPrivacyToken(key)) return true;
  }
  return false;
}

/** 任务线日志条目（finish_task 的 `cur.log` 单条，整形为 trajectory_event 原料）。 */
export interface LogEntry {
  /** 动作名（executeTool 的工具名）。 */
  action_name: string;
  /** 入参摘要。 */
  args_summary?: string;
  /** 结果摘要。 */
  result_summary?: string;
  /** 呼吸循环周期号。 */
  cycle?: number;
}

/**
 * 采集上下文：便携式方法（onVerifyPassed / onPredictionSettled / stashTrajectory）写库
 * 所必需的归属信息。`skill_harvest_queue.contributor_id` 为 NOT NULL UUID，故必须显式提供。
 */
export interface HarvestContext {
  /** 贡献者 userId（A3 per-user，迁移期可用 `SYSTEM_USER_LOCAL`）。 */
  contributor_id: string;
  /** 来源权重（Req 2.8）：user_task（优先）/ autonomous（降权）。 */
  source_weight: SourceWeight;
  /** 任务线 id（cur.id，用于轨迹关联，任务 10.2）。 */
  task_id?: string;
}

/** Harvester 对外接口（零 LLM，只做廉价入队 / 落轨迹 / 记调用事件）。 */
export interface Harvester {
  /** 通用入队：信号经 Entry_Gate 隐私闸后写入 `skill_harvest_queue`，返回是否已入队。 */
  enqueue(sig: HarvestSignal): Promise<boolean>;
  /** verify_task passed → truth_gate 信号入队（带 linked_verifiable_id + 证据/轨迹引用）。 */
  onVerifyPassed(
    verifiableId: string,
    evidence: string,
    trajectory: TrajectoryRef,
    ctx: HarvestContext,
  ): Promise<void>;
  /** settle_prediction 结算 → hit 入队为 truth_gate；miss 不入队为成功信号（Req 2.6 同理）。 */
  onPredictionSettled(
    predictionId: string,
    result: "hit" | "miss",
    outcome: string,
    ctx: HarvestContext,
  ): Promise<void>;
  /** finish_task done：仅把 cur.log 作为轨迹原料落库，**不入队为成功信号**（Req 2.6）。 */
  stashTrajectory(
    taskId: string,
    log: LogEntry[],
    goal: string,
    result: string,
    ctx: HarvestContext,
  ): Promise<void>;
  /** 每次 executeTool 维护环形缓冲（复用任务 9 的 trajectoryBuffer，Req 3.2）。 */
  recordAction(ev: TrajectoryEvent): Promise<void>;
  /** 调用到可追溯的已知技能/命令时记一条调用事件（反向点亮 + 静默检测，Req 2.9）。 */
  recordInvocation(ev: InvocationEvent): Promise<void>;
}

/** 最小化 query 抽象（与 `src/db/pool.ts` 的 `query` 结构兼容，便于单测注入桩）。 */
export type HarvestQueryFn = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

/** Harvester 依赖（全部可选，默认走真实 PG + 默认轨迹缓冲）。 */
export interface HarvesterDeps {
  /** 系统级 query；默认 `src/db/pool.ts` 的 `query`（用于队列/调用事件等无 RLS 表）。 */
  query?: HarvestQueryFn;
  /** 轨迹环形缓冲；默认 `createTrajectoryBuffer()`（任务 9，内部经 withUser 写 trajectory_event）。 */
  trajectory?: TrajectoryBuffer;
  /** 异常日志回调；默认 `console.warn`。所有 hook 吞错后经此记日志，绝不向上抛。 */
  onError?: (where: string, err: unknown) => void;
}

/**
 * 创建 Harvester 实例。
 * @param deps 可选依赖；不传则默认走真实 PG（`query`）+ 默认轨迹缓冲。
 */
export function createHarvester(deps: HarvesterDeps = {}): Harvester {
  const query: HarvestQueryFn =
    deps.query ?? (defaultQuery as unknown as HarvestQueryFn);
  const trajectory = deps.trajectory ?? createTrajectoryBuffer();
  const onError =
    deps.onError ??
    ((where: string, err: unknown) => {
      // 采集路径吞错不破坏主链（A4）：仅记日志。
      console.warn(
        `[Harvester] ${where} 失败（已吞错不影响主链）：`,
        err instanceof Error ? err.message : String(err),
      );
    });

  /**
   * 真正的入队写库（无 Entry_Gate 判定，由 `enqueue` 在外层先过闸）。
   * payload 以 JSONB 落库。
   */
  async function insertSignal(sig: HarvestSignal): Promise<void> {
    await query(
      `INSERT INTO skill_harvest_queue
         (signal_role, source_tool, source_weight, contributor_id, payload,
          linked_prediction_id, linked_verifiable_id, task_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [
        sig.signal_role,
        sig.source_tool,
        sig.source_weight,
        sig.contributor_id,
        JSON.stringify(sig.payload ?? {}),
        sig.linked_prediction_id ?? null,
        sig.linked_verifiable_id ?? null,
        sig.task_id ?? null,
      ],
    );
  }

  /**
   * 入队闸 + 写库（独立函数，避免依赖 `this`，便于便携式方法内部直接调用）。
   * 返回是否已成功入队（被 Entry_Gate 拦下或异常时返回 false，不抛出）。
   */
  async function enqueueImpl(sig: HarvestSignal): Promise<boolean> {
    try {
      // Entry_Gate (a)：来自被识别的有效信号角色（Req 16.1）。
      if (!VALID_SIGNAL_ROLES.has(sig.signal_role)) {
        onError("enqueue", new Error(`无效 signal_role=${String(sig.signal_role)}，拒绝入队`));
        return false;
      }
      // Entry_Gate (d)：已标注 Source_Weight（Req 2.8 / 16.1）。
      if (sig.source_weight !== "user_task" && sig.source_weight !== "autonomous") {
        onError("enqueue", new Error(`缺失/非法 source_weight，拒绝入队`));
        return false;
      }
      // contributor_id 为 NOT NULL UUID，缺失则无法落库。
      if (!sig.contributor_id) {
        onError("enqueue", new Error(`缺失 contributor_id，拒绝入队`));
        return false;
      }
      // Entry_Gate (b)：隐私闸——来自 understand_user/userModel/个人 beliefs 一律丢弃（Req 2.7/16.1）。
      if (isPrivacySignal(sig)) {
        // 静默丢弃（这是预期内的隐私保护行为，不算异常，但记一条日志便于审计）。
        onError(
          "enqueue.entryGate",
          new Error(`Entry_Gate 隐私闸丢弃来源信号 source_tool=${sig.source_tool}`),
        );
        return false;
      }
      await insertSignal(sig);
      return true;
    } catch (err) {
      onError("enqueue", err);
      return false;
    }
  }

  return {
    enqueue(sig: HarvestSignal): Promise<boolean> {
      return enqueueImpl(sig);
    },

    async onVerifyPassed(
      verifiableId: string,
      evidence: string,
      trajectoryRef: TrajectoryRef,
      ctx: HarvestContext,
    ): Promise<void> {
      try {
        // verify_task passed → truth_gate 信号（带可验证任务关联 + 证据/轨迹引用）。
        await enqueueImpl({
          signal_role: "truth_gate",
          source_tool: "verify_task",
          source_weight: ctx.source_weight,
          contributor_id: ctx.contributor_id,
          payload: { evidence, trajectory_ref: trajectoryRef },
          linked_verifiable_id: verifiableId,
          task_id: ctx.task_id ?? trajectoryRef?.task_id,
        });
      } catch (err) {
        onError("onVerifyPassed", err);
      }
    },

    async onPredictionSettled(
      predictionId: string,
      result: "hit" | "miss",
      outcome: string,
      ctx: HarvestContext,
    ): Promise<void> {
      try {
        // 仅 hit 入队为 truth_gate 成功信号；miss 不入队（不把失败当成功信号）。
        if (result !== "hit") return;
        await enqueueImpl({
          signal_role: "truth_gate",
          source_tool: "settle_prediction",
          source_weight: ctx.source_weight,
          contributor_id: ctx.contributor_id,
          payload: { outcome },
          linked_prediction_id: predictionId,
          task_id: ctx.task_id,
        });
      } catch (err) {
        onError("onPredictionSettled", err);
      }
    },

    async stashTrajectory(
      taskId: string,
      log: LogEntry[],
      goal: string,
      result: string,
      ctx: HarvestContext,
    ): Promise<void> {
      try {
        // Req 2.6：finish_task done 仅把 cur.log 作为轨迹原料采集，
        // 绝不入队为成功信号、绝不把 done 当质量闸。
        // 任务 10.2：任务线内用 cur.id(taskId) 关联 cur.log，逐条落 trajectory_event（环形缓冲）。
        const entries = Array.isArray(log) ? log : [];
        for (const e of entries) {
          await trajectory.recordAction({
            user_id: ctx.contributor_id,
            cycle: e.cycle,
            task_id: taskId,
            action_name: e.action_name,
            args_summary: e.args_summary,
            result_summary: e.result_summary,
          });
        }
        // 追加一条任务收尾摘要轨迹（goal/result），便于蒸馏阶段还原任务意图与结局。
        await trajectory.recordAction({
          user_id: ctx.contributor_id,
          task_id: taskId,
          action_name: "finish_task",
          args_summary: goal,
          result_summary: result,
        });
      } catch (err) {
        onError("stashTrajectory", err);
      }
    },

    async recordAction(ev: TrajectoryEvent): Promise<void> {
      try {
        // 复用任务 9 的环形缓冲（append-only），维护最近 N 条轨迹（Req 3.2）。
        await trajectory.recordAction(ev);
      } catch (err) {
        onError("recordAction", err);
      }
    },

    async recordInvocation(ev: InvocationEvent): Promise<void> {
      try {
        // 调用可追溯到 Skill_Candidate / Public_Skill 的命令/技能 → 记调用事件（Req 2.9）。
        // 同时服务于 master_tool 候选的反向点亮（Req 9.10）与静默继承检测（Req 12）。
        const platform: SkillPlatform | null = ev.platform ?? null;
        await query(
          `INSERT INTO skill_invocation_event
             (user_id, skill_id, candidate_id, command_fingerprint, task_id, platform, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ev.user_id,
            ev.skill_id ?? null,
            ev.candidate_id ?? null,
            ev.command_fingerprint ?? null,
            ev.task_id ?? null,
            platform,
            ev.outcome ?? "pending",
          ],
        );
      } catch (err) {
        onError("recordInvocation", err);
      }
    },
  };
}

// ── 默认实例（绑定真实 PG）：供生产代码（riverMain hook，任务 11）直接调用 ──

const defaultHarvester = createHarvester();

/** 通用入队（默认实例，走真实 PG）。 */
export function enqueue(sig: HarvestSignal): Promise<boolean> {
  return defaultHarvester.enqueue(sig);
}

/** verify_task passed → truth_gate 入队（默认实例）。 */
export function onVerifyPassed(
  verifiableId: string,
  evidence: string,
  trajectory: TrajectoryRef,
  ctx: HarvestContext,
): Promise<void> {
  return defaultHarvester.onVerifyPassed(verifiableId, evidence, trajectory, ctx);
}

/** settle_prediction 结算 → hit 入队（默认实例）。 */
export function onPredictionSettled(
  predictionId: string,
  result: "hit" | "miss",
  outcome: string,
  ctx: HarvestContext,
): Promise<void> {
  return defaultHarvester.onPredictionSettled(predictionId, result, outcome, ctx);
}

/** finish_task done → 仅落轨迹（默认实例）。 */
export function stashTrajectory(
  taskId: string,
  log: LogEntry[],
  goal: string,
  result: string,
  ctx: HarvestContext,
): Promise<void> {
  return defaultHarvester.stashTrajectory(taskId, log, goal, result, ctx);
}

/** 维护环形缓冲（默认实例）。 */
export function recordAction(ev: TrajectoryEvent): Promise<void> {
  return defaultHarvester.recordAction(ev);
}

/** 记技能/命令调用事件（默认实例）。 */
export function recordInvocation(ev: InvocationEvent): Promise<void> {
  return defaultHarvester.recordInvocation(ev);
}
