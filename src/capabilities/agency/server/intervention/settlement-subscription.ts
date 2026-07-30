import { ReviewOnQuestion } from '@/core/schema/event/known';
import { InterventionDiagnosticQuestionMetadata } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { eq } from 'drizzle-orm';
import { recordInterventionDiagnosticReview } from './store';

export async function handleInterventionDiagnosticReviewDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const source = await getEventById(db, delivery.sourceEventId);
  if (!source) throw new Error(`review event '${delivery.sourceEventId}' was not found`);
  if (source.correction_status.state !== 'active') {
    return {
      status: 'skipped',
      reason: `review '${source.id}' is ${source.correction_status.state}`,
    };
  }
  const review = ReviewOnQuestion.safeParse(source);
  if (!review.success) {
    return {
      status: 'skipped',
      reason: `source '${source.action}' is not a canonical question review`,
    };
  }
  const reviewEvent = review.data;

  const [questionRow] = await db
    .select({ metadata: question.metadata })
    .from(question)
    .where(eq(question.id, reviewEvent.subject_id))
    .limit(1);
  if (!questionRow) {
    return { status: 'skipped', reason: `question '${reviewEvent.subject_id}' was not found` };
  }
  const metadata = InterventionDiagnosticQuestionMetadata.safeParse(
    questionRow.metadata?.intervention_diagnostic,
  );
  if (!metadata.success) {
    return { status: 'skipped', reason: 'review is not an intervention diagnostic' };
  }

  const result = await recordInterventionDiagnosticReview(db, {
    interventionId: metadata.data.intervention_id,
    version: metadata.data.intervention_version,
    diagnosticKind: metadata.data.diagnostic_kind,
    questionId: reviewEvent.subject_id,
    reviewEventId: source.id,
    passed: reviewEvent.outcome === 'success',
    now: source.created_at,
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
      idempotent: result.status === 'already_recorded',
    },
  };
}

export const buildInterventionDiagnosticReviewSubscriber: EventSubscriptionHandlerFactory = (
  db: Db,
) => {
  return (delivery) => handleInterventionDiagnosticReviewDelivery(db, delivery);
};
