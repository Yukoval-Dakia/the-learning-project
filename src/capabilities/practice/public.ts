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
export {
  authorInterventionPackage,
  validateInterventionPackageDeterministically,
} from './server/intervention-author';
export type { InterventionAuthorDeps } from './server/intervention-author';
export {
  loadCommittedInterventionDiagnosticAttempt,
  loadLatestTrustedInterventionDiagnosticVerdict,
  materializeInterventionDiagnostics,
  retireInterventionDiagnosticQuestion,
} from './server/intervention-diagnostics';
export type { CommittedInterventionDiagnosticAttempt } from './server/intervention-diagnostics';
