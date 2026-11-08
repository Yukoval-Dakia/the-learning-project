// The WorkflowJudge confidence stored with a captured question is a learner-facing
// signal, not a grade. Both the ingestion review surface and the practice question
// detail read it from the same metadata shape so the two cannot drift.

export function readWorkflowJudgeConfidence(metadata: unknown): number | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  // Rows captured by manual/rescue enrollment before the write-side gate still carry
  // a workflow_judge blob with confidence 0 although no judge ran. The enrollment
  // provenance is the only reliable way to tell; when it is absent the stored blob
  // stands as written because it cannot be distinguished from a real verdict.
  const enrollment = record.ingestion_enrollment;
  const enrolledBy =
    enrollment !== null && typeof enrollment === 'object' && !Array.isArray(enrollment)
      ? (enrollment as Record<string, unknown>).enrolled_by
      : undefined;
  if (typeof enrolledBy === 'string' && enrolledBy !== 'workflow_judge') return null;
  const judge = record.workflow_judge;
  if (judge === null || typeof judge !== 'object' || Array.isArray(judge)) return null;
  const confidence = (judge as Record<string, unknown>).confidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
}
