// Stable server contract for consumers outside the practice capability.

// Compatibility exports; shared read models consume their owner, kernel/events,
// directly so initialization does not re-enter the practice runtime barrel.
export { type EffectiveTruth } from '@/kernel/events';
export {
  type BoundReviewAnswer,
  BoundReviewAnswerSchema,
  type ReviewAnswerAttachment,
  ReviewAnswerAttachmentSchema,
} from '@/kernel/tools/review-answer';
export type { QuizGenJobData } from './jobs/quiz_gen';

export { runQuestionAdmissionChecks } from './server/admission/checks';
// YUK-1057 — 隔离演练的 post-cutover writer seam：发题/草稿/提交统一经
// barrel 透出（import 链为 @kernel + @db 纯链，无 SDK —— migrate bundle 安全）。
export { issueAssessment } from './server/assessment/issue';
export { saveResponseDraft, saveSubmission } from './server/assessment/submit';

export { writeAttemptSnapshotBrackets } from './server/attempt-snapshot';
export {
  type CalibrationSampleDispatch,
  calibrationSampleDispatchSchema,
} from './server/calibration-sample-store';
// YUK-1007 — practice 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { practiceConfigEffectiveFacts } from './server/config-effective-facts';

export { scheduleReview } from './server/fsrs';
export {
  DEFAULT_MAX_PER_RUN,
  type ItemPriorCandidateFrozen,
  type ItemPriorExecutionParams,
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  normalizeMethod,
  normalizeReps,
  prepareItemPriorWork,
  resolveItemPriorKnowledgeNames,
  runItemPriorItemRepStages,
  selectItemPriorCandidates,
} from './server/item-prior-durable-operation';
export {
  type ItemPriorDispatch,
  type ItemPriorDispatchedRequest,
  ItemPriorMemberIdentityError,
  type ItemPriorMemberRequest,
  ItemPriorPaidEffectAdapter,
  itemPriorDispatchSchema,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
  readItemPriorPgBossDelivery,
} from './server/item-prior-paid-effect-adapter';
export type { FrontierResolution } from './server/learnable-frontier';
export { isMasteredForFrontier } from './server/learnable-frontier';
export { validateLearningContent } from './server/learning-content-validation';
export { isLiveQuestionReference } from './server/live-question-reference';
// YUK-1037/1053 — the seed-root anchor regex is a single pattern owned by
// placement-scope but consumed from server/*; re-exported through the public
// seam so server→capability stays public (not deep).
export { SYNTHETIC_SUBJECT_ROOT_RE } from './server/placement-scope';

export { claimHttpSourceDuplicate } from './server/question-supply/ingest-dedup';
export {
  DEDUP_OVERLAP_THRESHOLD,
  maxNgramOverlap,
} from './server/question-supply/sourced-dedup';
export {
  canonicalQuestionContentHash,
  mergeExactQuestionDuplicateKnowledgeIds,
} from './server/quiz/content-fingerprint';
export { resolveSolveOverrideFromEnv } from './server/quiz/solve-lane';

export { captureReviewAnswerBinding, consumeReviewAnswerBinding } from './server/review-operation';
export {
  SolveError,
  buildSolveHintInput,
  parseHintTurn,
} from './server/solve-session';
export type { PracticeTaskRunFn } from './server/task-runtime';
export const queryReviewDue: typeof import('./server/due-list').queryReviewDue = async (...args) =>
  (await import('./server/due-list')).queryReviewDue(...args);
// YUK-1622 — Coach's nightly daily-plan inputs share the practice due queue and
// measured question pace.
export const resolveDailyReviewPlanInputs: typeof import('./server/daily-review-plan').resolveDailyReviewPlanInputs =
  async (...args) =>
    (await import('./server/daily-review-plan')).resolveDailyReviewPlanInputs(...args);
export type { DailyReviewPlanInputs } from './server/daily-review-plan';

type HandleReviewDue = typeof import('./server/due-list').handleReviewDue;
export const handleReviewDue: HandleReviewDue = async (...args) => {
  const dueList = await import('./server/due-list');
  return dueList.handleReviewDue(...args);
};

export { type CreateAttemptBody, CreateAttemptBodySchema } from './api/contracts';
// YUK-1064 — explicit operations used by scripts and integration consumers.
export type { FailureLearningBossSend } from './jobs/failure-learning-jobs';
export {
  commitFormalAttempt,
  previewFormalAttempt,
  recordFormalAttemptCapture,
} from './server/assessment/attempt';
export type {
  NativeAttemptDispatchOptions,
  NativeAttemptDispatchPort,
} from './server/assessment/native-attempt-dispatch-port';
export type { CollectedSignal } from './server/candidate-signals';
export { CAUSE_OVERLAY_ID_PREFIX, getCauseCategoryOverlaysByIds } from './server/cause-overlay';
export type {
  ProposeFailureVariantInput,
  VariantProposalResult,
} from './server/failure-learning-public';
export { proposeFailureVariant } from './server/failure-learning-public';

export {
  authorInterventionPackage,
  reviewInterventionPackageCandidate,
} from './server/intervention-author';

export {
  INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
  loadLatestTrustedInterventionDiagnosticVerdict,
  loadNativeInterventionDiagnosticState,
  materializeInterventionDiagnostics,
  retireInterventionDiagnosticQuestion,
} from './server/intervention-diagnostics';
// YUK-1063 — explicit judging contract consumed by the stable kernel facade.
export type { AnswerInput, JudgeResult } from './server/judge';
export {
  type ContractAttemptInput,
  type ContractAttemptOutcome,
  type ContractGradingRef,
  EVALUATION_ENTRY_POINTS,
  type EntryPointDisposition,
  type EvaluateAttemptInput,
  type EvaluateAttemptOutcome,
  EvaluateSubmissionError,
  type EvaluateSubmissionRequest,
  type EvaluateSubmissionResult,
  type GradingEntryPoint,
  IMAGE_CONSUMING_JUDGE_ROUTES,
  type JevModelExecutorSpec,
  type JudgeAnswerParams,
  type JudgeAnswerResult,
  type JudgeInvokerOutput,
  type JudgeKind,
  type JudgeQuestionRow,
  type JudgeRoute,
  type JudgeRouteQuestionRow,
  type JudgeRouterInput,
  MODEL_BACKED_JUDGE_ROUTES,
  type MultimodalDirectImageFetchFn,
  type MultimodalDirectRunTaskFn,
  createDefaultJudgeInvoker,
  defaultImageFetch,
  evaluateAttempt,
  evaluateSubmission,
  isModelBackedJudgeRoute,
  judgeAnswer,
  judgeRouter,
  judgeRouterV2,
  resolveQuestionJudgeRoute,
  runMultimodalDirectJudge,
} from './server/judge';
export { withdrawCapturedOccurrence } from './server/judge/evaluate-submission';
export { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from './server/judge-run-status';
export {
  rewriteLearningItemKnowledgeIds,
  rewriteQuestionKnowledgeIds,
} from './server/merge-attribution';
export { submitPaperSlot } from './server/paper-submit';

export type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from './server/proposal-appliers';
// YUK-885 — public ports repointed from central deep imports.
export { applyQuestionEdit } from './server/proposal-appliers';
export type { DispatchResult } from './server/question-supply/dispatcher';
export {
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  dispatchSupplyTarget as dispatchPracticeSupplyTarget,
  dispatchSupplyTargets as dispatchPracticeSupplyTargets,
  inFlightSupplyCount,
} from './server/question-supply/dispatcher';
export type { SupplyTraceV1T } from './server/question-supply/evidence-demand';
export { withSupplyTraceDifficultyEvidence } from './server/question-supply/evidence-demand';

// YUK-986 (Supply-Agent/1) — jyeoo agent-tool 链公开面：候选抓取核心（tool 与 CLI 共用）、
// hint 名匹配（CLI/executor 的确定性归属辅助）。DomainTool 本体由 manifest
// copilotTools lazy-load 深路径授予，CLI 直接调 execute。
export { runJyeooFetchCandidates } from './server/question-supply/jyeoo-candidates';
export {
  findSubjectRootKnowledgeId,
  matchJyeooKnowledgeHints,
} from './server/question-supply/jyeoo-hint-match';

export {
  JYEOO_BACKFILL_PER_QUESTION_MS,
  jyeooBackfillSpawnTimeoutMs,
} from './server/question-supply/jyeoo-supply-config';
export {
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
} from './server/question-supply/placement-starter';
export type {
  PlacementCostComponentKind,
  PlacementVerificationAuthority,
} from './server/question-supply/placement-starter-attempts';
export {
  PLACEMENT_GENERATION_RESERVATION_MICRO_USD,
  PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD,
  PLACEMENT_QUEUE_EXPIRY_MS,
  PlacementStarterBudgetExhaustedError,
  PlacementStarterUnknownCostError,
  acquirePlacementAttempt,
  addAuthorizedCostComponent,
  releaseAuthorizedPaidCall,
  reserveAuthorizedPaidCall,
  reservePlacementGenerationCall,
  settleAuthorizedPaidCall,
  terminalizeLostPlacementDelivery,
  terminalizePlacementUnknownCost,
} from './server/question-supply/placement-starter-attempts';

export {
  addPlacementStarterCostComponent,
  markPlacementStarterClaimTerminal,
  resolvePlacementStarterGoalAuthority,
} from './server/question-supply/placement-starter-store';
export { lockPlacementSupplyScopes } from './server/question-supply/placement-supply-lock';
// YUK-988 (Supply-Agent/3) — executeSupplyPlan/buildSupplyExecutorDeps 不进本 barrel：
// 该链（plan-executor → web-candidates → SourcingTask → pi agent runtime）
// 会把 SDK 拉进 build:migrate 的 cjs bundle，SDK 顶层 createRequire(import.meta.url)
// 在 cjs 下启动即崩（server/worker 构建标 external 所以只 migrate 中招）。
// scripts/supply-execute.ts 走深路径直引（E1 jyeoo-backfill 先例）。

export type {
  DifficultyBand,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
  SupplyRoute,
} from './server/question-supply/target-discovery';
export {
  COVERAGE_DEPTH_THRESHOLD,
  NEAR_WINDOW,
  assembleScanInput,
  scanCoverageGaps,
} from './server/question-supply/target-discovery';
export type { ReviewAnswerContext, ReviewAnswerResult } from './server/review-operation';
export {
  MEM0_PRIOR_BLOCK_CHAR_CAP,
  MEM0_PRIOR_CAP,
  MEM0_PRIOR_ITEM_CHAR_CAP,
  SELECTION_ORCHESTRATOR_CANDIDATE_CAP,
} from './server/selection-constants';

// YUK-892 — due-review queue reader for non-LLM read paths (today summary).
export { executeGetReviewDue } from './server/tools/question-context';
export { submitQuestionTool } from './server/tools/submit-question';
// YUK-1468 — `store_sourced_question` 工具面已并入 submit_question（旧名不再
// 注册/授权）；函数级 compat 仍在 ./server/tools/store-sourced-question。

export const submitReviewAnswer: typeof import('./server/review-operation').submitReviewAnswer =
  async (...args) => (await import('./server/review-operation')).submitReviewAnswer(...args);

export async function readJudgeRunStatus(database: import('@/db/client').Db, runId: string) {
  return (await import('./server/judge-run-observation')).readJudgeRunStatus(database, runId);
}
export async function reconcileJudgeAttempts(
  ...args: Parameters<typeof import('./jobs/judge_pending_reconcile').reconcileStalledJudgeAttempts>
) {
  return (await import('./jobs/judge_pending_reconcile')).reconcileStalledJudgeAttempts(...args);
}
export async function buildLegacyJudgeHandler(
  ...args: Parameters<typeof import('./jobs/judge_run').buildJudgeRunHandler>
) {
  return (await import('./jobs/judge_run')).buildJudgeRunHandler(...args);
}
export async function recordJudgeOperationalReceipt(
  ...args: Parameters<typeof import('./server/judge-operational').writeJudgeReceipt>
) {
  return (await import('./server/judge-operational')).writeJudgeReceipt(...args);
}
export async function readPermanentJudgeRun(
  ...args: Parameters<typeof import('./server/judge-run-observation').readJudgeRunPermanent>
) {
  return (await import('./server/judge-run-observation')).readJudgeRunPermanent(...args);
}
export async function executeJudgeWorkflow(
  ...args: Parameters<typeof import('./jobs/judge_run').runJudgeWorkflowDelivery>
) {
  return (await import('./jobs/judge_run')).runJudgeWorkflowDelivery(...args);
}

export const reserveJudgeOperationalDelivery: typeof import('./server/judge-operational').reserveJudgeDelivery =
  async (...args) => (await import('./server/judge-operational')).reserveJudgeDelivery(...args);

// Judge engine identity and census belong to practice; the shared host consumes this seam.
export {
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  type JudgeEngineInventoryT,
  inspectDbosJudgeInventory,
  judgeDeliveryInput,
  judgeLegacyJobId,
  sealJudgeEngineInventory,
  validateJudgeEngineInventory,
} from './server/judge-engine-client';
