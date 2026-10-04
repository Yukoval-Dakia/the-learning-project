import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { assessment_issuance, event, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';

const ACTION = 'experimental:assessment_assistance';
export type AssistanceImpact = 'answer_help' | 'harmless_clarification' | 'unknown';

/** Server classification only. A stage number is not evidence of harmlessness. */
export async function recordAssistanceExposure(
  database: Db,
  input: {
    issuanceId: string;
    questionId: string;
    kind: 'hint' | 'solution';
    impact: AssistanceImpact;
    contentDigest: string;
  },
) {
  return database.transaction(async (tx) => {
    // Shares the issuance lock with saveSubmission: the accepted answer snapshots
    // every exposure already released, without trusting client clocks or flags.
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, input.issuanceId))
      .for('update')
      .limit(1);
    if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
    const [revision] = await tx
      .select({ group_id: question_revision.group_id })
      .from(question_revision)
      .where(eq(question_revision.revision_id, issuance.revision_id))
      .limit(1);
    if (
      !revision ||
      (revision.group_id !== input.questionId && !issuance.part_ids.includes(input.questionId))
    ) {
      throw new ApiError('coordinate_mismatch', 'assistance is outside the frozen issuance', 409);
    }
    return writeEvent(tx, {
      id: `evt_help_${createId()}`,
      actor_kind: 'system',
      actor_ref: 'assessment:assistance',
      action: ACTION,
      subject_kind: 'issuance',
      subject_id: input.issuanceId,
      outcome: null,
      payload: {
        version: 1,
        kind: input.kind,
        impact: input.impact,
        content_digest: input.contentDigest,
      },
    });
  });
}

export async function snapshotIssuanceAssistance(tx: Db | Tx, issuanceId: string) {
  const rows = await tx
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ACTION),
        eq(event.subject_kind, 'issuance'),
        eq(event.subject_id, issuanceId),
      ),
    );
  const impacts = rows.map((row) => row.payload.impact);
  return {
    status: impacts.includes('answer_help')
      ? ('assisted' as const)
      : impacts.some((impact) => impact !== 'harmless_clarification')
        ? ('unknown' as const)
        : ('independent' as const),
    event_ids: rows.map((row) => row.id).sort(),
  };
}

export async function submissionWasAssisted(database: Db, submissionId: string): Promise<boolean> {
  const [receipt] = await database
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_submission'),
        eq(event.subject_kind, 'submission'),
        eq(event.subject_id, submissionId),
      ),
    )
    .limit(1);
  const assistance = receipt?.payload.assistance;
  // Historical receipts without a server snapshot cannot prove independence.
  return !(
    assistance &&
    typeof assistance === 'object' &&
    'status' in assistance &&
    assistance.status === 'independent'
  );
}
