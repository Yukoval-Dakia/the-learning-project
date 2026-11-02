// Stable server contract for consumers outside the practice capability.

import { loadLearningContentValidator } from './question-bank/public';
import { loadReviewDueReader } from './scheduling/public';

// Compatibility export; shared read models consume their owner, kernel/events,
// directly so initialization does not re-enter the practice runtime barrel.
export type { EffectiveTruth } from '@/kernel/events';
export { IssueAssessmentBodySchema } from './api/assessment-contracts';
export {
  type FailureLearningBossSend,
  type ProposeFailureVariantInput,
  type VariantProposalResult,
  proposeFailureVariant,
} from './failure-learning/public';
export type { QuizGenJobData } from './jobs/quiz_gen';
export {
  DEFAULT_MAX_PER_RUN,
  type EnqueueVariantVerifyFn,
  type EnqueueVerifyFn,
  type ItemPriorCandidateFrozen,
  type ItemPriorDispatch,
  type ItemPriorDispatchedRequest,
  type ItemPriorExecutionParams,
  ItemPriorMemberIdentityError,
  type ItemPriorMemberRequest,
  ItemPriorPaidEffectAdapter,
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  type QuestionDraftAcceptResult,
  type QuestionEditAcceptResult,
  VERIFY_DISPATCH_COMPLETE_ACTION,
  VERIFY_DISPATCH_INTENT_ACTION,
  VERIFY_DISPATCH_VERSION,
  type VariantQuestionAcceptResult,
  archivePracticeQuestion,
  authorInterventionPackage,
  canonicalQuestionContentHash,
  dispatchPendingVerifyIntents,
  embedQuestionTextForIngest,
  enablePracticeDraft,
  forceEnablePracticeDraft,
  installInterventionAuthorStages,
  itemPriorDispatchSchema,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
  mergeExactQuestionDuplicateKnowledgeIds,
  normalizeMethod,
  normalizeReps,
  prepareItemPriorWork,
  readDraftReviewDetail,
  readItemPriorPgBossDelivery,
  readPracticeDraftList,
  readPracticeQuestionList,
  readQuestionDetail,
  recoverOrphanVerifyDispatches,
  resolveItemPriorKnowledgeNames,
  resolveSolveOverrideFromEnv,
  restorePracticeQuestion,
  reviewInterventionPackageCandidate,
  runItemPriorItemRepStages,
  runPracticeServingAction,
  runQuestionAdmissionChecks,
  selectItemPriorCandidates,
  updatePracticeQuestion,
  writeVerifyDispatchIntent,
} from './question-bank/public';
export {
  type WeeklyReportQuery,
  getPracticeStream,
  handleReviewDue,
  installDailyReviewPlanFacts,
  loadWeeklyReview,
  previewReviewAdvice,
  queryReviewDue,
  recomposePracticeStream,
  scheduleReview,
  updatePracticeStreamItem,
} from './scheduling/public';
// Writer seam for issue/draft/submit: keeping these on the barrel keeps the migrate
// bundle on the @kernel + @db chain with no SDK import.
export { issueAssessment } from './server/assessment/issue';
export { projectIssuanceResult } from './server/assessment/issue-response';
export { getIssuanceState, saveResponseDraft, saveSubmission } from './server/assessment/submit';
export { writeAttemptSnapshotBrackets } from './server/attempt-snapshot';
export {
  type CalibrationSampleDispatch,
  calibrationSampleDispatchSchema,
} from './server/calibration-sample-store';
// practice 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { practiceConfigEffectiveFacts } from './server/config-effective-facts';
// The seed-root anchor regex is owned by placement-scope but consumed from server/*;
// re-export it here so consumers stay on the public seam.
export { SYNTHETIC_SUBJECT_ROOT_RE } from './server/placement-scope';
export type { PracticeTaskRunFn } from './server/task-runtime';
export {
  DEDUP_OVERLAP_THRESHOLD,
  claimHttpSourceDuplicate,
  findVectorNearDuplicate,
  maxNgramOverlap,
  vectorNearHoldMetadata,
} from './supply/public';
// Binds the operations Practice owns behind kernel ports that API routes and worker
// jobs both call. Hosts call this before serving or mounting handlers.
export async function installPracticeHostOperations(): Promise<void> {
  const [
    { installReviewAnswerBindingOperations },
    { installReviewDueReader },
    { installLearningContentValidator },
    { installConversationConfirmationAssessment },
    { captureReviewAnswerBinding, consumeReviewAnswerBinding },
    executeGetReviewDue,
    validateLearningContent,
    { issueConversationConfirmation, readConversationConfirmation, submitConversationConfirmation },
  ] = await Promise.all([
    import('@/kernel/records/review-answer-binding'),
    import('@/kernel/read-models/review-due'),
    import('@/kernel/tools/learning-content-validation'),
    import('@/kernel/records/conversation-confirmation-assessment'),
    import('./server/review-operation'),
    loadReviewDueReader(),
    loadLearningContentValidator(),
    import('./server/conversation-confirmation'),
  ]);
  installReviewAnswerBindingOperations({
    capture: captureReviewAnswerBinding,
    consume: consumeReviewAnswerBinding,
  });
  installReviewDueReader(executeGetReviewDue);
  installLearningContentValidator(validateLearningContent);
  installConversationConfirmationAssessment({
    issue: issueConversationConfirmation,
    submit: submitConversationConfirmation,
    read: readConversationConfirmation,
  });
}

export async function installInterventionDiagnosticLeaves(): Promise<void> {
  const [{ installInterventionDiagnosticLeaves: install }, { interventionDiagnosticLeaves }] =
    await Promise.all([
      import('@/kernel/records/intervention-diagnostic-materialize'),
      import('./server/intervention-diagnostics'),
    ]);
  install(interventionDiagnosticLeaves);
}

export { lockPlacementSupplyScopes } from '@/kernel/locks/placement-supply';
export type { PlacementVerificationAuthority, SupplyTraceV1T } from '@/kernel/supply-contracts';
export { withSupplyTraceDifficultyEvidence } from '@/kernel/supply-contracts';
export { type CreateAttemptBody, CreateAttemptBodySchema } from './api/contracts';
// explicit operations used by scripts and integration consumers.
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
// public ports repointed from central deep imports.
export type { DispatchResult, PlacementCostComponentKind } from './supply/public';
// Jyeoo agent-tool public surface: candidate fetch shared with the CLI and deterministic
// hint matching. DomainTool registration loads deep paths from the manifest; the CLI calls
// execute directly.
export {
  JYEOO_BACKFILL_PER_QUESTION_MS,
  PLACEMENT_GENERATION_RESERVATION_MICRO_USD,
  PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD,
  PLACEMENT_QUEUE_EXPIRY_MS,
  PlacementStarterBudgetExhaustedError,
  PlacementStarterUnknownCostError,
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  acquirePlacementAttempt,
  addAuthorizedCostComponent,
  addPlacementStarterCostComponent,
  dispatchPlacementStarterClaim,
  dispatchSupplyTarget as dispatchPracticeSupplyTarget,
  dispatchSupplyTargets as dispatchPracticeSupplyTargets,
  findSubjectRootKnowledgeId,
  inFlightSupplyCount,
  isPlacementStarterJobLive,
  jyeooBackfillSpawnTimeoutMs,
  markPlacementStarterClaimTerminal,
  matchJyeooKnowledgeHints,
  releaseAuthorizedPaidCall,
  reserveAuthorizedPaidCall,
  reservePlacementGenerationCall,
  resolvePlacementStarterGoalAuthority,
  runJyeooFetchCandidates,
  settleAuthorizedPaidCall,
  terminalizeLostPlacementDelivery,
  terminalizePlacementUnknownCost,
} from './supply/public';

// Keep executeSupplyPlan/buildSupplyExecutorDeps out of this barrel: that chain
// (plan-executor → web-candidates → SourcingTask → pi agent runtime) pulls the SDK into the
// migrate cjs bundle, whose top-level createRequire(import.meta.url) fails at startup.
// server/worker mark it external, so only migrate is affected. scripts/supply-execute.ts
// imports the deep path directly.

export { projectReviewAnswerResponse } from './server/review-answer-response';
export type { ReviewAnswerContext, ReviewAnswerResult } from './server/review-operation';
export {
  MEM0_PRIOR_BLOCK_CHAR_CAP,
  MEM0_PRIOR_CAP,
  MEM0_PRIOR_ITEM_CHAR_CAP,
  SELECTION_ORCHESTRATOR_CANDIDATE_CAP,
} from './server/selection-constants';
export type { CoverageLatticeRead } from './supply/public';
export { loadCoverageLattice, submitQuestionTool } from './supply/public';
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

export type { PlacementProfileResponse } from './api/placement-contracts';
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
export { readPlacementProfile } from './server/placement-profile';

// Resolve the existing session operation in the initialized host graph after auth.
export const readPlacementSession: typeof import('./server/session-operations/placement-session').readPlacementSession =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).readPlacementSession(...args);

export { UpdatePlacementSessionBodySchema } from './api/placement-contracts';
export const transitionPlacementSession: typeof import('./server/session-operations/placement-session').transitionPlacementSession =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).transitionPlacementSession(
      ...args,
    );

export { SaveResponseDraftBodySchema } from './api/assessment-contracts';
export { CreatePlacementSessionBodySchema } from './api/placement-contracts';
export { selectNextPlacementItem } from './server/placement-select';
export { placementProbeEnabled } from './server/placement-session-lifecycle';
export { releaseHeldPlacement } from './server/session-operations/placement-held-release';
export { selectNextPlacementQuestion } from './server/session-operations/placement-next';
export const startPlacementProbe: typeof import('./server/session-operations/placement-session').startPlacementProbe =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).startPlacementProbe(...args);

export { CreateReviewSessionBody } from './api/contracts';
export { createPracticeAppeal } from './server/appeal-operation';
export { revealFrozenStudyReference } from './server/assessment/study-context';
export {
  PlacementOrphanStateError,
  abandonOrphanPlacementTx,
} from './server/placement-session-lifecycle';
export const recoverWebSupplies: typeof import('./supply/public').recoverWebSupplies = async (
  ...args
) => (await import('./supply/public')).recoverWebSupplies(...args);
// Scheduling triggers supply (post-compose refill, return-wake nightly supply) only through
// these lazy entries until the supply owner lands a kernel port.
export type { RefillDeps } from './supply/public';
export const refillActiveLearningPools: typeof import('./supply/public').refillActiveLearningPools =
  async (...args) => (await import('./supply/public')).refillActiveLearningPools(...args);
export const runQuestionSupplyNightly: typeof import('./supply/public').runQuestionSupplyNightly =
  async (...args) => (await import('./supply/public')).runQuestionSupplyNightly(...args);
export const recoverHeldServingRechecks: typeof import('./question-bank/public').recoverHeldServingRechecks =
  async (...args) => (await import('./question-bank/public')).recoverHeldServingRechecks(...args);
export { createPracticeHintRequest, createPracticeSolveSession } from './server/solve-operations';
export {
  abandonOrphanReviewSession,
  createPracticePaperSubmission,
  createReviewSession,
  getPaperDetail,
  readPaperList,
  readWorksheetExport,
  submitPaperSlot,
  transitionReviewSession,
} from './session/public';
