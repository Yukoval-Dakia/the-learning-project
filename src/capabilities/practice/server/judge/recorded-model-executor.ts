import { eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type ModelExecutorRequest,
  type ModelUnitExecutorPort,
  ModelUnitOutcome,
  type ModelUnitOutcomeT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

type Executor = (
  request: ModelExecutorRequest,
  signal: AbortSignal | undefined,
  taskRunId: string,
) => Promise<ModelUnitOutcomeT>;

/** Claim/result receipts commit independently of the candidate transaction.
 * A lost result is held for recovery, never interpreted as permission to spend again.
 */
export function createRecordedModelExecutor(
  database: Db,
  execute: Executor,
): ModelUnitExecutorPort {
  return async (request, signal) => {
    const cap = request.executor.max_cost_usd_micros;
    const operation = canonicalHash({
      group: request.evaluation_group_id,
      submission: request.submission_id,
      attempt: request.attempt,
      unit: request.scoring_unit_id,
    });
    const digest = canonicalHash(request);
    const claimId = `evt_model_claim_${operation}`;
    const resultId = `evt_model_result_${operation}`;
    const taskRunId = `assessment_${operation}`;
    const held = (detail: string, reservation = cap): ModelUnitOutcomeT => ({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: false, detail },
      // This is a conservative reservation, not a reported charge or proof that
      // the runner started. The claim's planned task ID remains separately auditable.
      run_refs: [],
      ...(reservation === undefined ? {} : { cost_usd_micros: reservation }),
    });
    const prior = await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${claimId}))`);
      const [claim] = await tx.select().from(event).where(eq(event.id, claimId)).limit(1);
      if (claim) {
        const originalCap =
          typeof claim.payload.reserved_cost_usd_micros === 'number'
            ? claim.payload.reserved_cost_usd_micros
            : cap;
        if (claim.payload.input_digest !== digest)
          return held('claimed execution input differs; explicit recovery required', originalCap);
        const [result] = await tx.select().from(event).where(eq(event.id, resultId)).limit(1);
        if (!result)
          return held(
            'execution was claimed but its result is unavailable; automatic redispatch is forbidden',
            originalCap,
          );
        const parsed = ModelUnitOutcome.safeParse(result.payload.outcome);
        return parsed.success
          ? parsed.data
          : held('sealed execution result is invalid; explicit recovery required', originalCap);
      }
      if (cap === undefined || !Number.isSafeInteger(cap) || cap <= 0) {
        return {
          kind: 'pending' as const,
          pending: {
            reason: 'unjudgeable' as const,
            detail: 'formal model execution requires an explicit positive unit cap',
          },
          run_refs: [],
          cost_usd_micros: 0,
        };
      }
      const now = new Date();
      await writeEvent(tx, {
        id: claimId,
        actor_kind: 'system',
        actor_ref: 'assessment:model-execution',
        action: 'experimental:assessment_model_claim',
        subject_kind: 'evaluation_group',
        subject_id: request.evaluation_group_id,
        outcome: null,
        payload: {
          version: 1,
          input_digest: digest,
          planned_task_run_id: taskRunId,
          submission_id: request.submission_id,
          attempt: request.attempt,
          scoring_unit_id: request.scoring_unit_id,
          reserved_cost_usd_micros: cap,
        },
        created_at: now,
        ingest_at: now,
      });
      return null;
    });
    if (prior !== null) return prior;
    let outcome: ModelUnitOutcomeT;
    try {
      outcome = ModelUnitOutcome.parse(await execute(request, signal, taskRunId));
    } catch {
      outcome = held('claimed execution did not return a valid result; explicit recovery required');
    }
    // Deliberately outside the execute catch: a receipt failure never retries the model.
    const now = new Date();
    await writeEvent(database, {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'assessment:model-execution',
      action: 'experimental:assessment_model_result',
      subject_kind: 'evaluation_group',
      subject_id: request.evaluation_group_id,
      outcome: null,
      caused_by_event_id: claimId,
      payload: { version: 1, input_digest: digest, outcome },
      created_at: now,
      ingest_at: now,
    });
    return outcome;
  };
}
