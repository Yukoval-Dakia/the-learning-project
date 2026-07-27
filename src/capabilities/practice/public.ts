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
export { handleReviewDue } from './server/due-list';
export type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from './server/proposal-appliers';
