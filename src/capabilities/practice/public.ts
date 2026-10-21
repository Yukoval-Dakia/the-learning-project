// Stable server contract for consumers outside the practice capability.

// Compatibility exports; shared read models consume their owner, kernel/events,
// directly so initialization does not re-enter the practice runtime barrel.
export type { EffectiveTruth } from '@/kernel/events';
export {
  type BoundReviewAnswer,
  BoundReviewAnswerSchema,
  type ReviewAnswerAttachment,
  ReviewAnswerAttachmentSchema,
} from '@/kernel/tools/review-answer';
export type { QuizGenJobData } from './jobs/quiz_gen';

export { runQuestionAdmissionChecks } from './server/admission/checks';
// Writer seam for issue/draft/submit: keeping these on the barrel keeps the migrate
// bundle on the @kernel + @db chain with no SDK import.
export { issueAssessment } from './server/assessment/issue';
export { saveResponseDraft, saveSubmission } from './server/assessment/submit';

export { writeAttemptSnapshotBrackets } from './server/attempt-snapshot';
export {
  type CalibrationSampleDispatch,
  calibrationSampleDispatchSchema,
} from './server/calibration-sample-store';
// practice 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
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
// The seed-root anchor regex is owned by placement-scope but consumed from server/*;
// re-export it here so consumers stay on the public seam.
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
// Coach's nightly daily-plan inputs share the practice due queue and
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
// explicit operations used by scripts and integration consumers.
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
  materializeInterventionDiagnostics,
  retireInterventionDiagnosticQuestion,
} from './server/intervention-diagnostics';
// explicit judging contract consumed by the stable kernel facade.
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
// public ports repointed from central deep imports.
export type { DispatchResult } from './server/question-supply/dispatcher';
export {
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  dispatchSupplyTarget as dispatchPracticeSupplyTarget,
  dispatchSupplyTargets as dispatchPracticeSupplyTargets,
  inFlightSupplyCount,
} from './server/question-supply/dispatcher';
export type { SupplyTraceV1T } from './server/question-supply/evidence-demand';
export { withSupplyTraceDifficultyEvidence } from './server/question-supply/evidence-demand';

// Jyeoo agent-tool public surface: candidate fetch shared with the CLI and deterministic
// hint matching. DomainTool registration loads deep paths from the manifest; the CLI calls
// execute directly.
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
// Keep executeSupplyPlan/buildSupplyExecutorDeps out of this barrel: that chain
// (plan-executor → web-candidates → SourcingTask → pi agent runtime) pulls the SDK into the
// migrate cjs bundle, whose top-level createRequire(import.meta.url) fails at startup.
// server/worker mark it external, so only migrate is affected. scripts/supply-execute.ts
// imports the deep path directly.

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

// due-review queue reader for non-LLM read paths (today summary).
export { executeGetReviewDue } from './server/tools/question-context';
export { submitQuestionTool } from './server/tools/submit-question';
// store_sourced_question is folded into submit_question (the old tool is no longer
// registered or granted); the function-level compat export remains.

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

export { type WeeklyReportQuery, loadWeeklyReview } from './server/review-weekly';
