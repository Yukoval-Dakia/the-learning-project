// Stable server contract for consumers outside the practice capability.

// YUK-876 — the knowledge-owned failure-attempt read port consumes the
// effective-truth resolver through this public seam (not a deep import).
export {
  type EffectiveTruth,
  activeEffectiveTruth,
  getEffectiveTruths,
} from '@/kernel/events';
export type { QuizGenJobData } from './jobs/quiz_gen';
export { retrievabilityForKc } from './server/fsrs';
export type { FrontierResolution } from './server/learnable-frontier';
export {
  isMasteredForFrontier,
  learnableFrontierResolved,
} from './server/learnable-frontier';
export { loadAttemptQuestionSnapshot } from './server/question-evidence-snapshot';
export { mergeExactQuestionDuplicateKnowledgeIds } from './server/quiz/content-fingerprint';
export { resolveSolveOverrideFromEnv } from './server/quiz/solve-lane';
export {
  runQuestionContentValidation,
  runSolveCheck,
  runTeachingQualityCheck,
} from './server/quiz/verify-framework';
export {
  SolveError,
  buildSolveHintInput,
  parseHintTurn,
} from './server/solve-session';

type HandleReviewDue = typeof import('./server/due-list').handleReviewDue;
export const handleReviewDue: HandleReviewDue = async (...args) => {
  const dueList = await import('./server/due-list');
  return dueList.handleReviewDue(...args);
};
export type { CollectedSignal } from './server/candidate-signals';
export type {
  ProposeFailureVariantInput,
  VariantProposalResult,
} from './server/failure-learning-public';
export { proposeFailureVariant } from './server/failure-learning-public';
export type { InterventionAuthorDeps } from './server/intervention-author';
export {
  authorInterventionPackage,
  reviewInterventionPackageCandidate,
} from './server/intervention-author';
export type { CommittedInterventionDiagnosticAttempt } from './server/intervention-diagnostics';
export {
  INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
  loadCommittedInterventionDiagnosticAttempt,
  loadLatestTrustedInterventionDiagnosticVerdict,
  materializeInterventionDiagnostics,
  retireInterventionDiagnosticQuestion,
} from './server/intervention-diagnostics';
export type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from './server/proposal-appliers';
// YUK-885 — public ports repointed from central deep imports.
export { applyQuestionEdit } from './server/proposal-appliers';
export type {
  DispatchDeps,
  DispatchResult,
  DispatchStatus,
  EnqueueFn,
  EnqueueQuizGenFn,
} from './server/question-supply/dispatcher';
export {
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  dispatchSupplyTarget as dispatchPracticeSupplyTarget,
  dispatchSupplyTargets as dispatchPracticeSupplyTargets,
} from './server/question-supply/dispatcher';
export type {
  EvidenceDemandV1T,
  SupplyTraceV1T,
} from './server/question-supply/evidence-demand';
export {
  EvidenceDemandV1,
  SupplyTraceV1,
  buildCoverageEvidenceDemand,
  buildSupplyTrace,
  evidenceDemandToTargetContext,
  parseEvidenceDemand,
  withSupplyTraceDifficultyEvidence,
} from './server/question-supply/evidence-demand';
export type {
  JyeooExitClassification,
  JyeooFailureClass,
  JyeooMetaT,
  JyeooParsedLine,
} from './server/question-supply/jyeoo-loom-adapter';
export {
  JYEOO_EXIT,
  classifyJyeooExit,
  hasMalformedMarkdownImage,
  isForeignSourceHost,
  isImageDependentQuestion,
  markdownImageSources,
  parseJyeooLine,
  rewriteMarkdownImageSources,
} from './server/question-supply/jyeoo-loom-adapter';
export type {
  SpawnJyeooFn,
  SpawnJyeooOptions,
  SpawnJyeooResult,
} from './server/question-supply/jyeoo-spawn';
export { spawnJyeooFetch as spawnPracticeJyeooFetch } from './server/question-supply/jyeoo-spawn';
export {
  JYEOO_DEFAULT_PAGES,
  JYEOO_FETCH_ROUTE,
  JYEOO_SOURCE_HOST,
  jyeooBinaryPath,
  jyeooDgTokenForBand,
  jyeooFetchEnabled,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from './server/question-supply/jyeoo-supply-config';
export {
  buildPlacementStarterDemand,
  buildPlacementStarterTarget,
  dispatchPlacementStarterClaim,
  dispatchPlacementStarterClaimTx,
  isPlacementStarterJobLive,
} from './server/question-supply/placement-starter';
export type {
  LostPlacementDeliverySnapshot,
  PlacementAttemptAuthority,
  PlacementAttemptHeartbeat,
  PlacementCostComponentKind,
  PlacementVerificationAuthority,
} from './server/question-supply/placement-starter-attempts';
export {
  PLACEMENT_ATTEMPT_HEARTBEAT_MS,
  PLACEMENT_ATTEMPT_LEASE_MS,
  PLACEMENT_DECISION_DEADLINE_MS,
  PLACEMENT_GENERATION_RESERVATION_MICRO_USD,
  PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD,
  PLACEMENT_QUEUE_EXPIRY_MS,
  PLACEMENT_RENEWAL_CEILING_MS,
  PLACEMENT_STARTER_REQUIRED_COUNT,
  PLACEMENT_VERIFY_POLL_MS,
  PlacementStarterAdmissionError,
  PlacementStarterAttemptActiveError,
  PlacementStarterBudgetExhaustedError,
  PlacementStarterDeadlineError,
  PlacementStarterStaleAuthorityError,
  PlacementStarterUnderfillError,
  PlacementStarterUnknownCostError,
  acquirePlacementAttempt,
  addAuthorizedCostComponent,
  assertPlacementAttemptFence,
  assertPlacementAuthority,
  countEligiblePlacementQuestions,
  finishPlacementAttempt,
  markAttemptVerifying,
  placementAttemptVerificationSettled,
  placementDeliveryMetadata,
  placementFulfillmentDisposition,
  recordPlacementAttemptOutput,
  releaseAuthorizedPaidCall,
  renewPlacementAttempt,
  reserveAuthorizedPaidCall,
  reservePlacementGenerationCall,
  settleAuthorizedPaidCall,
  startPlacementAttemptHeartbeat,
  terminalizeLostPlacementDelivery,
  terminalizePlacementUnknownCost,
} from './server/question-supply/placement-starter-attempts';
export type { PlacementStarterIdentity } from './server/question-supply/placement-starter-identity';
export {
  placementStarterAttemptId,
  placementStarterIdentity,
} from './server/question-supply/placement-starter-identity';
export type { PlacementStarterGoalAuthority } from './server/question-supply/placement-starter-store';
export {
  addPlacementStarterCostComponent,
  addPlacementStarterKnowledgeToExplicitGoal,
  authorizePlacementStarterQuestion,
  ensurePlacementStarterKnowledgeAndClaim,
  markPlacementStarterClaimTerminal,
  materializePlacementStartersForGoal,
  recordPlacementStarterAttempt,
  resolvePlacementStarterGoalAuthority,
} from './server/question-supply/placement-starter-store';
export { lockPlacementSupplyScopes } from './server/question-supply/placement-supply-lock';
export { planSupplyRoutes } from './server/question-supply/route-planner';
export type {
  DifficultyBand,
  FrontierKnowledgeInput,
  PoolQuestion,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
  SupplyRoute,
} from './server/question-supply/target-discovery';
export {
  COVERAGE_DEPTH_THRESHOLD,
  NEAR_WINDOW,
  acquisitionTierForQuestion,
  assembleScanInput,
  discoverSupplyTargets,
  scanCoverageGaps,
  seedGenerationMethod,
  seedRoutePreference,
  targetFingerprint,
} from './server/question-supply/target-discovery';
export {
  MEM0_PRIOR_BLOCK_CHAR_CAP,
  MEM0_PRIOR_CAP,
  MEM0_PRIOR_ITEM_CHAR_CAP,
  SELECTION_ORCHESTRATOR_CANDIDATE_CAP,
} from './server/selection-constants';

// YUK-892 — due-review queue reader for non-LLM read paths (today summary).
export { executeGetReviewDue } from './server/tools/question-context';
