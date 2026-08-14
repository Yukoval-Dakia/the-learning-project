// Stable server contract for consumers outside the practice capability.
export {
  SolveError,
  buildSolveHintInput,
  parseHintTurn,
} from './server/solve-session';
export {
  isMasteredForFrontier,
  learnableFrontierResolved,
} from './server/learnable-frontier';
export type { FrontierResolution } from './server/learnable-frontier';
export { retrievabilityForKc } from './server/fsrs';
export { loadAttemptQuestionSnapshot } from './server/question-evidence-snapshot';
export { handleReviewDue } from './server/due-list';
export type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from './server/proposal-appliers';
export { authorInterventionPackage } from './server/intervention-author';
export type { InterventionAuthorDeps } from './server/intervention-author';
export {
  INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
  loadCommittedInterventionDiagnosticAttempt,
  loadLatestTrustedInterventionDiagnosticVerdict,
  materializeInterventionDiagnostics,
  retireInterventionDiagnosticQuestion,
} from './server/intervention-diagnostics';
export type { CommittedInterventionDiagnosticAttempt } from './server/intervention-diagnostics';
export { proposeFailureVariant } from './server/failure-learning-public';
export type {
  ProposeFailureVariantInput,
  VariantProposalResult,
} from './server/failure-learning-public';
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
  EvidenceDemandV1T,
  SupplyTraceV1T,
} from './server/question-supply/evidence-demand';
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
export { planSupplyRoutes } from './server/question-supply/route-planner';
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
export type {
  DifficultyBand,
  FrontierKnowledgeInput,
  PoolQuestion,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
  SupplyRoute,
} from './server/question-supply/target-discovery';
