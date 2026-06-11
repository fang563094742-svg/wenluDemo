*** Begin Patch
*** Update File: src/orchestrator/session.ts
@@
 export enum SessionState {
@@
   Error = "error",
 }
+
+/** 可持久化的控制层动作痕迹。 */
+export interface ControlTraceEntry {
+  id: string;
+  phase:
+    | "scan"
+    | "awareness"
+    | "clarify"
+    | "scope"
+    | "backup"
+    | "execution"
+    | "verification"
+    | "delivery"
+    | "control";
+  kind:
+    | "state-change"
+    | "user-action"
+    | "execution-progress"
+    | "risk-prompt"
+    | "blocking-question"
+    | "delivery-report"
+    | "evidence-checkpoint"
+    | "error";
+  summary: string;
+  detail?: string;
+  createdAt: string;
+  visibleBefore: string;
+}
+
+/** “10分钟内可见动作痕迹”闭环判定快照。 */
+export interface ActionTraceCheckpoint {
+  checkedAt: string;
+  windowMinutes: number;
+  hasVisibleTrace: boolean;
+  traceCountWithinWindow: number;
+  latestTraceAt?: string;
+}
@@
 export interface Session {
@@
   deliveryReport?: Delivery_Report;
   /** R15.4 仅用户点击"确认完成"置 true。默认 false。 */
   accepted: boolean;
+
+  // 可验证控制闭环证据
+  controlTrace: ControlTraceEntry[];
+  latestActionTraceCheckpoint?: ActionTraceCheckpoint;
 
   // 错误（非致命，服务保持运行）
   lastError?: { code: string; message: string };
@@
 export function createInitialSession(id: string = randomUUID()): Session {
   const now = new Date().toISOString();
   return {
@@
     executionConfirmed: false,
     backupSizeConfirmed: false,
     accepted: false,
+    controlTrace: [],
     createdAt: now,
     updatedAt: now,
   };
 }
*** End Patch