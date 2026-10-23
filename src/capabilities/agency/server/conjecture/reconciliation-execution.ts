import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import {
  PREDICTION_SCORE_ACTION,
  PROBE_RESULT_PROJECTED_ACTION,
  type ReconcileResult,
  reconcileConjecturePredictions,
} from '@/server/conjectures/reconcile';

/** actor_ref stamped on the trigger / scan events + each conjecture proposal. */
export const RESEARCH_MEETING_ACTOR = 'research_meeting';

type WriteEventFn = (db: Db | Tx, input: WriteEventInput) => Promise<string>;
type LoadReconciliationResultFn = (db: Db, executionId: string) => Promise<ReconcileResult | null>;
type CountReconciledForExecutionFn = (db: Db, executionId: string) => Promise<number>;

export interface ResearchMeetingReconciliationDeps {
  writeEventFn?: WriteEventFn;
  /** Retry checkpoint for the reconcile half, persisted before proposal work. */
  loadReconciliationResultFn?: LoadReconciliationResultFn;
  /** Recover score writes if a crash happened before the reconcile checkpoint. */
  countReconciledForExecutionFn?: CountReconciledForExecutionFn;
  /** Score prior probe outcomes → prediction_score event + typed-ledger. */
  reconcileFn?: (db: Db) => Promise<ReconcileResult>;
}

/** Shared identity protocol for all four research-meeting execution events. */
export function scheduledEventId(
  prefix: 'trigger' | 'scan' | 'reconciliation' | 'completion',
  executionId: string,
): string {
  const digest = createHash('sha256').update(executionId).digest('hex').slice(0, 32);
  return `research_meeting_${prefix}_${digest}`;
}

const ReconcileResultSchema = z.object({
  reconciled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

async function defaultLoadReconciliationResult(
  db: Db,
  executionId: string,
): Promise<ReconcileResult | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, scheduledEventId('reconciliation', executionId)))
    .limit(1);
  if (!row) return null;
  const parsed = z
    .object({
      execution_id: z.literal(executionId),
      reconcile_result: ReconcileResultSchema,
    })
    .safeParse(row.payload);
  if (!parsed.success) {
    console.error('[research_meeting_nightly] reconciliation checkpoint is unreadable', {
      execution_id: executionId,
      issues: parsed.error.issues,
    });
    throw new Error(
      `research_meeting_nightly: reconciliation checkpoint is unreadable for execution ${executionId}`,
    );
  }
  return parsed.data.reconcile_result;
}

async function defaultCountReconciledForExecution(db: Db, executionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        inArray(event.action, [PREDICTION_SCORE_ACTION, PROBE_RESULT_PROJECTED_ACTION]),
        sql`${event.payload} ->> 'research_meeting_execution_id' = ${executionId}`,
      ),
    );
  return row?.count ?? 0;
}

function buildReconciliationEventInput(
  executionId: string,
  result: ReconcileResult,
  now: Date,
): WriteEventInput {
  const id = scheduledEventId('reconciliation', executionId);
  return {
    id,
    actor_kind: 'system',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:research_meeting_reconciled',
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: { execution_id: executionId, reconcile_result: result },
    ingest_at: now,
    created_at: now,
  };
}

/**
 * Recover the reconcile half of one execution before proposal work. The caller holds
 * the execution lock and has already returned any committed completion result.
 */
export async function reconcileResearchMeetingExecution(
  db: Db,
  executionId: string,
  now: Date,
  deps: ResearchMeetingReconciliationDeps = {},
): Promise<ReconcileResult> {
  const loadReconciliationResultFn =
    deps.loadReconciliationResultFn ?? defaultLoadReconciliationResult;
  const countReconciledForExecutionFn =
    deps.countReconciledForExecutionFn ?? defaultCountReconciledForExecution;
  // Core reconciliation keeps its own clock and event writer. The nightly clock and
  // writeEventFn apply only to the execution checkpoint.
  const reconcileFn =
    deps.reconcileFn ?? ((d: Db) => reconcileConjecturePredictions(d, { executionId }));
  const writeEventFn = deps.writeEventFn ?? writeEvent;

  const checkpoint = await loadReconciliationResultFn(db, executionId);
  if (checkpoint) return checkpoint;

  // Both derived anchor actions are individually idempotent. Count anchor rows stamped by
  // an earlier attempt (crash after reconcile, before checkpoint), then persist one
  // deterministic aggregate checkpoint before proposal work.
  const previouslyReconciled = await countReconciledForExecutionFn(db, executionId);
  const freshResult = await reconcileFn(db);
  const reconcileResult = {
    reconciled: previouslyReconciled + freshResult.reconciled,
    skipped: freshResult.skipped,
  };
  await writeEventFn(db, buildReconciliationEventInput(executionId, reconcileResult, now));
  return reconcileResult;
}
