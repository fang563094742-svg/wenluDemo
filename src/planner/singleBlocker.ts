export type PlannerItemStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PlannerItem {
  id: string;
  title: string;
  status: PlannerItemStatus;
  priority?: number;
  blockedBy?: ReadonlyArray<string>;
  evidence?: string;
}

export interface ShrinkPlanInput {
  goal: string;
  items: ReadonlyArray<PlannerItem>;
}

export interface ShrinkPlanResult {
  goal: string;
  highestPriorityReady: PlannerItem | null;
  uniqueBlocker: PlannerItem | null;
  nextAction: string;
  reasoning: string[];
}

function priorityValue(item: PlannerItem): number {
  return item.priority ?? 0;
}

function sortByPriorityThenId(items: ReadonlyArray<PlannerItem>): PlannerItem[] {
  return [...items].sort((a, b) => {
    const pa = priorityValue(a);
    const pb = priorityValue(b);
    if (pa !== pb) return pb - pa;
    return a.id.localeCompare(b.id);
  });
}

function toSet(values?: ReadonlyArray<string>): Set<string> {
  return new Set(values ?? []);
}

function buildItemIndex(items: ReadonlyArray<PlannerItem>): Map<string, PlannerItem> {
  return new Map(items.map(item => [item.id, item]));
}

function collectOutstandingDeps(item: PlannerItem, doneIds: ReadonlySet<string>): string[] {
  return [...toSet(item.blockedBy)].filter(dep => !doneIds.has(dep));
}

function findRootBlocker(
  item: PlannerItem,
  itemIndex: ReadonlyMap<string, PlannerItem>,
  doneIds: ReadonlySet<string>,
  visiting = new Set<string>()
): PlannerItem {
  const unresolvedDeps = collectOutstandingDeps(item, doneIds);
  if (unresolvedDeps.length === 0) return item;
  const nextDepId = unresolvedDeps[0];
  if (visiting.has(nextDepId)) return item;
  const nextDep = itemIndex.get(nextDepId);
  if (!nextDep) return item;
  visiting.add(item.id);
  return findRootBlocker(nextDep, itemIndex, doneIds, visiting);
}

export function shrinkToSingleBlocker(input: ShrinkPlanInput): ShrinkPlanResult {
  const ordered = sortByPriorityThenId(input.items);
  const itemIndex = buildItemIndex(ordered);
  const doneIds = new Set(ordered.filter(i => i.status === "done").map(i => i.id));

  const pendingOrActive = ordered.filter(
    i => i.status === "pending" || i.status === "in_progress"
  );

  const ready = pendingOrActive.filter(item => collectOutstandingDeps(item, doneIds).length === 0);
  const highestPriorityReady = ready.length > 0 ? ready[0] : null;

  const blockerRoots = new Map<string, PlannerItem>();
  if (!highestPriorityReady) {
    for (const item of ordered) {
      const hasOutstandingDeps = collectOutstandingDeps(item, doneIds).length > 0;
      if (item.status !== "blocked" && !hasOutstandingDeps) continue;
      const root = findRootBlocker(item, itemIndex, doneIds);
      blockerRoots.set(root.id, root);
    }
  }

  const blockedCandidates = sortByPriorityThenId([...blockerRoots.values()]).filter(
    item => item.status !== "done"
  );

  const uniqueBlocker = blockedCandidates.length > 0 ? blockedCandidates[0] : null;

  const reasoning: string[] = [];
  reasoning.push(`总项数=${ordered.length}`);
  reasoning.push(`就绪项=${ready.length}`);
  reasoning.push(`阻塞根=${blockedCandidates.length}`);

  let nextAction = "没有可执行项，先补充任务分解";
  if (highestPriorityReady) {
    nextAction = `执行最高优先级就绪项：${highestPriorityReady.title}`;
    reasoning.push(`选择最高优先级就绪项 ${highestPriorityReady.id}`);
  } else if (uniqueBlocker) {
    nextAction = `只解决阻塞：${uniqueBlocker.title}`;
    reasoning.push(`收缩到唯一阻塞 ${uniqueBlocker.id}`);
  }

  return {
    goal: input.goal,
    highestPriorityReady,
    uniqueBlocker,
    nextAction,
    reasoning,
  };
}
