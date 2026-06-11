/**
 * MemoryStore —— 跨会话记忆持久化与偏好学习。
 *
 * 存储位置：项目本地数据目录下的 memory.json
 * 纯 JSON 文件，无数据库依赖。每次会话结束时保存。
 *
 * 记忆内容：
 *  - 基础画像（首次使用时间、交互次数）
 *  - 项目频率画像（哪些项目最活跃）
 *  - 交互偏好（自动推断：确认速度、详略偏好、风险容忍度）
 *  - 洞察历史（系统说了什么、用户是否接受、命中率追踪）
 *  - 上次扫描快照（用于 delta 对比）
 */

import { promises as fs } from "node:fs";
import type { ScanSnapshot } from "../scanner/deepScan.js";
import { getWenluDataDir, resolveWenluDataPath } from "../runtime/localDataDir.js";

// ===========================================================================
// 类型
// ===========================================================================

/** 单条洞察记录。 */
export interface InsightRecord {
  date: string;
  /** 系统说的核心洞察（一句话摘要）。 */
  what: string;
  /** 用户是否接受/确认了这个洞察。 */
  hit: boolean;
  /** 执行了什么行动（若有）。 */
  actionTaken?: string;
  /** 行动结果。 */
  actionResult?: "success" | "failure";
}

/** 项目画像。 */
export interface ProjectProfile {
  /** 项目路径。 */
  path: string;
  /** 近 30 天内被扫描到的次数（每次会话+1）。 */
  seenCount: number;
  /** 最后一次交互时间。 */
  lastSeenAt: string;
  /** 上次主分支名。 */
  lastBranch: string;
}

/** 交互偏好（自动推断，不问用户）。 */
export interface UserStyle {
  /** 用户倾向快速确认还是仔细审查。 */
  confirmSpeed: "instant" | "considered" | "unknown";
  /** 用户回复长度偏好。 */
  verbosity: "brief" | "normal" | "unknown";
  /** 用户对高危操作的态度。 */
  riskTolerance: "cautious" | "bold" | "unknown";
}

/** 完整记忆结构。 */
export interface WenluMemory {
  /** 首次使用时间。 */
  firstSeenAt: string;
  /** 总交互次数（每次会话结束 +1）。 */
  interactionCount: number;
  /** 项目频率画像。 */
  projects: ProjectProfile[];
  /** 交互偏好。 */
  style: UserStyle;
  /** 洞察历史（最多保留 50 条）。 */
  insights: InsightRecord[];
  /** 上次扫描快照。 */
  lastScan: ScanSnapshot | null;
  /** 对话历史（交融的基础）。 */
  conversations?: Array<{ date: string; role: string; text: string }>;
}

// ===========================================================================
// 路径
// ===========================================================================

const WENLU_DIR = getWenluDataDir();
const MEMORY_FILE = resolveWenluDataPath("memory.json");

// ===========================================================================
// 加载 / 保存
// ===========================================================================

/**
 * 加载记忆。文件不存在或解析失败时抛错（调用方应兜底为默认值）。
 */
export async function loadMemory(): Promise<WenluMemory> {
  const raw = await fs.readFile(MEMORY_FILE, "utf-8");
  const parsed = JSON.parse(raw) as WenluMemory;
  // 向前兼容：补全可能缺失的新字段
  if (!parsed.projects) parsed.projects = [];
  if (!parsed.style) parsed.style = { confirmSpeed: "unknown", verbosity: "unknown", riskTolerance: "unknown" };
  if (!parsed.insights) parsed.insights = [];
  return parsed;
}

/**
 * 保存记忆到项目本地数据目录。自动创建目录。
 */
export async function saveMemory(memory: WenluMemory): Promise<void> {
  await fs.mkdir(WENLU_DIR, { recursive: true });
  // 洞察历史裁剪：最多保留 50 条
  if (memory.insights.length > 50) {
    memory.insights = memory.insights.slice(-50);
  }
  const json = JSON.stringify(memory, null, 2);
  await fs.writeFile(MEMORY_FILE, json, "utf-8");
}

/**
 * 创建默认记忆（首次使用）。
 */
export function createDefaultMemory(): WenluMemory {
  return {
    firstSeenAt: new Date().toISOString(),
    interactionCount: 0,
    projects: [],
    style: { confirmSpeed: "unknown", verbosity: "unknown", riskTolerance: "unknown" },
    insights: [],
    lastScan: null,
  };
}

/**
 * 获取记忆文件路径（供诊断使用）。
 */
export function getMemoryPath(): string {
  return MEMORY_FILE;
}

// ===========================================================================
// 偏好学习
// ===========================================================================

/**
 * 根据用户回复推断并更新交互偏好。
 *
 * @param memory 当前记忆（就地修改）
 * @param replyText 用户回复文本
 * @param replyDelayMs 用户从看到系统消息到发出回复的时间（毫秒，-1=未知）
 * @param wasHighRisk 是否涉及高危确认
 * @param riskDecision 高危确认的决定（"confirm"/"reject"/null=非高危场景）
 */
export function updateStyleFromInteraction(
  memory: WenluMemory,
  replyText: string,
  replyDelayMs: number,
  wasHighRisk: boolean,
  riskDecision: "confirm" | "reject" | null,
): void {
  // 确认速度推断（基于回复时长和文本长度）
  if (replyDelayMs > 0) {
    if (replyDelayMs < 3000 && replyText.length < 10) {
      // 很快+很短 → instant
      memory.style.confirmSpeed = memory.style.confirmSpeed === "unknown"
        ? "instant"
        : memory.style.confirmSpeed; // 保守：不从 considered 覆盖回 instant
    } else if (replyDelayMs > 15000 || replyText.length > 100) {
      memory.style.confirmSpeed = "considered";
    }
  }

  // 详略偏好
  if (replyText.length > 80) {
    memory.style.verbosity = "normal";
  } else if (replyText.length <= 5 && memory.style.verbosity === "unknown") {
    memory.style.verbosity = "brief";
  }

  // 风险容忍度
  if (wasHighRisk && riskDecision) {
    memory.style.riskTolerance = riskDecision === "confirm" ? "bold" : "cautious";
  }
}

/**
 * 更新项目画像：把本次扫描看到的项目纳入记忆。
 */
export function updateProjectProfiles(
  memory: WenluMemory,
  snapshot: ScanSnapshot,
): void {
  const now = new Date().toISOString();
  const existingMap = new Map(memory.projects.map((p) => [p.path, p]));

  for (const proj of snapshot.topProjects) {
    const existing = existingMap.get(proj.path);
    if (existing) {
      existing.seenCount += 1;
      existing.lastSeenAt = now;
      existing.lastBranch = proj.branch;
    } else {
      memory.projects.push({
        path: proj.path,
        seenCount: 1,
        lastSeenAt: now,
        lastBranch: proj.branch,
      });
    }
  }

  // 按活跃度排序，最多保留 20 个项目
  memory.projects.sort((a, b) => b.seenCount - a.seenCount);
  if (memory.projects.length > 20) {
    memory.projects = memory.projects.slice(0, 20);
  }
}

/**
 * 记录一次洞察命中/失败。
 */
export function recordInsight(
  memory: WenluMemory,
  what: string,
  hit: boolean,
  actionTaken?: string,
  actionResult?: "success" | "failure",
): void {
  memory.insights.push({
    date: new Date().toISOString(),
    what,
    hit,
    actionTaken,
    actionResult,
  });
}

/**
 * 计算近期洞察命中率（最近 10 条）。
 */
export function getRecentHitRate(memory: WenluMemory): number {
  const recent = memory.insights.slice(-10);
  if (recent.length === 0) return 0.5; // 无数据时假设 50%
  const hits = recent.filter((i) => i.hit).length;
  return hits / recent.length;
}

