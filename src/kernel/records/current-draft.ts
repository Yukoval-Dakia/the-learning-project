import { eq } from 'drizzle-orm';
import { DraftFocus, type DraftFocusT } from '@/core/schema/assessment/draft-focus';
import type { Db, Tx } from '@/db/client';
import { assessment_response_draft, assessment_submission } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { withStudyAuthorization } from './hint-continuity';

export async function readFocusedSavedDraft(tx: Tx, focus: DraftFocusT) {
  const [submission] = await tx
    .select({ id: assessment_submission.submission_id })
    .from(assessment_submission)
    .where(eq(assessment_submission.issuance_id, focus.issuance_id));
  const [draft] = await tx
    .select()
    .from(assessment_response_draft)
    .where(eq(assessment_response_draft.issuance_id, focus.issuance_id));
  if (submission || !draft || draft.save_epoch !== focus.save_epoch)
    throw new ApiError('draft_focus_stale', 'the focused saved draft is no longer current', 409);
  return draft;
}

/** Called only while accepting an explicit authenticated Companion ask. */
export async function captureDraftFocus(db: Db | Tx, raw: DraftFocusT) {
  const focus = DraftFocus.parse(raw);
  return withStudyAuthorization(
    db,
    { issuanceId: focus.issuance_id, questionId: focus.question_id },
    async (tx, c, binding, sources, sourceEpochs) => {
      if (c.revision.revision_id !== focus.revision_id)
        throw new ApiError('draft_focus_stale', 'revision differs', 409);
      await readFocusedSavedDraft(tx, focus);
      return {
        ...focus,
        binding_digest: binding,
        source_digest: sources,
        source_usage_epochs: sourceEpochs,
      };
    },
  );
}
