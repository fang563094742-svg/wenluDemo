export interface TasklineCandidate {
  id: string;
  title: string;
  status?: "pending" | "blocked" | "in_progress" | "done";
  priority?: number;
  blocker?: string | null;
  unblockCost?: number;
  updatedAt?: string | null;
  evidence?: string | null;
  waitType?: "opponent_moved" | "external_signal" | "window_state" | "http_callback" | "file_appears" | null;
}

export interface TasklinePlan {
  focusMode: "single_blocker" | "execute_ready" | "all_clear" | "need_evidence" | "wait_external";
  chosenId: string | null;
  chosenTitle: string | null;
  blocker: string | null;
  nextStep: string;
  deferredIds: string[];
  reasoning: string[];
}

export interface TasklineExecutionPolicy {
  taskBreakdown: string[];
  priorityRule: string;
  nextStepRule: string;
  stopRule: string;
}

export interface TasklineDecision {
  plan: TasklinePlan;
  policy: TasklineExecutionPolicy;
}

const TASK_BREAKDOWN = [
  "capture_context",
  "identify_active_blocker",
  "take_next_action",
  "verify_effect",
  "archive_or_handoff",
];

const PRIORITY_RULE = "clarify_context > unblock_prerequisite > cheapest_direct_relief > verify_after_action";
const NEXT_STEP_RULE = "只输出一个直接减阻动作";
const STOP_RULE = "连续两轮无新证据或 blocker 未缩小，则停止发散并改为补证据/重写 blocker/切换能力修补";

function safeFreshness(updatedAt?: string | null): number {
  const parsed = updatedAt ? Date.parse(updatedAt) : 0;
  return Number.isFinite(parsed) ? parsed / 1_000_000_000_000 : 0;
}

function hasEvidence(candidate: TasklineCandidate): boolean {
  return Boolean(candidate.evidence?.trim());
}

function isExternalWaitCandidate(candidate: TasklineCandidate): boolean {
  return candidate.status === "blocked" && candidate.waitType != null && hasEvidence(candidate);
}

function scoreBlockedCandidate(candidate: TasklineCandidate): number {
  const priority = candidate.priority ?? 50;
  const unblockCost = candidate.unblockCost ?? 100;

  let score = priority * 100;
  score += 10_000;
  if (candidate.blocker?.trim()) score += 3_000;
  if (candidate.status === "blocked") score += 500;
  if (hasEvidence(candidate)) score += 200;
  score -= unblockCost * 10;
  score += safeFreshness(candidate.updatedAt);
  return score;
}

function scoreReadyCandidate(candidate: TasklineCandidate): number {
  const priority = candidate.priority ?? 50;
  const unblockCost = candidate.unblockCost ?? 100;

  let score = priority * 100;
  if (candidate.status === "in_progress") score += 1_500;
  if (candidate.status === "pending") score += 1_000;
  if (hasEvidence(candidate)) score += 300;
  score -= unblockCost * 10;
  score += safeFreshness(candidate.updatedAt);
  return score;
}

function chooseSingleBlocker(candidates: TasklineCandidate[]): TasklineCandidate {
  return candidates.slice().sort((a, b) => scoreBlockedCandidate(b) - scoreBlockedCandidate(a))[0];
}

function chooseSingleReady(candidates: TasklineCandidate[]): TasklineCandidate {
  return candidates.slice().sort((a, b) => scoreReadyCandidate(b) - scoreReadyCandidate(a))[0];
}

function chooseSingleEvidenceNeed(candidates: TasklineCandidate[]): TasklineCandidate {
  return candidates.slice().sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pb !== pa) return pb - pa;
    return safeFreshness(b.updatedAt) - safeFreshness(a.updatedAt);
  })[0];
}

function chooseExternalWait(candidates: TasklineCandidate[]): TasklineCandidate {
  return candidates.slice().sort((a, b) => scoreBlockedCandidate(b) - scoreBlockedCandidate(a))[0];
}

export function shrinkTasklineToSingleBlocker(candidates: TasklineCandidate[]): TasklinePlan {
  if (candidates.length === 0) {
    return {
      focusMode: "all_clear",
      chosenId: null,
      chosenTitle: null,
      blocker: null,
      nextStep: "no-op",
      deferredIds: [],
      reasoning: ["没有候选任务，无需拆解"],
    };
  }

  const active = candidates.filter((candidate) => candidate.status !== "done");
  if (active.length === 0) {
    return {
      focusMode: "all_clear",
      chosenId: null,
      chosenTitle: null,
      blocker: null,
      nextStep: "全部候选已完成，转入验收或收口",
      deferredIds: [],
      reasoning: ["所有候选都已 done，不再发散创建新任务"],
    };
  }

  const evidenceNeeded = active.filter(
    (candidate) =>
      (candidate.status === "blocked" || candidate.status === "in_progress") && !hasEvidence(candidate)
  );
  if (evidenceNeeded.length > 0) {
    const chosen = chooseSingleEvidenceNeed(evidenceNeeded);
    return {
      focusMode: "need_evidence",
      chosenId: chosen.id,
      chosenTitle: chosen.title,
      blocker: chosen.blocker?.trim() || "缺少现场证据，无法判断唯一下一步",
      nextStep: `先补证据：${chosen.title}`,
      deferredIds: active.filter((candidate) => candidate.id !== chosen.id).map((candidate) => candidate.id),
      reasoning: [
        `发现 ${evidenceNeeded.length} 个活跃项缺少证据，先停止继续发散`,
        `优先给「${chosen.title}」补现场证据，再决定是解阻还是执行`,
      ],
    };
  }

  const externalWaitCandidates = active.filter(isExternalWaitCandidate);
  if (externalWaitCandidates.length > 0) {
    const chosen = chooseExternalWait(externalWaitCandidates);
    return {
      focusMode: "wait_external",
      chosenId: chosen.id,
      chosenTitle: chosen.title,
      blocker: chosen.blocker?.trim() || null,
      nextStep: `等待外部事件：${chosen.title}`,
      deferredIds: active.filter((candidate) => candidate.id !== chosen.id).map((candidate) => candidate.id),
      reasoning: [
        `发现 ${externalWaitCandidates.length} 个已留证的外部等待型阻塞`,
        `当前最优动作不是继续扩张，而是围绕「${chosen.title}」进入等待或轮询`,
      ],
    };
  }

  const blockers = active.filter((candidate) => candidate.status === "blocked");
  if (blockers.length > 0) {
    const chosen = chooseSingleBlocker(blockers);
    return {
      focusMode: "single_blocker",
      chosenId: chosen.id,
      chosenTitle: chosen.title,
      blocker: chosen.blocker?.trim() || chosen.title,
      nextStep: chosen.blocker?.trim() ? `只解一个阻塞：${chosen.blocker.trim()}` : `只解一个阻塞：${chosen.title}`,
      deferredIds: active.filter((candidate) => candidate.id !== chosen.id).map((candidate) => candidate.id),
      reasoning: [
        `存在 ${blockers.length} 个 blocker，按 priority / unblockCost / freshness 收缩为唯一焦点`,
        `选择「${chosen.title}」作为当前唯一阻塞，其余全部 defer`,
      ],
    };
  }

  const ready = active.filter(
    (candidate) => candidate.status === "pending" || candidate.status === "in_progress" || candidate.status == null
  );
  if (ready.length > 0) {
    const chosen = chooseSingleReady(ready);
    return {
      focusMode: "execute_ready",
      chosenId: chosen.id,
      chosenTitle: chosen.title,
      blocker: null,
      nextStep: `执行唯一就绪项：${chosen.title}`,
      deferredIds: active.filter((candidate) => candidate.id !== chosen.id).map((candidate) => candidate.id),
      reasoning: [
        `当前没有 blocker，按 priority / status / evidence 收缩到唯一 ready`,
        `选择「${chosen.title}」推进，其他候选延后，避免并行扩张`,
      ],
    };
  }

  return {
    focusMode: "all_clear",
    chosenId: null,
    chosenTitle: null,
    blocker: null,
    nextStep: "全部候选已清空，准备收口",
    deferredIds: [],
    reasoning: ["活跃项已耗尽，无需继续规划"],
  };
}

export function decideTasklineNextStep(candidates: TasklineCandidate[]): TasklineDecision {
  return {
    plan: shrinkTasklineToSingleBlocker(candidates),
    policy: {
      taskBreakdown: TASK_BREAKDOWN,
      priorityRule: PRIORITY_RULE,
      nextStepRule: NEXT_STEP_RULE,
      stopRule: STOP_RULE,
    },
  };
}
