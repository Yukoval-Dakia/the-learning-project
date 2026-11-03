// Settlement seam: atomic activation, learning-scope snapshot and settlement. Grading's
// evaluate-submission still calls it inline until settlement consumes evaluation results
// itself (docs/design/2026-11-03-practice-split.md §3.1 item 1).

export { type ActivateEvaluationRequestT, activateEvaluation } from './activate';
export { snapshotAssessmentLearningScope } from './learning-scope';
export { learningSettlement, withdrawCapturedOccurrence } from './settle';
export type { SettlementObservers } from './settle-apply';
