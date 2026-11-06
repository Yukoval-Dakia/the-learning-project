/**
 * Task kinds whose grading slices carry a model+contract admission pin.
 * Dependency-free so the admin config facts seam can tell the editor which
 * task rows invalidate admitted slices when their model or reasoning changes,
 * without importing the slice registry (DB schema + provider resolution).
 */
export const MODEL_SLICE_PINNED_TASK_KINDS = [
  'JevScoringDecisionTask',
  'AssessmentRubricJudgeTask',
  'AssessmentRuleJudgeTask',
] as const;
