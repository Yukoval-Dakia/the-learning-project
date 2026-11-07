import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  STUDY_ASSISTANCE_ACTION,
  type StudyAssistanceImpact,
  type StudyAssistancePhase,
  recordStudyAssistanceExposure,
} from '@/kernel/records/study-reference';

export type AssistanceImpact = StudyAssistanceImpact;
export type AssistancePhase = StudyAssistancePhase;
export type AssistanceStatus = 'independent' | 'assisted' | 'unknown';

export interface AssistanceReceipt {
  status: AssistanceStatus;
  event_ids: string[];
  /** Deepest hint-ladder rung proven by the events; null when it cannot be bounded. */
  max_dose: number | null;
  /** Sorted unique exposure kinds present in the receipt. */
  kinds: Array<'hint' | 'solution' | 'chat_context'>;
  /** 'after_submit' once any v2 event was recorded post-submit; null when a v1 event leaves the phase unprovable. */
  phase: AssistancePhase | null;
}

/** Server classification only. A stage number is not evidence of harmlessness. */
export async function recordAssistanceExposure(
  database: Db | Tx,
  input: {
    issuanceId: string;
    questionId: string;
    kind: 'hint' | 'solution' | 'chat_context';
    impact: AssistanceImpact;
    contentDigest: string;
    dose?: number;
  },
) {
  return recordStudyAssistanceExposure(database, {
    ...input,
    actorRef: 'assessment:assistance',
  });
}

export async function snapshotIssuanceAssistance(
  tx: Db | Tx,
  issuanceId: string,
): Promise<AssistanceReceipt> {
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
  return projectAssistanceRows(rows);
}

/**
 * Read the assistance snapshot sealed into a submission event. Old receipts
 * without a server snapshot return null rather than being upgraded.
 */
export async function readSubmissionAssistanceReceipt(
  database: Db | Tx,
  submissionId: string,
): Promise<AssistanceReceipt | null> {
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
  if (!assistance || typeof assistance !== 'object' || !('status' in assistance)) return null;
  const snapshot = assistance as Partial<AssistanceReceipt> & {
    status: AssistanceStatus;
    event_ids?: unknown;
  };
  if (!['independent', 'assisted', 'unknown'].includes(snapshot.status)) return null;
  return {
    status: snapshot.status,
    event_ids: Array.isArray(snapshot.event_ids) ? snapshot.event_ids : [],
    max_dose: typeof snapshot.max_dose === 'number' ? snapshot.max_dose : null,
    kinds: Array.isArray(snapshot.kinds) ? snapshot.kinds : [],
    phase:
      snapshot.phase === 'before_submit' || snapshot.phase === 'after_submit'
        ? snapshot.phase
        : null,
  };
}

/**
 * Fold assistance events into the sealed receipt. A v1 event has no dose and
 * no phase: it keeps `max_dose`/`phase` unprovable (null) and can never be
 * upgraded to independent.
 */
function projectAssistanceRows(
  rows: Array<{ id: string; payload: Record<string, unknown> }>,
): AssistanceReceipt {
  const impacts = rows.map((row) => row.payload.impact);
  const kinds = [
    ...new Set(rows.map((row) => row.payload.kind as AssistanceReceipt['kinds'][number])),
  ].sort();
  const v2Rows = rows.filter((row) => row.payload.version === 2);
  const unknownVersion = v2Rows.length !== rows.length;
  const hintDoses = v2Rows
    .filter((row) => row.payload.kind === 'hint')
    .map((row) => row.payload.dose);
  const maxDose =
    !unknownVersion && hintDoses.every((dose) => typeof dose === 'number')
      ? hintDoses.length > 0
        ? Math.max(...(hintDoses as number[]))
        : null
      : null;
  const phase: AssistancePhase | null = v2Rows.some((row) => row.payload.phase === 'after_submit')
    ? 'after_submit'
    : unknownVersion
      ? null
      : 'before_submit';
  return {
    status: impacts.includes('answer_help')
      ? ('assisted' as const)
      : impacts.some((impact) => impact !== 'harmless_clarification')
        ? ('unknown' as const)
        : ('independent' as const),
    event_ids: rows.map((row) => row.id).sort(),
    max_dose: maxDose,
    kinds,
    phase,
  };
}

export async function submissionWasAssisted(
  database: Db | Tx,
  submissionId: string,
): Promise<boolean> {
  const receipt = await readSubmissionAssistanceReceipt(database, submissionId);
  // Historical receipts without a server snapshot cannot prove independence.
  return !(receipt && receipt.status === 'independent');
}
