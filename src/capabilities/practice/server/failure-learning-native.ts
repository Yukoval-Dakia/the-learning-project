import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { loadAssessmentLearningScope } from '@/kernel/read-models/assessment-learning-scope';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { projectFrozenStudyContext } from './assessment/study-context';
import { getFailureAttemptById } from './attempt-events';

/** Content and scope for attribution come from the original issuance and submission. */
export async function loadNativeFailureContext(db: Db | Tx, attemptEventId: string) {
  const [anchor] = await db.select().from(event).where(eq(event.id, attemptEventId));
  if (anchor?.action !== 'experimental:assessment_attempt') return null;
  const verdict = (await resolveVerdictsForNativeAttempts(db, [anchor])).get(anchor.id);
  if (!verdict?.effective || nativeAttemptOutcome(verdict) !== 'failure') return null;
  if (!(await getFailureAttemptById(db, attemptEventId))) return null;
  const scope = await loadAssessmentLearningScope(
    db,
    verdict.submission.submission_id,
    verdict.revision.group_id,
  );
  if (!scope) return null;
  const context = projectFrozenStudyContext(verdict.revision, verdict.issuance);
  const entries = verdict.submission.response_set.entries;
  // The attribution task is text-only. Image metadata is not the student's image content.
  if (
    !entries.some((entry) =>
      entry.kind === 'text' || entry.kind === 'open' ? entry.text_md.trim().length > 0 : true,
    )
  )
    return null;
  return {
    question: scope.questions.find((item) => item.id === verdict.revision.group_id),
    evaluationGroupId: verdict.submission.evaluation_group_id,
    evaluationId: verdict.effective.row.evaluation_id,
    prompt_md: `${context.prompt_md}\n\nIssued response controls:\n${JSON.stringify(context.practice_dto.response_spec)}`,
    reference_md: context.reference_md,
    answer_md: JSON.stringify(verdict.submission.response_set),
    knowledge_ids: verdict.knowledge_ids,
  };
}
