// YUK-1664 — an answered probe is an open obligation, not nightly timetable work.
// This subscription reconciles the typed ledger when the probe_result lands instead of
// waiting for the paid nightly meeting. The nightly run still sweeps anything left
// over; both callers go through reconcileResearchMeetingExecution, which serializes
// them on the shared conjecture-reconcile advisory lock, so a probe is scored exactly
// once whichever runs first. The reconcile is deterministic — no model call.
//
// executionId = the probe_result event id. The derived reconciliation checkpoint is
// deterministic, so a redelivery returns the committed result without re-scanning.
import type { Db } from '@/db/client';
import { getEventById } from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { reconcileResearchMeetingExecution } from './reconciliation-execution';

interface ProbeResultReconcileDeps {
  now?: () => Date;
  reconcileExecutionFn?: typeof reconcileResearchMeetingExecution;
}

export async function handleProbeResultReconcileDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: ProbeResultReconcileDeps = {},
): Promise<EventSubscriptionOutcome> {
  const source = await getEventById(db, delivery.sourceEventId);
  // A missing source is a propagation failure, not a skip: throwing retries the delivery.
  if (!source) throw new Error(`probe result '${delivery.sourceEventId}' was not found`);
  if (source.action !== 'experimental:probe_result') {
    return { status: 'skipped', reason: `unexpected source action '${source.action}'` };
  }
  const reconcileExecutionFn = deps.reconcileExecutionFn ?? reconcileResearchMeetingExecution;
  const result = await reconcileExecutionFn(db, delivery.sourceEventId, deps.now?.() ?? new Date());
  return {
    status: 'succeeded',
    detail: { reconciled: result.reconciled, skipped: result.skipped },
  };
}

export const buildProbeResultReconcileSubscriber: EventSubscriptionHandlerFactory = (db: Db) => {
  return (delivery) => handleProbeResultReconcileDelivery(db, delivery);
};
