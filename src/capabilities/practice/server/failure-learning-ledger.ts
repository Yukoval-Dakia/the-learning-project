import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { cost_ledger } from '@/db/schema';
import {
  writePermanentAiFailureLedger,
  writeRetryableAiFailureLedger,
} from '@/server/ai/failure-ledger';
import {
  ATTRIBUTION_FOLLOWUP_QUEUE,
  VARIANT_GEN_QUEUE,
  failureLearningJobId,
} from './failure-learning-identity';

type DbLike = Db | Tx;

async function hasPermanentMarker(
  db: DbLike,
  taskKind: 'AttributionTask' | 'VariantGenTask',
  pgbossJobId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: cost_ledger.id })
    .from(cost_ledger)
    .where(
      and(
        eq(cost_ledger.task_kind, taskKind),
        eq(cost_ledger.outcome, 'failed_permanent'),
        eq(cost_ledger.pgboss_job_id, pgbossJobId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function hasAttributionPermanent(db: DbLike, attemptEventId: string): Promise<boolean> {
  return hasPermanentMarker(
    db,
    'AttributionTask',
    failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptEventId),
  );
}

export function hasVariantPermanent(db: DbLike, attemptEventId: string): Promise<boolean> {
  return hasPermanentMarker(
    db,
    'VariantGenTask',
    failureLearningJobId(VARIANT_GEN_QUEUE, attemptEventId),
  );
}

export function recordAttributionRetryable(db: Db): Promise<void> {
  return writeRetryableAiFailureLedger(db, 'AttributionTask');
}

export function recordAttributionPermanent(
  db: DbLike,
  attemptEventId: string,
  taskRunId: string | null | undefined,
): Promise<void> {
  return writePermanentAiFailureLedger(db, 'AttributionTask', taskRunId, {
    pgbossJobId: failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptEventId),
    throwOnError: true,
  });
}

export function recordVariantPermanent(
  db: DbLike,
  attemptEventId: string,
  taskRunId: string | null | undefined,
): Promise<void> {
  return writePermanentAiFailureLedger(db, 'VariantGenTask', taskRunId, {
    pgbossJobId: failureLearningJobId(VARIANT_GEN_QUEUE, attemptEventId),
    throwOnError: true,
  });
}
