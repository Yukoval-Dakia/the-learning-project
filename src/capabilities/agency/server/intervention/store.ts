import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/server/conjecture/probe-evidence';
import { newId } from '@/core/ids';
import {
  INTERVENTION_ACTIVATED_ACTION,
  INTERVENTION_PREPARATION_FAILED_ACTION,
  type InterventionAuthoringContextT,
  InterventionDeliveryMode,
  type InterventionDeliveryModeT,
  InterventionOutcome,
  type InterventionOutcomeT,
  InterventionPackage,
  type InterventionPackageT,
  InterventionPreparationAttempt,
  type InterventionPreparationAttemptT,
  InterventionSnapshot,
  type InterventionSnapshotT,
  InterventionStatus,
  type InterventionStatusT,
  PedagogyRecommendation,
  type PedagogyRecommendationT,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { intervention } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

type DbLike = Db | Tx;
type InterventionRow = typeof intervention.$inferSelect;

export interface InterventionRecord {
  id: string;
  version: number;
  revision: number;
  source_probe_result_event_id: string;
  conjecture_event_id: string;
  status: InterventionStatusT;
  delivery_mode: InterventionDeliveryModeT;
  outcome: InterventionOutcomeT | null;
  idempotency_key: string;
  preparation_job_id: string | null;
  snapshot: InterventionSnapshotT;
  recommendation: PedagogyRecommendationT | null;
  package: InterventionPackageT | null;
  preparation_attempts: InterventionPreparationAttemptT[];
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
}

function parseInterventionRow(row: InterventionRow): InterventionRecord {
  return {
    id: row.id,
    version: row.version,
    revision: row.revision,
    source_probe_result_event_id: row.source_probe_result_event_id,
    conjecture_event_id: row.conjecture_event_id,
    status: InterventionStatus.parse(row.status),
    delivery_mode: InterventionDeliveryMode.parse(row.delivery_mode),
    outcome: row.outcome === null ? null : InterventionOutcome.parse(row.outcome),
    idempotency_key: row.idempotency_key,
    preparation_job_id: row.preparation_job_id,
    snapshot: InterventionSnapshot.parse(row.snapshot_json),
    recommendation:
      row.recommendation_json === null
        ? null
        : PedagogyRecommendation.parse(row.recommendation_json),
    package: row.package_json === null ? null : InterventionPackage.parse(row.package_json),
    preparation_attempts: InterventionPreparationAttempt.array().parse(
      row.preparation_attempts_json,
    ),
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    activated_at: row.activated_at,
  };
}

export async function loadInterventionVersion(
  db: DbLike,
  interventionId: string,
  version: number,
): Promise<InterventionRecord | null> {
  const [row] = await db
    .select()
    .from(intervention)
    .where(and(eq(intervention.id, interventionId), eq(intervention.version, version)))
    .limit(1);
  return row ? parseInterventionRow(row) : null;
}

export async function loadLatestInterventionVersion(
  db: DbLike,
  interventionId: string,
): Promise<InterventionRecord | null> {
  const [row] = await db
    .select()
    .from(intervention)
    .where(eq(intervention.id, interventionId))
    .orderBy(desc(intervention.version))
    .limit(1);
  return row ? parseInterventionRow(row) : null;
}

export async function loadInterventionBySourceProbeResult(
  db: DbLike,
  sourceProbeResultEventId: string,
  version = 1,
): Promise<InterventionRecord | null> {
  const [row] = await db
    .select()
    .from(intervention)
    .where(
      and(
        eq(intervention.source_probe_result_event_id, sourceProbeResultEventId),
        eq(intervention.version, version),
      ),
    )
    .limit(1);
  return row ? parseInterventionRow(row) : null;
}

export async function insertInterventionVersion(
  tx: Tx,
  input: {
    id: string;
    version: number;
    sourceProbeResultEventId: string;
    conjectureEventId: string;
    deliveryMode: InterventionDeliveryModeT;
    idempotencyKey: string;
    preparationJobId: string;
    snapshot: InterventionSnapshotT;
    now: Date;
  },
): Promise<InterventionRecord> {
  const [row] = await tx
    .insert(intervention)
    .values({
      id: input.id,
      version: input.version,
      source_probe_result_event_id: input.sourceProbeResultEventId,
      conjecture_event_id: input.conjectureEventId,
      status: 'preparing',
      delivery_mode: input.deliveryMode,
      idempotency_key: input.idempotencyKey,
      preparation_job_id: input.preparationJobId,
      snapshot_json: InterventionSnapshot.parse(input.snapshot),
      preparation_attempts_json: [],
      created_at: input.now,
      updated_at: input.now,
    })
    .returning();
  if (!row) throw new Error('intervention version insert returned no row');
  return parseInterventionRow(row);
}

export async function updatePreparationJobId(
  tx: Tx,
  interventionId: string,
  version: number,
  jobId: string,
  now: Date,
): Promise<void> {
  const [updated] = await tx
    .update(intervention)
    .set({ preparation_job_id: jobId, updated_at: now })
    .where(
      and(
        eq(intervention.id, interventionId),
        eq(intervention.version, version),
        eq(intervention.status, 'preparing'),
      ),
    )
    .returning({ id: intervention.id });
  if (!updated) {
    throw new Error(
      `intervention ${interventionId}@${version} is no longer preparing; job id was not persisted`,
    );
  }
}

export async function saveRecommendation(
  db: Db,
  record: InterventionRecord,
  recommendation: PedagogyRecommendationT,
  now = new Date(),
): Promise<InterventionRecord> {
  const parsed = PedagogyRecommendation.parse(recommendation);
  const [updated] = await db
    .update(intervention)
    .set({
      recommendation_json: parsed,
      revision: record.revision + 1,
      updated_at: now,
    })
    .where(
      and(
        eq(intervention.id, record.id),
        eq(intervention.version, record.version),
        eq(intervention.status, 'preparing'),
        eq(intervention.revision, record.revision),
        record.preparation_job_id === null
          ? isNull(intervention.preparation_job_id)
          : eq(intervention.preparation_job_id, record.preparation_job_id),
        sql`${intervention.recommendation_json} IS NULL`,
      ),
    )
    .returning();
  if (updated) return parseInterventionRow(updated);

  const current = await loadInterventionVersion(db, record.id, record.version);
  if (!current) throw new Error(`intervention ${record.id}@${record.version} disappeared`);
  return current;
}

export async function appendPreparationAttempt(
  db: Db,
  record: InterventionRecord,
  attempt: InterventionPreparationAttemptT,
  now = new Date(),
): Promise<InterventionRecord> {
  const parsed = InterventionPreparationAttempt.parse(attempt);
  if (record.preparation_attempts.some((entry) => entry.attempt === parsed.attempt)) {
    return record;
  }
  const attempts = InterventionPreparationAttempt.array()
    .max(2)
    .parse([...record.preparation_attempts, parsed]);
  const [updated] = await db
    .update(intervention)
    .set({
      preparation_attempts_json: attempts,
      revision: record.revision + 1,
      updated_at: now,
    })
    .where(
      and(
        eq(intervention.id, record.id),
        eq(intervention.version, record.version),
        eq(intervention.status, 'preparing'),
        eq(intervention.revision, record.revision),
        record.preparation_job_id === null
          ? isNull(intervention.preparation_job_id)
          : eq(intervention.preparation_job_id, record.preparation_job_id),
      ),
    )
    .returning();
  if (updated) return parseInterventionRow(updated);

  const current = await loadInterventionVersion(db, record.id, record.version);
  if (!current) throw new Error(`intervention ${record.id}@${record.version} disappeared`);
  return current;
}

export async function loadInterventionAuthoringContext(
  db: DbLike,
  interventionId: string,
): Promise<InterventionAuthoringContextT> {
  const current = await loadLatestInterventionVersion(db, interventionId);
  if (!current) throw new Error(`intervention '${interventionId}' was not found`);
  if (current.status !== 'preparing') {
    throw new Error(`intervention '${interventionId}' is ${current.status}, not preparing`);
  }
  if (!current.recommendation || current.recommendation.kind !== 'recommendation') {
    throw new Error(`intervention '${interventionId}' has no consumable recommendation`);
  }
  return {
    snapshot: current.snapshot,
    recommendation: current.recommendation,
  };
}

export type InterventionPreparationStageGuard =
  | {
      status: 'ready';
      context: InterventionAuthoringContextT;
    }
  | {
      status:
        | 'intervention_not_found'
        | 'intervention_not_preparing'
        | 'preparation_job_superseded'
        | 'recommendation_unavailable'
        | 'source_evidence_inactive';
    };

/**
 * Read-only paid-stage fence used by Practice through Agency's public port.
 *
 * The expected pg-boss id is execution metadata, not authoring context. Keeping
 * it out of `InterventionAuthoringContext` prevents it from leaking into model
 * prompts while still making every paid stage reject a restored/superseded job.
 */
export async function guardInterventionPreparationStage(
  db: DbLike,
  interventionId: string,
  expectedPreparationJobId: string,
): Promise<InterventionPreparationStageGuard> {
  const current = await loadLatestInterventionVersion(db, interventionId);
  if (!current) return { status: 'intervention_not_found' };
  if (current.status !== 'preparing') return { status: 'intervention_not_preparing' };
  if (current.preparation_job_id !== expectedPreparationJobId) {
    return { status: 'preparation_job_superseded' };
  }
  if (!current.recommendation || current.recommendation.kind !== 'recommendation') {
    return { status: 'recommendation_unavailable' };
  }
  const effective = await getEffectiveProbeResultStatuses(
    db,
    [current.source_probe_result_event_id],
    { validateDirectChain: true },
  );
  if (effective.get(current.source_probe_result_event_id) !== 'active') {
    return { status: 'source_evidence_inactive' };
  }
  return {
    status: 'ready',
    context: {
      snapshot: current.snapshot,
      recommendation: current.recommendation,
    },
  };
}

export async function activateIntervention(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    preparationJobId: string;
    package: InterventionPackageT;
    now?: Date;
  },
): Promise<InterventionRecord> {
  const now = input.now ?? new Date();
  const packageValue = InterventionPackage.parse(input.package);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intervention:${input.interventionId}:${input.version}`}, 0))`,
    );
    const current = await loadInterventionVersion(tx, input.interventionId, input.version);
    if (!current) {
      throw new Error(`intervention ${input.interventionId}@${input.version} was not found`);
    }
    if (current.status === 'active') return current;
    if (current.status !== 'preparing') {
      throw new Error(
        `intervention ${input.interventionId}@${input.version} cannot activate from ${current.status}`,
      );
    }
    if (current.preparation_job_id !== input.preparationJobId) return current;
    if (!current.recommendation || current.recommendation.kind !== 'recommendation') {
      throw new Error('intervention cannot activate without a concrete recommendation');
    }
    const effective = await getEffectiveProbeResultStatuses(
      tx,
      [current.source_probe_result_event_id],
      { validateDirectChain: true },
    );
    if (effective.get(current.source_probe_result_event_id) !== 'active') {
      const failureCode = 'source_evidence_inactive';
      const [failed] = await tx
        .update(intervention)
        .set({
          status: 'preparation_failed',
          package_json: null,
          failure_code: failureCode,
          activated_at: null,
          revision: current.revision + 1,
          updated_at: now,
        })
        .where(
          and(
            eq(intervention.id, current.id),
            eq(intervention.version, current.version),
            eq(intervention.status, 'preparing'),
            eq(intervention.revision, current.revision),
            eq(intervention.preparation_job_id, input.preparationJobId),
          ),
        )
        .returning();
      if (!failed) throw new Error('intervention evidence invalidation lost its serialized state');
      await writeEvent(tx, {
        id: newId(),
        actor_kind: 'system',
        actor_ref: 'prepare_intervention',
        action: INTERVENTION_PREPARATION_FAILED_ACTION,
        subject_kind: 'event',
        subject_id: current.source_probe_result_event_id,
        outcome: 'failure',
        payload: {
          intervention_id: current.id,
          intervention_version: current.version,
          conjecture_event_id: current.conjecture_event_id,
          knowledge_id: current.snapshot.conjecture.knowledge_id,
          failure_code: failureCode,
        },
        caused_by_event_id: current.source_probe_result_event_id,
        affected_scopes: [
          `knowledge:${current.snapshot.conjecture.knowledge_id}`,
          `mind_model:${current.conjecture_event_id}`,
        ],
        ingest_at: now,
        created_at: now,
      });
      return parseInterventionRow(failed);
    }

    const [updated] = await tx
      .update(intervention)
      .set({
        status: 'active',
        package_json: packageValue,
        failure_code: null,
        activated_at: now,
        revision: current.revision + 1,
        updated_at: now,
      })
      .where(
        and(
          eq(intervention.id, current.id),
          eq(intervention.version, current.version),
          eq(intervention.status, 'preparing'),
          eq(intervention.revision, current.revision),
        ),
      )
      .returning();
    if (!updated) throw new Error('intervention activation lost its serialized state');

    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'prepare_intervention',
      action: INTERVENTION_ACTIVATED_ACTION,
      subject_kind: 'event',
      subject_id: current.source_probe_result_event_id,
      outcome: 'success',
      payload: {
        intervention_id: current.id,
        intervention_version: current.version,
        conjecture_event_id: current.conjecture_event_id,
        knowledge_id: current.snapshot.conjecture.knowledge_id,
        delivery_mode: current.delivery_mode,
        method_id: current.recommendation.method_id,
        package_version: packageValue.package_version,
      },
      caused_by_event_id: current.source_probe_result_event_id,
      affected_scopes: [
        `knowledge:${current.snapshot.conjecture.knowledge_id}`,
        `mind_model:${current.conjecture_event_id}`,
      ],
      // Internal lifecycle fact; the Teaching Brief projection reads it directly.
      // Do not turn generated package metadata into learner-authored memory.
      ingest_at: now,
      created_at: now,
    });
    return parseInterventionRow(updated);
  });
}

export async function failInterventionPreparation(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    expectedPreparationJobId?: string;
    failureCode: string;
    now?: Date;
  },
): Promise<InterventionRecord> {
  const failureCode = input.failureCode.trim();
  if (!failureCode) throw new Error('intervention failure code must not be empty');
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intervention:${input.interventionId}:${input.version}`}, 0))`,
    );
    const current = await loadInterventionVersion(tx, input.interventionId, input.version);
    if (!current) {
      throw new Error(`intervention ${input.interventionId}@${input.version} was not found`);
    }
    if (current.status === 'preparation_failed') return current;
    if (current.status !== 'preparing') {
      throw new Error(
        `intervention ${input.interventionId}@${input.version} cannot fail from ${current.status}`,
      );
    }
    if (
      input.expectedPreparationJobId !== undefined &&
      current.preparation_job_id !== input.expectedPreparationJobId
    ) {
      return current;
    }

    const [updated] = await tx
      .update(intervention)
      .set({
        status: 'preparation_failed',
        failure_code: failureCode,
        package_json: null,
        activated_at: null,
        revision: current.revision + 1,
        updated_at: now,
      })
      .where(
        and(
          eq(intervention.id, current.id),
          eq(intervention.version, current.version),
          eq(intervention.status, 'preparing'),
          eq(intervention.revision, current.revision),
          ...(input.expectedPreparationJobId !== undefined
            ? [eq(intervention.preparation_job_id, input.expectedPreparationJobId)]
            : []),
        ),
      )
      .returning();
    if (!updated) throw new Error('intervention failure transition lost its serialized state');

    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'prepare_intervention',
      action: INTERVENTION_PREPARATION_FAILED_ACTION,
      subject_kind: 'event',
      subject_id: current.source_probe_result_event_id,
      outcome: 'failure',
      payload: {
        intervention_id: current.id,
        intervention_version: current.version,
        conjecture_event_id: current.conjecture_event_id,
        knowledge_id: current.snapshot.conjecture.knowledge_id,
        failure_code: failureCode,
      },
      caused_by_event_id: current.source_probe_result_event_id,
      affected_scopes: [
        `knowledge:${current.snapshot.conjecture.knowledge_id}`,
        `mind_model:${current.conjecture_event_id}`,
      ],
      ingest_at: now,
      created_at: now,
    });
    return parseInterventionRow(updated);
  });
}
