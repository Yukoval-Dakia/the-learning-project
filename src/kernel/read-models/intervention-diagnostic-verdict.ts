import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { JudgeOnEvent } from '@/core/schema/event/known';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import { resolveVerdictsForNativeAttempts } from '@/kernel/read-models/assessment-verdict';

export async function loadLatestTrustedInterventionDiagnosticVerdict(
  db: Db,
  reviewEventId: string,
) {
  const candidates = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, reviewEventId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  for (const candidate of candidates) {
    const enveloped = await getEventById(db, candidate.id);
    if (enveloped?.correction_status.state !== 'active') continue;
    const parsed = JudgeOnEvent.safeParse(enveloped);
    if (!parsed.success || parsed.data.payload.judge_route !== 'multimodal_direct') continue;
    const verdict = parsed.data.payload.coarse_outcome;
    if (verdict !== 'correct' && verdict !== 'partial' && verdict !== 'incorrect') continue;
    const provenance = parsed.data.payload.execution_provenance;
    if (provenance?.kind !== 'invoked' && provenance?.kind !== 'supplied_verified') continue;
    const rawPayload =
      candidate.payload && typeof candidate.payload === 'object'
        ? (candidate.payload as Record<string, unknown>)
        : {};
    return {
      event: enveloped,
      verdict,
      confidence: parsed.data.payload.cause.confidence,
      feedbackMd:
        typeof rawPayload.feedback_md === 'string' && rawPayload.feedback_md.trim()
          ? rawPayload.feedback_md
          : null,
    } as const;
  }
  return null;
}

/** Immutable original metadata and current head, including a non-diagnostic replacement. */
export async function loadNativeInterventionDiagnosticState(db: Db | Tx, attemptId: string) {
  const review = await getEventById(db, attemptId);
  if (!review) return null;
  const [anchor] = await db.select().from(event).where(eq(event.id, attemptId));
  if (!anchor) return null;
  const resolved = (await resolveVerdictsForNativeAttempts(db, [anchor])).get(attemptId);
  const effective = resolved?.effective;
  if (!resolved || !effective) return null;
  const trusted =
    review.correction_status.state === 'active' &&
    effective.status === 'completed' &&
    effective.row.provenance?.source === 'automatic' &&
    effective.row.provenance.assisted === false &&
    effective.row.run_refs.length > 0 &&
    effective.verdict.verdict !== 'unsupported';
  const [original] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_submission'),
        eq(event.subject_kind, 'submission'),
        eq(event.subject_id, resolved.submission.submission_id),
      ),
    )
    .limit(1);
  const scope = z
    .object({
      version: z.literal(1),
      group_id: z.string(),
      questions: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          intervention_diagnostic: InterventionDiagnosticQuestionMetadata.optional(),
        }),
      ),
    })
    .safeParse(original?.payload.learning_scope);
  if (!scope.success) return null;
  const frozenQuestion = scope.data.questions.find((row) => row.id === review.subject_id);
  if (
    frozenQuestion?.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE ||
    !frozenQuestion.intervention_diagnostic
  )
    return null;
  const [activation] = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_activation'),
        eq(event.subject_kind, 'evaluation_group'),
        eq(event.subject_id, resolved.evaluation_group_id),
        sql`${event.payload}->>'effective_evaluation_id' = ${effective.evaluation_id}`,
        sql`${event.payload}->>'generation' = ${String(resolved.head?.generation)}`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  if (
    !activation ||
    activation.payload.question_group_id !== scope.data.group_id ||
    activation.payload.submission_id !== resolved.submission.submission_id
  )
    return null;
  // Invalidating the original changes the aggregate even if its evaluation head did not move.
  const verdictEvent =
    review.correction_status.state === 'active'
      ? activation
      : await getEventById(db, review.correction_status.correction_event_id);
  if (!verdictEvent) return null;
  return {
    review,
    metadata: frozenQuestion.intervention_diagnostic,
    effective,
    activation,
    verdictEvent,
    trusted,
  };
}

export async function loadNativeInterventionDiagnosticVerdict(db: Db | Tx, attemptId: string) {
  const state = await loadNativeInterventionDiagnosticState(db, attemptId);
  return state?.trusted ? state : null;
}
