import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { assessment_issuance, question_revision } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { createFormalModelExecutor } from '../judge/evaluate-submission';
import { type GradingEntryPoint, evaluateAttempt } from '../judge/evaluation-authority';
import { type SaveSubmissionRequest, saveSubmission } from './submit';

/** Formal entry input already carries the issuance served to the learner. */
export async function previewFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  signal?: AbortSignal,
) {
  const [issuance] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, request.issuance_id))
    .limit(1);
  if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
  const [revision] = await database
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (!revision || (revision.group_id !== questionId && !issuance.part_ids.includes(questionId))) {
    throw new ApiError('coordinate_mismatch', 'question is outside the frozen issuance', 409);
  }
  const saved = await saveSubmission(database, { ...request, actorRef: `assessment:${entry}` });
  if (!('submission' in saved)) {
    throw new ApiError(
      saved.status,
      saved.conflict_reason ?? saved.issues?.join('; ') ?? 'submission not accepted',
      409,
    );
  }
  const candidate = await evaluateAttempt({
    db: database,
    entry,
    contract: {
      submission_id: saved.submission.submission_id,
      evaluation_group_id: saved.submission.evaluation_group_id,
      evaluation_key: `submission:${saved.submission.submission_id}`,
      model_executor: createFormalModelExecutor(database, signal),
    },
  });
  return { candidate, submission: saved.submission };
}
