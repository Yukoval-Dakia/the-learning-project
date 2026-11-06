// Stable server contract for consumers outside the practice capability.

// Composition seam: hosts install every kernel port Practice owns through these
// two entries. The install logic lives in ./composition; server/ entries may only
// reach capability public entrypoints (pnpm audit:capability-boundaries).
export { installPracticeHost, installPracticeWorker } from './composition';
export { type VariantProposalResult, proposeFailureVariant } from './failure-learning/public';
export {
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  type JudgeEngineInventoryT,
  type JudgeQuestionRow,
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
  canonicalQuestionContentHash,
  dispatchPendingVerifyIntents,
  embedQuestionTextForIngest,
  mergeExactQuestionDuplicateKnowledgeIds,
  recoverOrphanVerifyDispatches,
  resolveSolveOverrideFromEnv,
  runQuestionAdmissionChecks,
  writeVerifyDispatchIntent,
} from './question-bank/public';

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
