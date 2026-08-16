import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/server/conjecture/probe-evidence';
import type { Db, Tx } from '@/db/client';
import {
  eventCorrectionLockKey,
  eventCorrectionsGlobalLockKey,
  getEventById,
} from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { getStartedBoss } from '@/server/boss/client';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
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

export const PREPARE_INTERVENTION_JOB = 'prepare_intervention';

export interface PrepareInterventionJobData {
  intervention_id: string;
  version: number;
  idempotency_key: string;
}

export type PrepareInterventionBossSend = (
  name: typeof PREPARE_INTERVENTION_JOB,
  data: PrepareInterventionJobData,
  options: {
    db: ReturnType<typeof fromPgBossDrizzleTx>;
    id: string;
  },
) => Promise<string | null>;

interface ProbeResultSubscriptionDeps {
  bossSend?: PrepareInterventionBossSend;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function enqueuePreparation(
  tx: Tx,
  send: PrepareInterventionBossSend,
  data: PrepareInterventionJobData,
  reservedJobId: string,
): Promise<string> {
  const jobId = await send(PREPARE_INTERVENTION_JOB, data, {
    db: fromPgBossDrizzleTx(tx),
    id: reservedJobId,
  });
  // pg-boss returns null when this exact id already exists. That is the desired
  // duplicate-delivery result, not an enqueue failure: the aggregate already owns
  // the stable reserved id and must not spin the subscription forever.
  return jobId ?? reservedJobId;
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

  let send = deps.bossSend;
  if (!send) {
    const boss = await getStartedBoss();
    send = boss.send.bind(boss) as PrepareInterventionBossSend;
  }
  const now = deps.now?.() ?? new Date();
  const identity = interventionIdentityForProbeResult(delivery.sourceEventId);

  const record = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionsGlobalLockKey()}, 0))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionLockKey(delivery.sourceEventId)}, 0))`,
    );
    const existing = await loadInterventionBySourceProbeResult(tx, delivery.sourceEventId);
    if (existing) {
      if (existing.status !== 'preparing') return existing;
      // A subscription replay (including post-restore recovery) may need to
      // recreate the operational pg-boss row. Business idempotency stays on the
      // persisted intervention aggregate; singleton throttling only reduces
      // duplicate queue traffic and never bears correctness.
      const reservedJobId = existing.preparation_job_id ?? randomUUID();
      const jobId = await enqueuePreparation(
        tx,
        send,
        {
          intervention_id: existing.id,
          version: existing.version,
          idempotency_key: existing.idempotency_key,
        },
        reservedJobId,
      );
      await updatePreparationJobId(tx, existing.id, existing.version, jobId, now);
      return { ...existing, preparation_job_id: jobId, updated_at: now };
    }

    const snapshot = await buildInterventionSnapshotFromProbeResult(tx, {
      sourceProbeResultEventId: delivery.sourceEventId,
      interventionId: identity.interventionId,
      version: 1,
      now,
      env: deps.env,
    });
    const reservedJobId = randomUUID();
    const jobId = await enqueuePreparation(
      tx,
      send,
      {
        intervention_id: identity.interventionId,
        version: 1,
        idempotency_key: identity.idempotencyKey,
      },
      reservedJobId,
    );
    return insertInterventionVersion(tx, {
      id: identity.interventionId,
      version: 1,
      sourceProbeResultEventId: delivery.sourceEventId,
      conjectureEventId: snapshot.conjecture.conjecture_id,
      deliveryMode: interventionDeliveryMode(deps.env ?? process.env),
      idempotencyKey: identity.idempotencyKey,
      preparationJobId: jobId,
      snapshot,
      now,
    });
  });

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
