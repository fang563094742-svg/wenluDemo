/**
 * proactive-awareness-demo —— 可插拔扫描器接口契约（任务 4.1）。
 *
 * `Device_Scanner` 是三大可插拔点之一（与 `LLM_Provider` / `Executor_Tool` 并列），
 * 采用"接口 + 实现 + 注册表"模式：实现按 `platform` 注册到 ScannerRegistry，
 * Orchestrator 以 `process.platform` 解析对应实现，调用方零改动即可扩展新平台
 * （如未来的 AndroidScanner，第一版仅预留接口、不实现）。R2.1 / R2.4 / R17.2 / R18.1。
 *
 * 范围说明：本任务仅定义接口契约，不含 Mac_Scanner 实现（任务 4.6）。
 *
 * _Requirements: 2.1, 2.4, 3.4, 16.2_
 */

import type {
  Scan_Summary,
  ScanOptions,
  ScanProgressEvent,
} from "./types.js";

/**
 * 平台扫描器契约。一次 `scan()` 在实现内部完成：
 * 粗筛 → Top N 精选 → 排除红线 → 组装 `Scan_Summary`。
 */
export interface Device_Scanner {
  /** 平台标识，用于注册表 key，如 "darwin"。 */
  readonly platform: string;

  /** 当前进程平台是否受此 Scanner 支持。 */
  isSupported(): boolean;

  /**
   * 执行一次扫描，产出结构化摘要。
   * 实现内部完成：粗筛 → Top N 精选 → 排除红线 → 组装 `Scan_Summary`。
   *
   * 可选的 `onProgress` 回调用于"扫描具身化"（可选增强）：在阶段1 粗筛过程中，
   * 每发现一批新的文件 / git 仓库 / App，即推送一条 `ScanProgressEvent`
   * （`found` **仅含已过排除红线的元信息级线索、绝不含正文**）。
   * **不传 `onProgress` 时静默退化为普通扫描，行为不变**——该参数为非破坏性追加。
   *
   * @param options 扫描入参（时间窗 / Top N / 扫描起点）。
   * @param onProgress 可选的流式进度回调（扫描具身化，不传即静默扫描）。
   * @returns 结构化扫描摘要（已是 Top N、已应用排除红线）。
   * @throws ScanError 描述性错误（R1.5）。
   */
  scan(
    options: ScanOptions,
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<Scan_Summary>;
}
