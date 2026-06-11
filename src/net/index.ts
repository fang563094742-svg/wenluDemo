/**
 * 统一出网层（Net Egress）· 桶文件
 * ------------------------------------------------------------------
 * 对外唯一聚合出口。riverMain 只从 `./net/index.js` 导入所需类型与构造器。
 */

export { NetEgress } from "./egress.js";
export type {
  EgressExitKind,
  NetFetchOptions,
  NetFetchResult,
  EgressTransports,
} from "./egress.js";
export { EgressHealthTable } from "./healthTable.js";
export type { SourceHealth } from "./healthTable.js";
export {
  resolveEgressEntitlement,
  localEgressEntitlement,
} from "./entitlement.js";
export type {
  EgressEntitlement,
  EntitlementInput,
  EntitlementRiverbedNodeLike,
} from "./entitlement.js";
export { buildPythonTransports, DOH_RESOLVE_PY } from "./transports.js";
export type { PythonExec, CmdExec } from "./transports.js";
