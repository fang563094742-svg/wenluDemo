/**
 * Delivery_Verifier 强制验收测试的裁决纯函数与相关类型（R12.5 / R15.1）。
 *
 * 本模块只承载"verifying 状态如何转移"的纯逻辑：`executing` 声称完成后必经
 * `verifying`，逐条运行 Task_Frame 的 Acceptance_Test，得到一组
 * {@link AcceptanceTestResult}；`decideAfterVerify` 据此裁决——
 * **验收测试存在且全部通过才允许进入待验收（delivered）**，否则回 `executing`
 * 重试或转 `blocked_on_user`（retry_or_block）。
 *
 * 拆为纯函数便于 property-based 测试（见 design.md Property 26），且不依赖
 * 文件系统 / 子进程，安全关键逻辑可被独立验证。
 */

/**
 * 单条验收测试（Acceptance_Test）的执行结果（对抗性审查后新增, R12.5/R15.1）。
 *
 * 由 `Delivery_Verifier.runAcceptanceTests` 逐条产出，写入
 * `Delivery_Report.acceptanceTestResults`。
 */
export interface AcceptanceTestResult {
  /** 验收测试标识。 */
  testId: string;
  /** 该验收测试的可读描述。 */
  description: string;
  /** 实际执行的检验方式（shell 命令 / 文件内容断言 / HTTP 请求等）。 */
  checkMethod: string;
  /** 是否通过。超时同样视为该条 `failed`（false）。 */
  passed: boolean;
  /** 退出码 / 断言结果 / 响应码 / 错误信息（含 timeout 标注）等细节。 */
  detail: string;
}

/**
 * `verifying` 状态的转移裁决（纯函数, R12.5/R15.1, design Property 26）。
 *
 * 任务进入待验收（`"delivered"`）的**充要条件**是：验收测试结果集合
 * `results` 非空且其中每一条 `passed` 均为 `true`；否则（空集合，或存在任一
 * `failed`）返回 `"retry_or_block"`，由状态机回 `executing` 重试或转
 * `blocked_on_user` 让用户三选一（重试 / 强制验收覆盖 / 放弃）。
 *
 * 空集合刻意判为 `"retry_or_block"`：没有任何可执行验收测试时，不得默认放行，
 * 防"声称完成但无任何验收"绕过验收门。
 *
 * @param results 验收测试结果集合。
 * @returns `"delivered"`（全部通过且非空）或 `"retry_or_block"`（其余情况）。
 */
export function decideAfterVerify(
  results: AcceptanceTestResult[],
): "delivered" | "retry_or_block" {
  return results.length > 0 && results.every((r) => r.passed)
    ? "delivered"
    : "retry_or_block";
}
