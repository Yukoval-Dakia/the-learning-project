// The WorkflowJudge confidence stored with a captured question is a learner-facing
// signal, not a grade. Both the ingestion review surface and the practice question
// detail read it from the same metadata shape so the two cannot drift.

export function readWorkflowJudgeConfidence(metadata: unknown): number | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const judge = (metadata as Record<string, unknown>).workflow_judge;
  if (judge === null || typeof judge !== 'object' || Array.isArray(judge)) return null;
  const confidence = (judge as Record<string, unknown>).confidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
}
