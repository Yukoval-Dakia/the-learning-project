// Stable server contract for consumers outside the practice capability.

import { runHostOperationInstallation } from '@/kernel/host-operation';
import { loadReviewDueReader } from './scheduling/public';

export {
  type VariantProposalResult,
  causeCategoryUndoGuard,
  knowledgeNodesWithMisconceptionEdges,
  proposeFailureVariant,
} from './failure-learning/public';
export {
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  type JudgeEngineInventoryT,
  type JudgeQuestionRow,
  MODEL_SLICE_PINNED_TASK_KINDS,
  assertSourceGroundingLaneConfigured,
  buildLegacyJudgeHandler,
  executeJudgeWorkflow,
  judgeDeliveryInput,
  judgeLegacyJobId,
  readPermanentJudgeRun,
  reconcileJudgeAttempts,
  recordJudgeOperationalReceipt,
  reserveJudgeOperationalDelivery,
  saveResponseDraft,
  sealJudgeEngineInventory,
  validateJudgeEngineInventory,
} from './grading/public';
export {
  type EnqueueVerifyFn,
  SOLVE_LANE_TASK_KINDS,
  type VerifyRecoveryMark,
  canonicalQuestionContentHash,
  dispatchPendingVerifyIntents,
  embedQuestionTextForIngest,
  mergeExactQuestionDuplicateKnowledgeIds,
  recoverOrphanVerifyDispatches,
  resolveSolveOverrideFromEnv,
  runQuestionAdmissionChecks,
  writeVerifyDispatchIntent,
} from './question-bank/public';
export { type UploadReadyBatch, readUploadReadyBatch } from './scheduling/public';
// practice 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { practiceConfigEffectiveFacts } from './server/config-effective-facts';
export { learningItemsWithAnswerDrafts } from './session/public';
export {
  knowledgeNodesWithLearningRecords,
  learningItemsWithLearningRecords,
} from './settlement/public';
export {
  DEDUP_OVERLAP_THRESHOLD,
  claimHttpSourceDuplicate,
  findVectorNearDuplicate,
  knowledgeNodesWithPlacementClaims,
  maxNgramOverlap,
  vectorNearHoldMetadata,
} from './supply/public';

// Keep executeSupplyPlan/buildSupplyExecutorDeps out of this barrel: that chain
// (plan-executor → web-candidates → SourcingTask → pi agent runtime) pulls the SDK into the
// migrate cjs bundle, whose top-level createRequire(import.meta.url) fails at startup.
// server/worker mark it external, so only migrate is affected. scripts/supply-execute.ts
// imports the deep path directly.

// ---------- composition seam ----------

// The two install entrypoints live in this barrel (it is the audit-registered
// composition file): a separate composition module would ride every barrel
// importer into the migrate bundle, which design §5 forbids. installPracticeHost
// covers API / Start acceptance hosts, the release rehearsal, and DB tests;
// installPracticeWorker adds the worker-only bindings. Repair scripts needing
// only model pins install installModelAdmissionPins via grading/public directly.
// Each phase completes once and is safe to request reentrantly. An uninstalled
// port call throws HostOperationNotInstalledError.

// Binds the operations Practice owns behind kernel ports that API routes and worker
// jobs both call. Hosts call this before serving or mounting handlers.
async function installPracticeHostOperationPorts(): Promise<void> {
  const [
    { installReviewAnswerBindingOperations },
    { installReviewDueReader },
    { installConversationConfirmationAssessment },
    { installJudgeOperations },
    { captureReviewAnswerBinding, consumeReviewAnswerBinding, withdrawCapturedOccurrence },
    grading,
    executeGetReviewDue,
    { issueConversationConfirmation, readConversationConfirmation, submitConversationConfirmation },
  ] = await Promise.all([
    import('@/kernel/records/review-answer-binding'),
    import('@/kernel/read-models/review-due'),
    import('@/kernel/records/conversation-confirmation-assessment'),
    import('@/kernel/judge'),
    import('./settlement/public'),
    import('./grading/public'),
    loadReviewDueReader(),
    import('./server/conversation-confirmation'),
  ]);
  installReviewAnswerBindingOperations({
    capture: captureReviewAnswerBinding,
    consume: consumeReviewAnswerBinding,
  });
  installReviewDueReader(executeGetReviewDue);
  installConversationConfirmationAssessment({
    issue: issueConversationConfirmation,
    submit: submitConversationConfirmation,
    read: readConversationConfirmation,
  });
  installJudgeOperations({
    previewFormalAttempt: grading.previewFormalAttempt,
    commitFormalAttempt: grading.commitFormalAttempt,
    recordFormalAttemptCapture: grading.recordFormalAttemptCapture,
    saveSubmission: grading.saveSubmission,
    withdrawCapturedOccurrence,
  });
}

/**
 * YUK-1770 — installs practice's today-recompose operation behind the kernel
 * steering port. Agency's steering subscription calls the port and never
 * imports practice (cross-capability value edges are decrease-only).
 */
async function installTodayPracticeRecompose(): Promise<void> {
  const [{ installTodayPracticeRecompose: install, installSteeringDeferredDueCount }] =
    await Promise.all([import('@/kernel/steering-recompose')]);
  // Both operations ride the scheduling sub-owner's own public seam — the
  // capability barrel must not enter scheduling/server directly
  // (pnpm audit:practice-subowners).
  const { recomposePracticeStream, countSteeringDeferredDueReviews } = await import(
    './scheduling/public'
  );
  install((db) => recomposePracticeStream(db, {}));
  installSteeringDeferredDueCount((db, now) => countSteeringDeferredDueReviews(db, { now }));
}

async function installPracticeHostPhase(): Promise<void> {
  await installPracticeHostOperationPorts();
  const { installModelAdmissionPins } = await import('./grading/public');
  await installModelAdmissionPins();
  const { installSchedulingCandidateRebuild } = await import('./settlement/public');
  installSchedulingCandidateRebuild();
}

/** Every port an API, Start acceptance, rehearsal or test host needs, in an explicit order. */
export function installPracticeHost(): Promise<void> {
  return runHostOperationInstallation('practice', 'host', () => installPracticeHostPhase());
}

async function installPracticeWorkerPhase(): Promise<void> {
  const [
    { installDailyReviewPlanFacts },
    { installInterventionAuthorStages },
    { installInterventionDiagnosticLeaves },
  ] = await Promise.all([
    import('./scheduling/public'),
    import('./question-bank/public'),
    import('./grading/public'),
  ]);
  await installDailyReviewPlanFacts();
  await installTodayPracticeRecompose();
  await installInterventionAuthorStages();
  await installInterventionDiagnosticLeaves();
}

/** Worker bindings: the ready host set plus additive worker-only facts and paid stages. */
export async function installPracticeWorker(): Promise<void> {
  await installPracticeHost();
  await runHostOperationInstallation('practice', 'worker', installPracticeWorkerPhase);
}

export type { CoverageLatticeRead } from './supply/public';
export const recoverWebSupplies: typeof import('./supply/public').recoverWebSupplies = async (
  ...args
) => (await import('./supply/public')).recoverWebSupplies(...args);
// Scheduling triggers supply (post-compose refill, return-wake nightly supply, KC-scoped
// shortfall) only through these lazy entries until the supply owner lands a kernel port.
export type { RefillDeps } from './supply/public';
export const refillActiveLearningPools: typeof import('./supply/public').refillActiveLearningPools =
  async (...args) => (await import('./supply/public')).refillActiveLearningPools(...args);
export const demandToSupplyTarget: typeof import('./question-bank/public').demandToSupplyTarget =
  async (...args) => (await import('./question-bank/public')).demandToSupplyTarget(...args);
export const dispatchSupplyTarget: typeof import('./supply/public').dispatchSupplyTarget = async (
  ...args
) => (await import('./supply/public')).dispatchSupplyTarget(...args);
export const inFlightSupplyCount: typeof import('./supply/public').inFlightSupplyCount = async (
  ...args
) => (await import('./supply/public')).inFlightSupplyCount(...args);
export const runQuestionSupplyNightly: typeof import('./supply/public').runQuestionSupplyNightly =
  async (...args) => (await import('./supply/public')).runQuestionSupplyNightly(...args);
export const recoverHeldServingRechecks: typeof import('./question-bank/public').recoverHeldServingRechecks =
  async (...args) => (await import('./question-bank/public')).recoverHeldServingRechecks(...args);

export {
  freezePhotoJudgeExamInput,
  photoJudgeExamConfiguration,
  runPhotoJudgeExam,
  verifyPhotoJudgeExam,
} from './grading/public';
export {
  PlacementOrphanStateError,
  abandonOrphanPlacementTx,
  placementProbeEnabled,
  selectOrphanPlacementCandidates,
} from './placement/public';
export {
  createPracticeHintRequest,
  createPracticeSolveSession,
  restorePracticeHints,
} from './server/solve-operations';
export {
  abandonOrphanReviewSession,
  enqueueReviewSessionSummary,
  selectOrphanReviewCandidates,
} from './session/public';
export { submitCopilotAuthoredDraft } from './supply/public';
