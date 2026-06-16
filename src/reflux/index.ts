/**
 * 技能反哺（Skill Reflux）· barrel（index.ts）
 * ------------------------------------------------------------------
 * 二期云反哺模块的对外唯一入口。当前阶段仅导出基础类型与可配置参数；
 * 后续任务（采集/蒸馏/去重/验证/分类/分发/回写）将在此逐步聚合导出。
 *
 * _Requirements: 1.2, 全局支撑；Configurable Parameters_
 */

// 基础类型（复用并扩展 skill-flywheel 的 SkillSpec/SkillPlatform 等）
export type {
  // 复用一期权威类型
  SkillSpec,
  SkillPlatform,
  SkillExecStep,
  SkillTaxonomy,
  SkillVerifyContract,
  ExecutionStep,
  // 二期反哺枚举
  SkillKind,
  VariantOS,
  CandidateStatus,
  SkillStatus,
  SignalRole,
  SourceWeight,
  SkillSource,
  VerifyStatus,
  OSScope,
  // 二期反哺结构
  QualityScore,
  PlatformVariant,
  Skill,
  SkillCandidate,
  TrajectoryRef,
  HarvestSignal,
  TrajectoryEvent,
  InvocationEvent,
  SkillSummary,
} from "./types.js";

// 可配置参数
export {
  type RefluxConfig,
  DEFAULT_REFLUX_CONFIG,
  resolveRefluxConfig,
} from "./config.js";

// 轨迹环形缓冲（trajectory_event 明细表数据访问 / 裁剪）
export {
  type TrajectoryClient,
  type WithUserFn,
  type TrajectoryBufferDeps,
  type TrajectoryBuffer,
  createTrajectoryBuffer,
  recordAction,
  getRecent,
  pruneTrajectory,
} from "./trajectoryBuffer.js";

// Sanitizer（脱敏，复用并扩展 scanResidualPrivacy）
export {
  type SanitizeAudit,
  type SanitizeInput,
  type SanitizeResult,
  sanitizeCandidate,
} from "./sanitizer.js";

// SkillRepo（技能数据访问层：候选→公共技能物化、检索、质量分回写）
export {
  type SkillRepo,
  type SkillDraft,
  type SkillSubmitInput,
  type SkillListFilter,
  type SkillSearchQuery,
  type SkillContributor,
  type PgSkillRepoDeps,
  createPgSkillRepo,
  createInMemorySkillRepo,
} from "./skillRepo.js";

// Harvester（采集，零 LLM；廉价打标入队 / 落轨迹 / 记调用事件）
export {
  type Harvester,
  type HarvesterDeps,
  type HarvestContext,
  type HarvestQueryFn,
  type LogEntry,
  SYSTEM_USER_LOCAL,
  isPrivacySignal,
  createHarvester,
  enqueue,
  onVerifyPassed,
  onPredictionSettled,
  stashTrajectory,
  recordAction as harvestRecordAction,
  recordInvocation,
} from "./harvester.js";

// Distiller（蒸馏，复用并扩展 skill-flywheel.distillSkill）
export {
  type LlmBudgetAllocation,
  type DistillClassifyInput,
  type DistillExtension,
  type DistillClassifier,
  type DistillStore,
  type DistillerDeps,
  type DistillRejection,
  type DistillReport,
  type Distiller,
  allocateLlmBudget,
  shapeTrajectory,
  createDistiller,
  createPgDistillStore,
} from "./distiller.js";

// Deduplicator(去重/合并，复用 tools/conflictDetector)
export {
  type DedupDecision,
  type DedupResult,
  type MergeStrategy,
  type ConflictFreeResult,
  type SemanticView,
  type DedupSemanticJudge,
  type DedupStore,
  type BucketQuery,
  type DeduplicatorDeps,
  type Deduplicator,
  commandFingerprint,
  jaccard,
  deriveToolSemantics,
  computeMergeStrategy,
  createDeduplicator,
  createPgDedupStore,
} from "./deduplicator.js";

// Verifier(复用 src/verification，扩展 server-verified/connector-verified)
export {
  type ConnectorExecResult,
  type ConnectorLike,
  type SoftSkillReviewInput,
  type SoftReviewResult,
  type SoftSkillReviewer,
  type VerifyExecutableInput,
  type VerifyResult,
  type DowngradeResult,
  type VerifierStore,
  type VerifierDeps,
  type Verifier,
  createVerifier,
  createPgVerifierStore,
} from "./verifier.js";

// Classifier(状态机 + 双门，整合 sovereign/constitution + 升级人工兜底)
export {
  type GateOutcome,
  type EscalationTrigger,
  type ClassifyOutcome,
  type ClassifyDecision,
  type PromotionContext,
  type TransitionResult,
  type ConstitutionAdjudicator,
  type HumanReviewVerdict,
  type ClassifierStore,
  type ClassifierDeps,
  type Classifier,
  type InMemoryClassifierStoreInit,
  type InMemoryClassifierStore,
  skillToSpec,
  createClassifier,
  createInMemoryClassifierStore,
  createPgClassifierStore,
} from "./classifier.js";

// Dispatcher(检索分发 + 渐进加载 + 降级 + 平台过滤)
export {
  type RetrieveReq,
  type PlatformStatus,
  type RetrievedSkill,
  type InheritResult,
  type SettleVariantResult,
  type TopKPicker,
  type RenderHintProvider,
  type InheritFn,
  type PersistVariantInput,
  type DispatcherDeps,
  type Dispatcher,
  createDispatcher,
  createPgRenderHintProvider,
  createPgVariantPersister,
} from "./dispatcher.js";

// Onboarding 冷启动继承（T1：onboard / topUpOnConnector，含幂等与补继承）
export {
  type OnboardingStatus,
  type OnboardingStateRow,
  type OnboardingStore,
  type InheritFn as OnboardingInheritFn,
  type OnboardResult,
  type TopUpResult,
  type OnboardingDeps,
  type Onboarding,
  type PgOnboardingStoreDeps,
  selectStarterSkills,
  createOnboarding,
  createPgOnboardingStore,
  createInMemoryOnboardingStore,
} from "./onboarding.js";

// Feedback_Writer(回写 / 静默 / 淘汰，复用 recordSkillUsage + classifier + skillRepo.setStatus)
export {
  type RecordSkillUsageFn,
  type RecordReuseInput,
  type RecordReuseResult,
  type SilentInheritanceRow,
  type SilentScanResult,
  type EliminationScanResult,
  type EliminationQuery,
  type FeedbackWriterStore,
  type FeedbackWriterDeps,
  type FeedbackWriter,
  type MemFeedbackSkill,
  type MemFeedbackInheritance,
  type InMemoryFeedbackWriterStore,
  type InMemoryFeedbackWriterStoreInit,
  DEFAULT_SILENT_DECAY_FACTOR,
  createFeedbackWriter,
  createInMemoryFeedbackWriterStore,
  createPgFeedbackWriterStore,
} from "./feedbackWriter.js";

// Metrics（成功度量：单技能复用 / 整体汇总 / 反哺前后对比 / 继承未使用比例）
export {
  type SkillReuseMetric,
  type OverallSummary,
  type BeforeAfterComparison,
  type SilentInheritanceRatio,
  type SkillQualityCounts,
  type BeforeAfterCounts,
  type SilentCounts,
  type MetricsStore,
  type SkillMetricsDeps,
  type SkillMetrics,
  type MemMetricSkill,
  type MemMetricInvocation,
  type MemMetricCandidate,
  type MemMetricInheritance,
  type InMemoryMetricsStoreInit,
  createSkillMetrics,
  createInMemoryMetricsStore,
  createPgMetricsStore,
} from "./metrics.js";

// ActiveReuse（主动复用触发：T4 救援 + T5 查库；异步 + 超时 + 迟到仅参考）
export {
  type ReuseOutcome,
  type ReuseResult,
  type RetrieveFn,
  type TimerLike,
  type ActiveReuseDeps,
  type ReuseOptions,
  type ActiveReuse,
  formatReuseHint,
  raceWithTimeout,
  createActiveReuse,
} from "./activeReuse.js";

// riverMain 非侵入 hook 聚合入口（默认实例 + 便捷调用，全部 try/catch 吞错）
export {
  type HookAttribution,
  harvester as refluxHarvester,
  distiller as refluxDistiller,
  dispatcher as refluxDispatcher,
  recordAction as hookRecordAction,
  recordInvocation as hookRecordInvocation,
  enqueueExecutableSeed as hookEnqueueExecutableSeed,
  enqueueSoftSeed as hookEnqueueSoftSeed,
  onVerifyPassed as hookOnVerifyPassed,
  onPredictionSettled as hookOnPredictionSettled,
  stashTrajectory as hookStashTrajectory,
  harvestLocalSkillKB as hookHarvestLocalSkillKB,
  distillPendingBatch as hookDistillPendingBatch,
  startDistillFallbackTimer,
  stopDistillFallbackTimer,
  retrieve as hookRetrieve,
  retrieveHint as hookRetrieveHint,
  rescueRetrieve as hookRescueRetrieve,
  preForgeLookup as hookPreForgeLookup,
  hookOnboard,
  hookTopUpOnConnector,
} from "./riverHooks.js";

// API 路由与 auth 接入（/api/skills、/api/reflux；requireAuth + pending 经 requireAdmin）
export {
  type MineSkillRow,
  type RefluxStats,
  type RefluxRoutesDeps,
  type RefluxRouters,
  createRefluxRouters,
} from "./routes.js";
