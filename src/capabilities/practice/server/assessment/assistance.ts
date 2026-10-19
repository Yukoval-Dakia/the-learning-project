import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  STUDY_ASSISTANCE_ACTION,
  type StudyAssistanceImpact,
  recordStudyAssistanceExposure,
} from '@/kernel/records/study-reference';

export type AssistanceImpact = StudyAssistanceImpact;

/** Server classification only. A stage number is not evidence of harmlessness. */
export async function recordAssistanceExposure(
  database: Db | Tx,
  input: {
    issuanceId: string;
    questionId: string;
    kind: 'hint' | 'solution' | 'chat_context';
    impact: AssistanceImpact;
    contentDigest: string;
  },
) {
  return recordStudyAssistanceExposure(database, {
    ...input,
    actorRef: 'assessment:assistance',
  });
}

export async function snapshotIssuanceAssistance(tx: Db | Tx, issuanceId: string) {
  const rows = await tx
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, STUDY_ASSISTANCE_ACTION),
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

export async function submissionWasAssisted(
  database: Db | Tx,
  submissionId: string,
): Promise<boolean> {
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
