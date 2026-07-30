import { JudgeOnEvent, ReviewOnQuestion } from '@/core/schema/event/known';
import { InterventionDiagnosticQuestionMetadata } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { and, desc, eq } from 'drizzle-orm';
import { recordInterventionDiagnosticReview } from './store';

async function loadLatestTrustedDiagnosticVerdict(db: Db, reviewEventId: string) {
  const candidates = await db
    .select({ id: event.id })
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
    if (!enveloped || enveloped.correction_status.state !== 'active') continue;
    const parsed = JudgeOnEvent.safeParse(enveloped);
    if (!parsed.success) continue;
    const verdict = parsed.data.payload.coarse_outcome;
    if (verdict !== 'correct' && verdict !== 'partial' && verdict !== 'incorrect') continue;
    const provenance = parsed.data.payload.execution_provenance;
    if (provenance?.kind !== 'invoked' && provenance?.kind !== 'supplied_verified') continue;
    return { event: enveloped, verdict };
  }
  return null;
}

export async function handleInterventionDiagnosticJudgeDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const source = await getEventById(db, delivery.sourceEventId);
  if (!source) throw new Error(`judge event '${delivery.sourceEventId}' was not found`);
  const sourceJudge = JudgeOnEvent.safeParse(source);
  if (!sourceJudge.success) {
    return { status: 'skipped', reason: `source '${source.action}' is not a canonical judge` };
  }

  const review = await getEventById(db, sourceJudge.data.subject_id);
  if (!review) {
    return { status: 'skipped', reason: `review '${sourceJudge.data.subject_id}' was not found` };
  }
  if (review.correction_status.state !== 'active') {
    return {
      status: 'skipped',
      reason: `review '${review.id}' is ${review.correction_status.state}`,
    };
  }
  const parsedReview = ReviewOnQuestion.safeParse(review);
  if (!parsedReview.success) {
    return { status: 'skipped', reason: 'judge target is not a canonical question review' };
  }

  const [questionRow] = await db
    .select({ metadata: question.metadata })
    .from(question)
    .where(eq(question.id, parsedReview.data.subject_id))
    .limit(1);
  if (!questionRow) {
    return {
      status: 'skipped',
      reason: `question '${parsedReview.data.subject_id}' was not found`,
    };
  }
  const metadata = InterventionDiagnosticQuestionMetadata.safeParse(
    questionRow.metadata?.intervention_diagnostic,
  );
  if (!metadata.success) {
    return { status: 'skipped', reason: 'judge is not for an intervention diagnostic' };
  }

  const effective = await loadLatestTrustedDiagnosticVerdict(db, review.id);
  if (!effective) {
    return { status: 'skipped', reason: 'diagnostic has no active trusted judge verdict' };
  }

  const result = await recordInterventionDiagnosticReview(db, {
    interventionId: metadata.data.intervention_id,
    version: metadata.data.intervention_version,
    diagnosticKind: metadata.data.diagnostic_kind,
    questionId: parsedReview.data.subject_id,
    reviewEventId: review.id,
    verdictEventId: effective.event.id,
    passed: effective.verdict === 'correct',
    reviewedAt: review.created_at,
    now: effective.event.created_at,
  });
  if (result.status === 'skipped') {
    return { status: 'skipped', reason: result.reason };
  }
  return {
    status: 'succeeded',
    detail: {
      intervention_id: result.intervention.id,
      intervention_version: result.intervention.version,
      diagnostic_kind: result.diagnostic_kind,
      intervention_status: result.intervention.status,
      verdict_event_id: effective.event.id,
      idempotent: result.status === 'already_recorded',
    },
  };
}

export const buildInterventionDiagnosticJudgeSubscriber: EventSubscriptionHandlerFactory = (
  db: Db,
) => {
  return (delivery) => handleInterventionDiagnosticJudgeDelivery(db, delivery);
};
