/**
 * 河床系统（Riverbed System）· 判断不驱动执行守卫
 * ------------------------------------------------------------------
 * 这是河床三条不可违背边界中"判断永不驱动执行"的硬保证。
 *
 * 确定性纯函数，递归扫描任意对象 / 数组，发现以下任一引擎触发字段即拒绝：
 *   - `enginePacket`（存在且非 null/undefined）
 *   - `selectedEngine`（存在且非 null/undefined）
 *   - `executionAllowed === true`
 *
 * 重写自 3.1 蓝本（lib/wenlu/riverbed/no-engine-trigger-guard.ts），剥离：
 *   - `import "@/lib/..."` 外部类型依赖（JsonObject）
 *   - `protocolOnly` / `deferredToPhase` 阶段概念（弟弟无阶段）
 *   - `buildDeferredDomainEngineHint`（依赖阶段概念，弟弟不需要）
 *
 * 无副作用、无 IO、无 LLM、无环境变量 / 配置依赖。
 * 沿用弟弟 ESM 约定（相对导入带 `.js` 扩展，本文件无内部依赖）。
 *
 * _Requirements: 3.1, 3.3_
 */

export interface NoEngineTriggerGuardResult {
  /** 未发现任何引擎触发字段时为 true */
  allowed: boolean;
  /** 发现至少一个引擎触发字段时为 true（与 allowed 互斥） */
  blocked: boolean;
  /** 去重后的拒绝原因列表 */
  reasons: string[];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * 递归扫描任意值，收集引擎触发原因。
 * - 用 WeakSet 防循环引用导致的无限递归。
 * - 对 null / 基本类型直接跳过（仅对象 / 数组才下钻）。
 */
function scanNoEngineTriggers(
  value: unknown,
  reasons: string[],
  seen: WeakSet<object>,
): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      scanNoEngineTriggers(item, reasons, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (hasOwn(record, "enginePacket") && isPresent(record.enginePacket)) {
    reasons.push("enginePacket_blocked");
  }
  if (hasOwn(record, "selectedEngine") && isPresent(record.selectedEngine)) {
    reasons.push("selectedEngine_blocked");
  }
  if (record.executionAllowed === true) {
    reasons.push("executionAllowed_true_blocked");
  }

  for (const nested of Object.values(record)) {
    scanNoEngineTriggers(nested, reasons, seen);
  }
}

/**
 * 递归扫描任意对象 / 数组，判定其是否携带引擎触发字段。
 * 确定性纯函数：相同输入恒返回相同结果（reasons 顺序稳定、去重）。
 */
export function evaluateNoEngineTriggerGuard(value: unknown): NoEngineTriggerGuardResult {
  const reasons: string[] = [];
  scanNoEngineTriggers(value, reasons, new WeakSet<object>());

  const deduped = [...new Set(reasons)];
  return {
    allowed: deduped.length === 0,
    blocked: deduped.length > 0,
    reasons: deduped,
  };
}

/**
 * 断言某值不携带任何引擎触发字段。
 * - blocked 时抛出 `DOMAIN_ENGINE_TRIGGER_BLOCKED: <reasons>`。
 * - 否则返回守卫结果（allowed: true）。
 */
export function assertNoEngineTrigger(value: unknown): NoEngineTriggerGuardResult {
  const result = evaluateNoEngineTriggerGuard(value);
  if (result.blocked) {
    throw new Error(`DOMAIN_ENGINE_TRIGGER_BLOCKED: ${result.reasons.join(", ")}`);
  }
  return result;
}
