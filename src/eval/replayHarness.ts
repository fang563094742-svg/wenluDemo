/**
 * replayHarness.ts — 离线评测回放底座。
 *
 * 解决的问题：没有固定评测集，就无法证明任何机制改进真的更好。
 * 快路径、元反思、pipeline、typed composer——任何改变 agent 行为分布的机制，
 * 都必须先有外部判官，否则不是进化，是自我催眠。
 *
 * 设计：
 * 1. 录制模式：正常运行时录制 (input, decision, output) 三元组序列
 * 2. 回放模式：用录制的 input 驱动被测机制，对比其 decision 与历史
 * 3. Benchmark 模式：固定任务集 + 标准评分
 *
 * 不做 Event Sourcing 那种完整重建——只做"给相同输入，对比行为差异"。
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";

// ═══════════════════════════════════════════════════════════════════════
// 录制格式
// ═══════════════════════════════════════════════════════════════════════

export interface RecordedFrame {
  frameId: string;
  timestamp: string;
  cycle: number;

  // 输入快照（给 decide/reflect 的上下文）
  input: {
    context: string;          // 当时编译的上下文（compiledContext.prompt）
    availableTools: string[]; // 当时的可用工具列表
    recentLedger: unknown[];  // 最近 N 条 ledger entry
  };

  // 决策
  decision: {
    chosenTool: string;
    parameters: unknown;
    reasoning?: string;       // 如果 LLM 给了推理
  };

  // 结果
  outcome: {
    success: boolean;
    output: string;
    durationMs: number;
    sideEffects: string[];
  };
}

export interface Recording {
  id: string;
  startedAt: string;
  endedAt: string;
  agentVersion: number;       // 录制时的 agentState.version
  frames: RecordedFrame[];
  metadata: {
    totalCycles: number;
    toolDistribution: Record<string, number>;
    successRate: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Recorder（录制模式）
// ═══════════════════════════════════════════════════════════════════════

export interface Recorder {
  start(): void;
  recordFrame(frame: RecordedFrame): void;
  stop(): Recording;
  save(recording: Recording): Promise<string>;
}

export function createRecorder(baseDir: string): Recorder {
  let active = false;
  let frames: RecordedFrame[] = [];
  let startedAt = "";
  let recordingId = "";

  function start(): void {
    active = true;
    frames = [];
    startedAt = new Date().toISOString();
    recordingId = `rec_${Date.now().toString(36)}`;
  }

  function recordFrame(frame: RecordedFrame): void {
    if (!active) return;
    frames.push(frame);
  }

  function stop(): Recording {
    active = false;
    const endedAt = new Date().toISOString();

    // 计算元数据
    const toolDist: Record<string, number> = {};
    let successCount = 0;
    for (const frame of frames) {
      toolDist[frame.decision.chosenTool] = (toolDist[frame.decision.chosenTool] || 0) + 1;
      if (frame.outcome.success) successCount++;
    }

    return {
      id: recordingId,
      startedAt,
      endedAt,
      agentVersion: 0,
      frames,
      metadata: {
        totalCycles: frames.length,
        toolDistribution: toolDist,
        successRate: frames.length > 0 ? successCount / frames.length : 0,
      },
    };
  }

  async function save(recording: Recording): Promise<string> {
    const dir = join(baseDir, "recordings");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${recording.id}.json`);
    await writeFile(path, JSON.stringify(recording, null, 2));
    return path;
  }

  return { start, recordFrame, stop, save };
}

// ═══════════════════════════════════════════════════════════════════════
// Replay Engine（回放模式）
// ═══════════════════════════════════════════════════════════════════════

export interface ReplayResult {
  frameId: string;
  original: { tool: string; params: unknown };
  replayed: { tool: string; params: unknown };
  match: boolean;
  divergenceReason?: string;
}

export interface ReplayReport {
  recordingId: string;
  totalFrames: number;
  matchedFrames: number;
  divergedFrames: number;
  matchRate: number;
  divergences: ReplayResult[];
  improvementSignals: ImprovementSignal[];
}

export interface ImprovementSignal {
  kind: "better-tool-choice" | "worse-tool-choice" | "same-but-different-params" | "unknown";
  frameId: string;
  evidence: string;
}

export type DecideFunction = (context: string, tools: string[]) => Promise<{ tool: string; params: unknown }>;

export async function replayRecording(
  recording: Recording,
  decideFn: DecideFunction,
): Promise<ReplayReport> {
  const results: ReplayResult[] = [];

  for (const frame of recording.frames) {
    const replayed = await decideFn(frame.input.context, frame.input.availableTools);

    const match = replayed.tool === frame.decision.chosenTool;
    results.push({
      frameId: frame.frameId,
      original: { tool: frame.decision.chosenTool, params: frame.decision.parameters },
      replayed,
      match,
      divergenceReason: match ? undefined : `chose ${replayed.tool} instead of ${frame.decision.chosenTool}`,
    });
  }

  const matched = results.filter(r => r.match).length;
  const diverged = results.filter(r => !r.match);

  // 分析 divergence 是改进还是退化
  const signals: ImprovementSignal[] = diverged.map(d => {
    const originalFrame = recording.frames.find(f => f.frameId === d.frameId)!;
    if (!originalFrame.outcome.success && d.replayed.tool !== originalFrame.decision.chosenTool) {
      return { kind: "better-tool-choice" as const, frameId: d.frameId, evidence: "original failed, new choice differs" };
    }
    if (originalFrame.outcome.success && d.replayed.tool !== originalFrame.decision.chosenTool) {
      return { kind: "worse-tool-choice" as const, frameId: d.frameId, evidence: "original succeeded, new choice differs" };
    }
    return { kind: "same-but-different-params" as const, frameId: d.frameId, evidence: "same tool, different params" };
  });

  return {
    recordingId: recording.id,
    totalFrames: recording.frames.length,
    matchedFrames: matched,
    divergedFrames: diverged.length,
    matchRate: recording.frames.length > 0 ? matched / recording.frames.length : 1,
    divergences: diverged,
    improvementSignals: signals,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TaskBench（固定任务集 benchmark）
// ═══════════════════════════════════════════════════════════════════════

export interface BenchmarkTask {
  id: string;
  description: string;
  category: "file-ops" | "search" | "web" | "build" | "compose" | "multi-step" | "reasoning";

  // 给 agent 的起始上下文
  initialContext: string;

  // 评分标准
  scoring: {
    maxSteps: number;        // 超过此步数 = 效率问题
    requiredTools: string[]; // 至少要用到这些工具
    forbiddenTools: string[];// 不应该用这些
    successAssertions: BenchAssertion[];
  };
}

export interface BenchAssertion {
  kind: "file-exists" | "file-contains" | "output-matches" | "no-errors" | "within-time";
  value: string | number;
}

export interface BenchmarkRun {
  taskId: string;
  startedAt: string;
  endedAt: string;
  steps: RecordedFrame[];
  score: BenchmarkScore;
}

export interface BenchmarkScore {
  passed: boolean;
  efficiency: number;      // 0-1, 越少步完成越高
  correctness: number;     // 0-1, assertions 通过比例
  toolChoice: number;      // 0-1, 用了合适工具的比例
  overall: number;         // 加权综合分
}

export interface BenchmarkSuite {
  id: string;
  name: string;
  tasks: BenchmarkTask[];
}

// 内置基础 benchmark 任务集
export const CORE_BENCHMARK: BenchmarkSuite = {
  id: "core-v1",
  name: "Core Capability Benchmark v1",
  tasks: [
    {
      id: "file-read-summarize",
      description: "Read a known file and extract key information",
      category: "file-ops",
      initialContext: "Read the file at ./test-data/sample.txt and report how many lines it has.",
      scoring: {
        maxSteps: 3,
        requiredTools: ["read_file"],
        forbiddenTools: [],
        successAssertions: [{ kind: "no-errors", value: "" }],
      },
    },
    {
      id: "search-and-act",
      description: "Search for information then take action based on results",
      category: "search",
      initialContext: "Find all .ts files in the project that import 'lodash'.",
      scoring: {
        maxSteps: 5,
        requiredTools: ["execute_command"],
        forbiddenTools: ["web_search"],
        successAssertions: [{ kind: "output-matches", value: "\\.ts" }],
      },
    },
    {
      id: "multi-step-file-transform",
      description: "Read file, transform content, write new file",
      category: "multi-step",
      initialContext: "Read ./input.json, add a 'timestamp' field with current ISO time, write to ./output.json.",
      scoring: {
        maxSteps: 5,
        requiredTools: ["read_file", "write_file"],
        forbiddenTools: [],
        successAssertions: [
          { kind: "file-exists", value: "./output.json" },
          { kind: "file-contains", value: "timestamp" },
        ],
      },
    },
    {
      id: "error-recovery",
      description: "Attempt an action that fails, then recover gracefully",
      category: "reasoning",
      initialContext: "Try to read ./nonexistent.txt. If it fails, create it with content 'initialized'.",
      scoring: {
        maxSteps: 4,
        requiredTools: ["read_file", "write_file"],
        forbiddenTools: [],
        successAssertions: [
          { kind: "file-exists", value: "./nonexistent.txt" },
          { kind: "file-contains", value: "initialized" },
        ],
      },
    },
    {
      id: "tool-composition",
      description: "Chain multiple tools to solve a composed problem",
      category: "compose",
      initialContext: "List files in ./src, read the largest one, and add its filename to knowledge.",
      scoring: {
        maxSteps: 6,
        requiredTools: ["list_directory", "read_file", "add_knowledge"],
        forbiddenTools: [],
        successAssertions: [{ kind: "no-errors", value: "" }],
      },
    },
  ],
};

export function scoreBenchmarkRun(task: BenchmarkTask, steps: RecordedFrame[]): BenchmarkScore {
  const { scoring } = task;

  // 效率分：步数越少越好
  const efficiency = Math.max(0, 1 - (steps.length - 1) / scoring.maxSteps);

  // 正确性：（简化版，完整版需要执行 assertions）
  const hasErrors = steps.some(s => !s.outcome.success);
  const correctness = hasErrors ? 0.5 : 1.0;

  // 工具选择分
  const usedTools = new Set(steps.map(s => s.decision.chosenTool));
  const requiredHit = scoring.requiredTools.filter(t => usedTools.has(t)).length;
  const requiredMiss = scoring.requiredTools.length - requiredHit;
  const forbiddenHit = scoring.forbiddenTools.filter(t => usedTools.has(t)).length;
  const toolChoice = Math.max(0, 1 - requiredMiss * 0.3 - forbiddenHit * 0.5);

  // 综合分
  const overall = efficiency * 0.3 + correctness * 0.5 + toolChoice * 0.2;

  return {
    passed: correctness >= 0.8 && !hasErrors,
    efficiency,
    correctness,
    toolChoice,
    overall,
  };
}
