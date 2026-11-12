import { randomUUID } from 'node:crypto';
import type { Db } from '@/db/client';
import { getEventById } from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { getEffectiveProbeResultStatuses } from '@/kernel/read-models/probe-evidence';
import { getStartedBoss } from '@/server/boss/client';
import { lockInterventionCorrectionsAll, lockInterventionSource } from './intervention-lock';
import {
  type InterventionPreparationBoss,
  drainInterventionPreparationDispatch,
} from './preparation-dispatch';
import {
  InterventionSourceProbeResultPayload,
  buildInterventionSnapshotFromProbeResult,
  interventionDeliveryMode,
  interventionIdentityForProbeResult,
} from './snapshot';
import {
  insertInterventionVersion,
  loadInterventionBySourceProbeResult,
  updatePreparationJobId,
} from './store';

interface ProbeResultSubscriptionDeps {
  boss?: InterventionPreparationBoss;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function handleProbeResultInterventionDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: ProbeResultSubscriptionDeps = {},
): Promise<EventSubscriptionOutcome> {
  const source = await getEventById(db, delivery.sourceEventId);
  if (!source) throw new Error(`probe result '${delivery.sourceEventId}' was not found`);
  if (source.action !== 'experimental:probe_result') {
    return { status: 'skipped', reason: `unexpected source action '${source.action}'` };
  }
  const payload = recordPayload(source.payload);
  const eligiblePayload = InterventionSourceProbeResultPayload.safeParse(payload);
  if (!eligiblePayload.success) {
    return {
      status: 'skipped',
      reason:
        payload.resolution === 'evidence_for' && payload.outcome === 0
          ? 'probe result has no gradable target-error response signature match'
          : `probe result resolution '${String(payload.resolution)}' does not open an intervention`,
    };
  }
  const effective = await getEffectiveProbeResultStatuses(db, [source.id], {
    validateDirectChain: true,
  });
  if (effective.get(source.id) !== 'active') {
    return {
      status: 'skipped',
      reason: `probe result '${source.id}' is not effective active evidence`,
    };
  }

  const now = deps.now?.() ?? new Date();
  const identity = interventionIdentityForProbeResult(delivery.sourceEventId);

  // The business transaction binds the durable delivery identity on the
  // aggregate. No engine call happens inside it: a commit leaves the obligation
  // durable, a rollback leaves nothing at all.
  const record = await db.transaction(async (tx) => {
    await lockInterventionCorrectionsAll(tx);
    await lockInterventionSource(tx, delivery.sourceEventId);
    const existing = await loadInterventionBySourceProbeResult(tx, delivery.sourceEventId);
    if (existing) {
      if (existing.status !== 'preparing' || existing.preparation_job_id) {
        // Already bound (or already decided): the drain owns the engine side.
        return existing;
      }
      // A replay over a restored aggregate binds a fresh delivery identity.
      const minted = randomUUID();
      await updatePreparationJobId(tx, existing.id, existing.version, minted, now);
      return { ...existing, preparation_job_id: minted, updated_at: now };
    }

    const snapshot = await buildInterventionSnapshotFromProbeResult(tx, {
      sourceProbeResultEventId: delivery.sourceEventId,
      interventionId: identity.interventionId,
      version: 1,
      now,
      env: deps.env,
    });
    return insertInterventionVersion(tx, {
      id: identity.interventionId,
      version: 1,
      sourceProbeResultEventId: delivery.sourceEventId,
      conjectureEventId: snapshot.conjecture.conjecture_id,
      deliveryMode: interventionDeliveryMode(deps.env ?? process.env),
      idempotencyKey: identity.idempotencyKey,
      preparationJobId: randomUUID(),
      snapshot,
      now,
    });
  });

  // Engine delivery happens after the aggregate commits, through the same
  // drain the recovery floor uses. A throw retries the delivery; the replay is
  // idempotent on the aggregate and the persisted job id.
  if (record.status === 'preparing') {
    const boss = deps.boss ?? ((await getStartedBoss()) as InterventionPreparationBoss);
    await drainInterventionPreparationDispatch(
      db,
      boss,
      { interventionId: record.id, version: record.version },
      now,
    );
  }

  return {
    status: 'succeeded',
    detail: {
      intervention_id: record.id,
      version: record.version,
      intervention_status: record.status,
      delivery_mode: record.delivery_mode,
      preparation_job_id: record.preparation_job_id,
      source_event_id: delivery.sourceEventId,
    },
  };
}

export const buildProbeResultInterventionSubscriber: EventSubscriptionHandlerFactory = (db: Db) => {
  return (delivery) => handleProbeResultInterventionDelivery(db, delivery);
};
