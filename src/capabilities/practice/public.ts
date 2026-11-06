// Stable server contract for consumers outside the practice capability.

import { loadReviewDueReader } from './scheduling/public';

export { type VariantProposalResult, proposeFailureVariant } from './failure-learning/public';
export {
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  type JudgeEngineInventoryT,
  type JudgeQuestionRow,
  assertSourceGroundingLaneConfigured,
  buildLegacyJudgeHandler,
  commitFormalAttempt,
  defaultImageFetch,
  executeJudgeWorkflow,
  installInterventionDiagnosticLeaves,
  installModelAdmissionPins,
  judgeDeliveryInput,
  judgeLegacyJobId,
  previewFormalAttempt,
  readPermanentJudgeRun,
  reconcileJudgeAttempts,
  recordFormalAttemptCapture,
  recordJudgeOperationalReceipt,
  reserveJudgeOperationalDelivery,
  saveResponseDraft,
  saveSubmission,
  sealJudgeEngineInventory,
  sourceGroundingLaneFingerprint,
  validateJudgeEngineInventory,
  withdrawCapturedOccurrence,
} from './grading/public';
export {
  type EnqueueVerifyFn,
  SOLVE_LANE_TASK_KINDS,
  canonicalQuestionContentHash,
  dispatchPendingVerifyIntents,
  embedQuestionTextForIngest,
  installInterventionAuthorStages,
  mergeExactQuestionDuplicateKnowledgeIds,
  recoverOrphanVerifyDispatches,
  resolveSolveOverrideFromEnv,
  runQuestionAdmissionChecks,
  writeVerifyDispatchIntent,
} from './question-bank/public';
export { installDailyReviewPlanFacts } from './scheduling/public';

/**
 * YUK-1770 — installs practice's today-recompose operation behind the kernel
 * steering port. Agency's steering subscription calls the port and never
 * imports practice (cross-capability value edges are decrease-only). Defined
 * inline here so the barrel adds no new pass-through site.
 */
export async function installTodayPracticeRecompose(): Promise<void> {
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
// practice 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { practiceConfigEffectiveFacts } from './server/config-effective-facts';
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
    { installConversationConfirmationAssessment },
    { captureReviewAnswerBinding, consumeReviewAnswerBinding },
    executeGetReviewDue,
    { issueConversationConfirmation, readConversationConfirmation, submitConversationConfirmation },
  ] = await Promise.all([
    import('@/kernel/records/review-answer-binding'),
    import('@/kernel/read-models/review-due'),
    import('@/kernel/records/conversation-confirmation-assessment'),
    import('./settlement/public'),
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
}

// Keep executeSupplyPlan/buildSupplyExecutorDeps out of this barrel: that chain
// (plan-executor → web-candidates → SourcingTask → pi agent runtime) pulls the SDK into the
// migrate cjs bundle, whose top-level createRequire(import.meta.url) fails at startup.
// server/worker mark it external, so only migrate is affected. scripts/supply-execute.ts
// imports the deep path directly.

export type { CoverageLatticeRead } from './supply/public';
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
export {
  PlacementOrphanStateError,
  abandonOrphanPlacementTx,
  placementProbeEnabled,
  selectOrphanPlacementCandidates,
} from './placement/public';
export { createPracticeHintRequest, createPracticeSolveSession } from './server/solve-operations';
export {
  abandonOrphanReviewSession,
  selectOrphanReviewCandidates,
} from './session/public';

export { installSchedulingCandidateRebuild } from './settlement/public';
