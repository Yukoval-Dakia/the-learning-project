// YUK-1664 — result-event trigger for the system's serving recheck (LIGHT).
//
// `experimental:assessment_publish` is the declared result action that covers
// both hold transitions this subscriber serves:
//   - admission verdict persisted through publishQuestionGroup (withheld with a
//     verification_failed / no_admitted_executor reason → admission_failed);
//   - source_verify's suspend publish (suspended + source_verify@1 failed →
//     source_check_failed).
// `experimental:source_verify` is written by the source_verify job but is not a
// declared action, so the trigger derives from the publish event instead.
// A stuck `awaiting_admission` (lost admission dispatch) is already covered by
// the durable question-admission-enqueue delivery plus the
// recoverOrphanVerifyDispatches fallback in verify_dispatch_recover.
//
// The handler only pokes runSystemServingRecheck with the event's question
// group; the projection decides whether a recheck is owed. A failure here must
// throw — the delivery stays pending and retries.

import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import type { EventSubscriptionDelivery, EventSubscriptionOutcome } from '@/kernel/manifest';
import { runSystemServingRecheck } from './serving-actions';

/**
 * Cheap pre-filter: a publish that cannot have produced admission_failed or
 * source_check_failed skips the projection read entirely. Suspension and
 * failed verification rows ride the same event, so the filter stays loose.
 */
function carriesHoldSignal(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (record.admission === 'withheld' || record.suspended === true) return true;
  const verification = record.verification;
  if (verification != null && typeof verification === 'object') {
    const outcome = (verification as Record<string, unknown>).outcome;
    return outcome === 'failed' || outcome === 'suspended';
  }
  return false;
}

async function serveDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const [source] = await db
    .select({
      subjectKind: event.subject_kind,
      subjectId: event.subject_id,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, delivery.sourceEventId))
    .limit(1);
  if (source?.subjectKind !== 'question' || source.subjectId == null) {
    return { status: 'skipped', reason: 'not a question publish event' };
  }
  if (!carriesHoldSignal(source.payload)) {
    return { status: 'skipped', reason: 'publish carries no hold signal' };
  }
  const report = await runSystemServingRecheck(db, { groupIds: [source.subjectId] });
  if (report.attempted.length === 0 && report.replayed.length === 0) {
    return {
      status: 'skipped',
      reason: report.skipped[0]?.reason ?? 'no recheckable hold',
      detail: { group_id: source.subjectId },
    };
  }
  return {
    status: 'succeeded',
    detail: { attempted: report.attempted, replayed: report.replayed },
  };
}

export const buildServingRecheckSubscriber = (db: Db) => (delivery: EventSubscriptionDelivery) =>
  serveDelivery(db, delivery);
