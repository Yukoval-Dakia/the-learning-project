// One sourcing_web placement delivery (YUK-1468 FULL policy, owner 2026-11-02).
//
// The supply_execute job that a claim recorded is the only delivery source. This operation hides
// the whole order from callers: verify the job's transport contract, acquire the claim attempt
// (job id + delivery number + startedOn), keep its lease alive on job.signal, run the source
// agent's web supply under that authority, then hand the bound questions to the original
// placement completion owner. Callers never assemble paid eligibility from primitives.
import { and, eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import type { Db } from '@/db/client';
import { placement_starter_attempt_question, placement_starter_claim } from '@/db/schema';
import {
  PLACEMENT_QUEUE_EXPIRY_MS,
  type PlacementAttemptAuthority,
  type PlacementAttemptHeartbeat,
  PlacementStarterBudgetExhaustedError,
  PlacementStarterStaleAuthorityError,
  PlacementStarterUnderfillError,
  acquirePlacementAttempt,
  assertPlacementAttemptFence,
  finishPlacementAttempt,
  markAttemptVerifying,
  placementDeliveryMetadata,
  reconcilePlacementDelivery,
  startPlacementAttemptHeartbeat,
} from './placement-starter-attempts';
import { markPlacementStarterClaimTerminal } from './placement-starter-store';

/** Server-held authority for one web placement delivery; never derived from job/trace text. */
export interface PlacementWebDelivery {
  attempt: PlacementAttemptAuthority;
  heartbeat: PlacementAttemptHeartbeat;
  signal: AbortSignal;
}

type DeliveryJob = Pick<
  JobWithMetadata,
  'id' | 'retryCount' | 'retryLimit' | 'expireInSeconds' | 'startedOn' | 'signal'
>;

/**
 * Run `execute` as the claim's delivery when `job` is the claim's recorded sourcing_web job;
 * otherwise run it without placement authority, which the web owner refuses for placement
 * demands. Errors propagate so pg-boss stays the only redelivery driver (3 deliveries total).
 */
export async function runPlacementWebDelivery(input: {
  db: Db;
  job: DeliveryJob;
  claimId: string;
  execute: (delivery: PlacementWebDelivery | undefined) => Promise<void>;
}): Promise<void> {
  const { db, job, claimId } = input;
  const [claim] = await db
    .select({
      route: placement_starter_claim.supply_route,
      jobId: placement_starter_claim.pg_boss_job_id,
    })
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId));
  if (claim?.route !== 'sourcing_web' || claim.jobId !== job.id) {
    await input.execute(undefined);
    return;
  }
  const { deliveryNo } = placementDeliveryMetadata({
    retryCount: job.retryCount,
    retryLimit: job.retryLimit,
  });
  if (
    !Number.isFinite(job.expireInSeconds) ||
    job.expireInSeconds * 1_000 !== PLACEMENT_QUEUE_EXPIRY_MS
  ) {
    throw new Error('placement supply_execute queue expiry must be 120 minutes');
  }
  let attempt: PlacementAttemptAuthority;
  try {
    attempt = await acquirePlacementAttempt(db, {
      claimId,
      pgBossJobId: job.id,
      deliveryNo,
      startedOn: job.startedOn,
    });
  } catch (err) {
    if (!(err instanceof PlacementStarterBudgetExhaustedError)) throw err;
    // A spent claim can never make progress: end it and complete the job instead of letting
    // every redelivery fail on the same refusal (the quiz_gen consumer's rule).
    await db.transaction((tx) =>
      markPlacementStarterClaimTerminal(tx, claimId, 'exhausted', new Date(), {
        class: 'budget_exhausted',
        code: 'budget_exhausted',
        message: 'placement starter claim cap reached before a delivery could be acquired',
      }),
    );
    return;
  }
  const heartbeat = startPlacementAttemptHeartbeat(db, attempt, job.signal);
  try {
    // Submit dispatches verification inside execute; the question authority requires the
    // attempt to be 'verifying', so enter it before any question can be bound.
    await markAttemptVerifying(db, attempt);
    await input.execute({ attempt, heartbeat, signal: job.signal });
    await heartbeat.assertHealthy();
    await assertPlacementAttemptFence(db, attempt);
    const [bound] = await db
      .select({ questionId: placement_starter_attempt_question.question_id })
      .from(placement_starter_attempt_question)
      .where(
        and(
          eq(placement_starter_attempt_question.attempt_id, attempt.attemptId),
          eq(placement_starter_attempt_question.verification_status, 'authorized'),
        ),
      )
      .limit(1);
    if (!bound) {
      // Nothing reached a durable submit receipt under this delivery (no evidence, blocked
      // source, or a send whose receipt is still unknown). There is nothing to verify; the next
      // delivery only resumes the same demand, it never acquires again.
      await finishPlacementAttempt(db, attempt, 'underfilled');
      throw new PlacementStarterUnderfillError('placement web delivery bound no questions');
    }
    await reconcilePlacementDelivery(db, attempt, job.signal);
  } catch (err) {
    // Same terminalization rule as the quiz_gen consumer: a failure before reconcile finalized
    // releases the lease (retry_scheduled, or exhausted on the final delivery). A lost fence
    // means a superseding delivery owns termination; a redundant finalize is swallowed so the
    // original error still reaches pg-boss.
    if (!(err instanceof PlacementStarterStaleAuthorityError)) {
      try {
        await finishPlacementAttempt(db, attempt, 'interrupted');
      } catch (finalizeErr) {
        if (!(finalizeErr instanceof PlacementStarterStaleAuthorityError)) {
          console.error(
            '[supply_execute] placement attempt finalize failed for',
            attempt.attemptId,
            finalizeErr,
          );
        }
      }
    }
    throw err;
  } finally {
    await heartbeat.stop();
  }
}
