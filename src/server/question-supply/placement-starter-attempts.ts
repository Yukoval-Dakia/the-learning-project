import { createHash, randomUUID } from 'node:crypto';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  event,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
  question,
} from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { placementStarterAttemptId } from './placement-starter-identity';

export const PLACEMENT_VERIFY_POLL_MS = 2_000;
export const PLACEMENT_ATTEMPT_LEASE_MS = 20 * 60_000;
export const PLACEMENT_ATTEMPT_HEARTBEAT_MS = 5 * 60_000;
export const PLACEMENT_DECISION_DEADLINE_MS = 105 * 60_000;
export const PLACEMENT_RENEWAL_CEILING_MS = 110 * 60_000;
export const PLACEMENT_QUEUE_EXPIRY_MS = 120 * 60_000;
export const PLACEMENT_STARTER_REQUIRED_COUNT = 8;
export const PLACEMENT_GENERATION_RESERVATION_MICRO_USD = 500_000;

export type PlacementCostComponentKind =
  | 'quiz_gen'
  | 'quiz_verify'
  | 'solution_check'
  | 'teaching_quality';

export interface PlacementVerificationAuthority {
  claim_id: string;
  attempt_id: string;
  question_id: string;
  verification_authority_epoch: string;
  fencing_token: string;
}

export class PlacementStarterAdmissionError extends Error {}
// Budget exhaustion is a TERMINAL admission failure: no redelivery can make progress (known_cost
// never decreases), so the handler terminalizes the claim as 'exhausted' and completes the job
// rather than retrying into the same throw (YUK-452 round-3, codex P2-A). Subclass so existing
// `instanceof PlacementStarterAdmissionError` checks + `/budget/` message assertions still hold.
export class PlacementStarterBudgetExhaustedError extends PlacementStarterAdmissionError {}
export class PlacementStarterAttemptActiveError extends Error {}
export class PlacementStarterStaleAuthorityError extends Error {}
export class PlacementStarterUnderfillError extends Error {}
export class PlacementStarterDeadlineError extends Error {}

export function placementDeliveryMetadata(input: {
  retryCount: unknown;
  retryLimit: unknown;
}): { deliveryNo: number } {
  if (input.retryLimit !== 2) {
    throw new PlacementStarterAdmissionError('placement quiz_gen retryLimit must be 2');
  }
  if (
    typeof input.retryCount !== 'number' ||
    !Number.isInteger(input.retryCount) ||
    input.retryCount < 0 ||
    input.retryCount > 2
  ) {
    throw new PlacementStarterAdmissionError(
      'placement quiz_gen retryCount must be an integer from 0 through 2',
    );
  }
  return { deliveryNo: input.retryCount + 1 };
}

export function placementFulfillmentDisposition(
  eligibleCount: number,
): 'satisfied' | 'underfilled' {
  if (eligibleCount > PLACEMENT_STARTER_REQUIRED_COUNT) {
    throw new PlacementStarterAdmissionError(
      `placement starter invariant exceeded exact count: ${eligibleCount}/${PLACEMENT_STARTER_REQUIRED_COUNT}`,
    );
  }
  return eligibleCount === PLACEMENT_STARTER_REQUIRED_COUNT ? 'satisfied' : 'underfilled';
}

export interface PlacementAttemptAuthority {
  claimId: string;
  attemptId: string;
  pgBossJobId: string;
  deliveryNo: number;
  fencingToken: string;
  leaseExpiresAt: Date;
  startedOn: Date;
}

export async function acquirePlacementAttempt(
  db: Db,
  input: {
    claimId: string;
    pgBossJobId: string;
    deliveryNo: number;
    startedOn: Date;
    now?: Date;
  },
): Promise<PlacementAttemptAuthority> {
  const now = input.now ?? new Date();
  const attemptId = placementStarterAttemptId(input.claimId, input.pgBossJobId, input.deliveryNo);
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, input.claimId))
      .for('update');
    if (!claim) throw new PlacementStarterAdmissionError('placement starter claim not found');
    if (claim.pg_boss_job_id !== input.pgBossJobId) {
      throw new PlacementStarterAdmissionError('placement quiz_gen job identity mismatch');
    }
    if (!['queued', 'retry_scheduled', 'running', 'verifying'].includes(claim.status)) {
      throw new PlacementStarterAdmissionError(`placement starter claim is ${claim.status}`);
    }
    if (claim.max_paid_attempts !== 3 || input.deliveryNo > claim.max_paid_attempts) {
      throw new PlacementStarterAdmissionError('placement paid delivery exceeds claim policy');
    }
    if (claim.known_cost_micro_usd >= claim.budget_limit_micro_usd) {
      throw new PlacementStarterBudgetExhaustedError('placement starter budget exhausted');
    }

    const [existing] = await tx
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attemptId))
      .for('update');
    if (
      existing &&
      ['running', 'verifying'].includes(existing.status) &&
      existing.lease_expires_at &&
      existing.lease_expires_at > now
    ) {
      throw new PlacementStarterAttemptActiveError(
        'placement delivery already has an active lease',
      );
    }
    if (existing && !['running', 'verifying', 'interrupted'].includes(existing.status)) {
      throw new PlacementStarterAdmissionError(`placement delivery is already ${existing.status}`);
    }

    const otherActive = await tx
      .select({
        id: placement_starter_attempt.id,
        lease: placement_starter_attempt.lease_expires_at,
      })
      .from(placement_starter_attempt)
      .where(
        and(
          eq(placement_starter_attempt.claim_id, input.claimId),
          inArray(placement_starter_attempt.status, ['running', 'verifying']),
        ),
      )
      .for('update');
    for (const active of otherActive) {
      if (active.id === attemptId) continue;
      if (active.lease && active.lease > now) {
        throw new PlacementStarterAttemptActiveError('placement claim has an active delivery');
      }
      await tx
        .update(placement_starter_attempt_question)
        .set({ verification_status: 'superseded' })
        .where(
          and(
            eq(placement_starter_attempt_question.attempt_id, active.id),
            eq(placement_starter_attempt_question.verification_status, 'authorized'),
          ),
        );
      await tx
        .update(placement_starter_attempt)
        .set({ status: 'interrupted', finished_at: now, lease_expires_at: null, updated_at: now })
        .where(eq(placement_starter_attempt.id, active.id));
    }

    const fencingToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + PLACEMENT_ATTEMPT_LEASE_MS);
    if (existing) {
      await tx
        .update(placement_starter_attempt)
        .set({
          fencing_token: fencingToken,
          status: 'running',
          lease_expires_at: leaseExpiresAt,
          started_at: existing.started_at ?? input.startedOn,
          finished_at: null,
          updated_at: now,
        })
        .where(eq(placement_starter_attempt.id, attemptId));
    } else {
      await tx.insert(placement_starter_attempt).values({
        id: attemptId,
        claim_id: input.claimId,
        pg_boss_job_id: input.pgBossJobId,
        delivery_no: input.deliveryNo,
        fencing_token: fencingToken,
        status: 'running',
        lease_expires_at: leaseExpiresAt,
        started_at: input.startedOn,
        created_at: now,
        updated_at: now,
      });
    }
    await tx
      .update(placement_starter_claim)
      .set({
        status: 'running',
        updated_at: now,
        version: sql`${placement_starter_claim.version} + 1`,
      })
      .where(eq(placement_starter_claim.id, input.claimId));
    return {
      claimId: input.claimId,
      attemptId,
      pgBossJobId: input.pgBossJobId,
      deliveryNo: input.deliveryNo,
      fencingToken,
      leaseExpiresAt,
      startedOn: input.startedOn,
    };
  });
}

export interface PlacementAttemptHeartbeat {
  done: Promise<void>;
  assertHealthy(): Promise<void>;
  stop(): Promise<void>;
}

function heartbeatSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('placement heartbeat stopped'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('placement heartbeat stopped'));
      },
      { once: true },
    );
  });
}

export function startPlacementAttemptHeartbeat(
  db: Db,
  attempt: PlacementAttemptAuthority,
  signal: AbortSignal,
  deps: {
    now?: () => Date;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): PlacementAttemptHeartbeat {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? heartbeatSleep;
  const stopController = new AbortController();
  let stopped = false;
  let failure: unknown;
  const onAbort = () => {
    if (!stopped) failure = signal.reason ?? new Error('placement quiz_gen aborted');
    stopController.abort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const done = (async () => {
    try {
      while (!stopped && !signal.aborted) {
        await sleep(PLACEMENT_ATTEMPT_HEARTBEAT_MS, stopController.signal);
        if (stopped || signal.aborted) break;
        await renewPlacementAttempt(db, attempt, now());
      }
      if (signal.aborted && !stopped) throw failure;
    } catch (error) {
      if (stopped) return;
      failure = error;
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  })();
  // The handler checks `assertHealthy` at every authoritative boundary. Attach a rejection
  // observer immediately so a fence loss during a long provider call never becomes an unhandled
  // rejection before the provider returns to that boundary.
  void done.catch(() => undefined);

  return {
    done,
    async assertHealthy() {
      if (failure !== undefined) throw failure;
      if (signal.aborted) throw signal.reason ?? new Error('placement quiz_gen aborted');
    },
    async stop() {
      if (stopped) return;
      const priorFailure = failure;
      stopped = true;
      stopController.abort(new Error('placement heartbeat stopped'));
      signal.removeEventListener('abort', onAbort);
      if (priorFailure !== undefined) return;
      await Promise.race([done, Promise.resolve()]);
    },
  };
}

export async function assertPlacementAttemptFence(
  db: Db | Tx,
  attempt: PlacementAttemptAuthority,
  now?: Date,
): Promise<void> {
  const [current] = await db
    .select({
      fence: placement_starter_attempt.fencing_token,
      status: placement_starter_attempt.status,
      lease: placement_starter_attempt.lease_expires_at,
      databaseNow: sql<Date>`transaction_timestamp()`,
    })
    .from(placement_starter_attempt)
    .where(eq(placement_starter_attempt.id, attempt.attemptId));
  if (
    !current ||
    current.fence !== attempt.fencingToken ||
    !['running', 'verifying'].includes(current.status) ||
    !current.lease ||
    current.lease <= (now ?? current.databaseNow)
  ) {
    throw new PlacementStarterStaleAuthorityError('placement attempt fence lost');
  }
}

export async function assertPlacementAuthority(
  tx: Tx,
  authority: PlacementVerificationAuthority,
  now = new Date(),
): Promise<void> {
  const [row] = await tx
    .select({
      claimStatus: placement_starter_claim.status,
      claimJobId: placement_starter_claim.pg_boss_job_id,
      attemptJobId: placement_starter_attempt.pg_boss_job_id,
      attemptStatus: placement_starter_attempt.status,
      fence: placement_starter_attempt.fencing_token,
      lease: placement_starter_attempt.lease_expires_at,
      epoch: placement_starter_attempt_question.verification_authority_epoch,
      verificationStatus: placement_starter_attempt_question.verification_status,
    })
    .from(placement_starter_attempt_question)
    .innerJoin(
      placement_starter_attempt,
      and(
        eq(placement_starter_attempt.id, placement_starter_attempt_question.attempt_id),
        eq(placement_starter_attempt.claim_id, placement_starter_attempt_question.claim_id),
      ),
    )
    .innerJoin(
      placement_starter_claim,
      eq(placement_starter_claim.id, placement_starter_attempt_question.claim_id),
    )
    .where(
      and(
        eq(placement_starter_attempt_question.claim_id, authority.claim_id),
        eq(placement_starter_attempt_question.attempt_id, authority.attempt_id),
        eq(placement_starter_attempt_question.question_id, authority.question_id),
      ),
    )
    .for('update');
  if (
    !row ||
    row.epoch !== authority.verification_authority_epoch ||
    row.fence !== authority.fencing_token ||
    row.claimJobId !== row.attemptJobId ||
    !['running', 'verifying'].includes(row.claimStatus) ||
    row.attemptStatus !== 'verifying' ||
    !row.lease ||
    row.lease <= now ||
    row.verificationStatus !== 'authorized'
  ) {
    throw new PlacementStarterStaleAuthorityError('placement verification authority is stale');
  }
}

export async function renewPlacementAttempt(
  db: Db,
  attempt: PlacementAttemptAuthority,
  now = new Date(),
): Promise<Date> {
  const ceiling = new Date(attempt.startedOn.getTime() + PLACEMENT_RENEWAL_CEILING_MS);
  if (now >= ceiling) throw new PlacementStarterDeadlineError('placement renewal ceiling reached');
  const renewed = new Date(Math.min(now.getTime() + PLACEMENT_ATTEMPT_LEASE_MS, ceiling.getTime()));
  const rows = await db
    .update(placement_starter_attempt)
    .set({ lease_expires_at: renewed, updated_at: now })
    .where(
      and(
        eq(placement_starter_attempt.id, attempt.attemptId),
        eq(placement_starter_attempt.fencing_token, attempt.fencingToken),
        inArray(placement_starter_attempt.status, ['running', 'verifying']),
      ),
    )
    .returning({ id: placement_starter_attempt.id });
  if (rows.length !== 1)
    throw new PlacementStarterStaleAuthorityError('placement attempt fence lost');
  return renewed;
}

export async function reservePlacementGenerationCall(
  db: Db,
  attempt: PlacementAttemptAuthority,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertPlacementAttemptFence(tx, attempt, now);
    const id = createHash('sha256')
      .update(`placement-paid-call-reservation\0${attempt.attemptId}:quiz_gen`)
      .digest('hex');
    const [claim] = await tx
      .select({
        knownCost: placement_starter_claim.known_cost_micro_usd,
        budgetLimit: placement_starter_claim.budget_limit_micro_usd,
      })
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, attempt.claimId))
      .for('update');
    const [existing] = await tx
      .select({ id: placement_starter_cost_component.id })
      .from(placement_starter_cost_component)
      .where(eq(placement_starter_cost_component.id, id));
    if (existing) return;
    const reserved = PLACEMENT_GENERATION_RESERVATION_MICRO_USD;
    if (!claim || claim.knownCost + reserved > claim.budgetLimit) {
      throw new PlacementStarterAdmissionError('placement generation exceeds claim budget');
    }
    await tx.insert(placement_starter_cost_component).values({
      id,
      claim_id: attempt.claimId,
      attempt_id: attempt.attemptId,
      component_kind: 'quiz_gen',
      provider_task_run_id: `reservation:${attempt.attemptId}:quiz_gen`,
      cost_micro_usd: reserved,
      created_at: now,
    });
    await tx
      .update(placement_starter_claim)
      .set({ known_cost_micro_usd: claim.knownCost + reserved, updated_at: now })
      .where(eq(placement_starter_claim.id, attempt.claimId));
  });
}

export async function recordPlacementAttemptOutput(
  db: Db,
  attempt: PlacementAttemptAuthority,
  input: { taskRunId: string; outputText: string; costMicroUsd: number; now?: Date },
): Promise<{ overCap: boolean }> {
  const now = input.now ?? new Date();
  const outputHash = createHash('sha256').update(input.outputText).digest('hex');
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attempt.attemptId))
      .for('update');
    if (
      !current ||
      current.fencing_token !== attempt.fencingToken ||
      !['running', 'verifying'].includes(current.status) ||
      !current.lease_expires_at ||
      current.lease_expires_at <= now
    ) {
      throw new PlacementStarterStaleAuthorityError('placement output fence lost');
    }
    if (
      (current.provider_task_run_id && current.provider_task_run_id !== input.taskRunId) ||
      (current.provider_output_hash && current.provider_output_hash !== outputHash)
    ) {
      throw new PlacementStarterAdmissionError('placement provider output invariant mismatch');
    }
    await tx
      .update(placement_starter_attempt)
      .set({
        provider_task_run_id: input.taskRunId,
        provider_output_hash: outputHash,
        provider_output_recorded_at: current.provider_output_recorded_at ?? now,
        updated_at: now,
      })
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    const reservationId = createHash('sha256')
      .update(`placement-paid-call-reservation\0${attempt.attemptId}:quiz_gen`)
      .digest('hex');
    const [reservation] = await tx
      .select({ cost: placement_starter_cost_component.cost_micro_usd })
      .from(placement_starter_cost_component)
      .where(eq(placement_starter_cost_component.id, reservationId))
      .for('update');
    // Settle-before-raise (YUK-452 review, codex P2): persist the ACTUAL provider run id + cost
    // and correct known_cost FIRST, then surface over-cap to the caller as a return flag. The prior
    // shape threw before the settle write, so an over-budget generation call lost its real
    // provider_task_run_id + actual cost and left the claim pinned to the 500k reservation
    // placeholder. This transaction commits the settlement; the caller decides whether over-cap
    // blocks the delivery.
    if (reservation) {
      const settledCost = Math.max(0, input.costMicroUsd);
      await tx
        .update(placement_starter_cost_component)
        .set({ provider_task_run_id: input.taskRunId, cost_micro_usd: settledCost })
        .where(eq(placement_starter_cost_component.id, reservationId));
      await tx
        .update(placement_starter_claim)
        .set({
          known_cost_micro_usd: sql`${placement_starter_claim.known_cost_micro_usd} - ${reservation.cost} + ${settledCost}`,
          updated_at: now,
        })
        .where(eq(placement_starter_claim.id, attempt.claimId));
      return { overCap: settledCost > reservation.cost };
    }
    await addAuthorizedCostComponent(tx, {
      authority: attempt,
      kind: 'quiz_gen',
      taskRunId: input.taskRunId,
      costMicroUsd: input.costMicroUsd,
      now,
    });
    return { overCap: false };
  });
}

/**
 * Release an unsettled paid-call reservation (YUK-452 review): delete the `reservation:*`
 * placeholder cost component and refund its reserved amount from the claim's known_cost. Idempotent
 * and RETENTION-safe — a no-op when the reservation is missing or has already been settled (its
 * provider_task_run_id no longer starts with `reservation:`), so an already-committed actual cost is
 * never clawed back. Callers invoke this when a paid call throws AFTER reserving but BEFORE settling
 * (e.g. runTaskFn network/parse failure), which would otherwise leak the reservation into known_cost
 * and falsely exhaust the claim budget.
 */
export async function releaseAuthorizedPaidCall(
  tx: Tx,
  input: { claimId: string; reservationKey: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const id = createHash('sha256')
    .update(`placement-paid-call-reservation\0${input.reservationKey}`)
    .digest('hex');
  const [reservation] = await tx
    .select({
      cost: placement_starter_cost_component.cost_micro_usd,
      providerTaskRunId: placement_starter_cost_component.provider_task_run_id,
      claimId: placement_starter_cost_component.claim_id,
    })
    .from(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, id))
    .for('update');
  if (!reservation || !reservation.providerTaskRunId.startsWith('reservation:')) return;
  // Ledger cross-wiring guard (CodeRabbit, PR #1040): the refund below debits the CALLER's
  // claimId, so a caller passing a claimId that doesn't own this reservation would silently
  // shrink the wrong claim's known_cost. All current callers derive both from one authority,
  // making this unreachable — hence a loud invariant, not a silent no-op.
  if (reservation.claimId !== input.claimId) {
    throw new Error(
      `releaseAuthorizedPaidCall: reservation ${input.reservationKey} belongs to claim ${reservation.claimId}, not ${input.claimId}`,
    );
  }
  await tx
    .delete(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, id));
  await tx
    .update(placement_starter_claim)
    .set({
      known_cost_micro_usd: sql`GREATEST(0, ${placement_starter_claim.known_cost_micro_usd} - ${reservation.cost})`,
      updated_at: now,
    })
    .where(eq(placement_starter_claim.id, input.claimId));
}

export const PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD = 100_000;

export async function reserveAuthorizedPaidCall(
  tx: Tx,
  input: {
    authority: PlacementVerificationAuthority;
    kind: PlacementCostComponentKind;
    reservationKey: string;
    maxCostMicroUsd?: number;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await assertPlacementAuthority(tx, input.authority, now);
  const costMicroUsd = input.maxCostMicroUsd ?? PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD;
  const id = createHash('sha256')
    .update(`placement-paid-call-reservation\0${input.reservationKey}`)
    .digest('hex');
  const [claim] = await tx
    .select({
      knownCost: placement_starter_claim.known_cost_micro_usd,
      budgetLimit: placement_starter_claim.budget_limit_micro_usd,
    })
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, input.authority.claim_id))
    .for('update');
  const [existing] = await tx
    .select({ id: placement_starter_cost_component.id })
    .from(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, id));
  if (existing) return;
  if (!claim || claim.knownCost + costMicroUsd > claim.budgetLimit) {
    throw new PlacementStarterAdmissionError('placement paid call exceeds claim budget');
  }
  await tx.insert(placement_starter_cost_component).values({
    id,
    claim_id: input.authority.claim_id,
    attempt_id: input.authority.attempt_id,
    component_kind: input.kind,
    question_id: input.authority.question_id,
    provider_task_run_id: `reservation:${input.reservationKey}`,
    cost_micro_usd: costMicroUsd,
    created_at: now,
  });
  await tx
    .update(placement_starter_claim)
    .set({ known_cost_micro_usd: claim.knownCost + costMicroUsd, updated_at: now })
    .where(eq(placement_starter_claim.id, input.authority.claim_id));
}

export async function settleAuthorizedPaidCall(
  tx: Tx,
  input: {
    authority: PlacementVerificationAuthority;
    reservationKey: string;
    providerTaskRunId: string;
    costMicroUsd: number;
    now?: Date;
  },
): Promise<{ overCap: boolean }> {
  const now = input.now ?? new Date();
  await assertPlacementAuthority(tx, input.authority, now);
  const id = createHash('sha256')
    .update(`placement-paid-call-reservation\0${input.reservationKey}`)
    .digest('hex');
  const [reservation] = await tx
    .select({
      cost: placement_starter_cost_component.cost_micro_usd,
      providerTaskRunId: placement_starter_cost_component.provider_task_run_id,
      kind: placement_starter_cost_component.component_kind,
    })
    .from(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, id))
    .for('update');
  if (!reservation)
    throw new PlacementStarterAdmissionError('placement paid call reservation missing');
  if (reservation.providerTaskRunId === input.providerTaskRunId) {
    return { overCap: input.costMicroUsd > reservation.cost };
  }
  if (!reservation.providerTaskRunId.startsWith('reservation:')) {
    throw new PlacementStarterAdmissionError('placement paid call reservation already settled');
  }
  const settledCost = Math.max(0, input.costMicroUsd);
  const overCap = settledCost > reservation.cost;
  const settledId = createHash('sha256')
    .update(`${input.providerTaskRunId}\0${input.authority.attempt_id}\0${input.reservationKey}`)
    .digest('hex');
  await tx.insert(placement_starter_cost_component).values({
    id: settledId,
    claim_id: input.authority.claim_id,
    attempt_id: input.authority.attempt_id,
    component_kind: reservation.kind,
    question_id: input.authority.question_id,
    provider_task_run_id: input.providerTaskRunId,
    cost_micro_usd: settledCost,
    created_at: now,
  });
  await tx
    .delete(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, id));
  await tx
    .update(placement_starter_claim)
    .set({
      known_cost_micro_usd: sql`${placement_starter_claim.known_cost_micro_usd} - ${reservation.cost} + ${settledCost}`,
      updated_at: now,
    })
    .where(eq(placement_starter_claim.id, input.authority.claim_id));
  return { overCap };
}

export async function addAuthorizedCostComponent(
  tx: Tx,
  input: {
    authority: Pick<PlacementAttemptAuthority, 'claimId' | 'attemptId' | 'fencingToken'>;
    kind: PlacementCostComponentKind;
    taskRunId: string;
    costMicroUsd: number;
    questionId?: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const [claim] = await tx
    .select({
      knownCost: placement_starter_claim.known_cost_micro_usd,
      budgetLimit: placement_starter_claim.budget_limit_micro_usd,
    })
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, input.authority.claimId))
    .for('update');
  const existingComponentId = createHash('sha256')
    .update(`${input.taskRunId}\0${input.kind}\0${input.questionId ?? ''}`)
    .digest('hex');
  const [existingComponent] = await tx
    .select({ id: placement_starter_cost_component.id })
    .from(placement_starter_cost_component)
    .where(eq(placement_starter_cost_component.id, existingComponentId));
  if (
    !existingComponent &&
    (!claim || claim.knownCost + Math.max(0, input.costMicroUsd) > claim.budgetLimit)
  ) {
    throw new PlacementStarterAdmissionError('placement cost component exceeds claim budget');
  }
  const [attempt] = await tx
    .select({ fence: placement_starter_attempt.fencing_token })
    .from(placement_starter_attempt)
    .where(eq(placement_starter_attempt.id, input.authority.attemptId));
  if (attempt?.fence !== input.authority.fencingToken) {
    throw new PlacementStarterStaleAuthorityError('placement cost authority is stale');
  }
  const id = existingComponentId;
  await tx
    .insert(placement_starter_cost_component)
    .values({
      id,
      claim_id: input.authority.claimId,
      attempt_id: input.authority.attemptId,
      component_kind: input.kind,
      question_id: input.questionId ?? null,
      provider_task_run_id: input.taskRunId,
      cost_micro_usd: Math.max(0, input.costMicroUsd),
      created_at: now,
    })
    .onConflictDoNothing();
  await tx
    .update(placement_starter_claim)
    .set({
      known_cost_micro_usd: sql`(
        SELECT COALESCE(SUM(${placement_starter_cost_component.cost_micro_usd}), 0)::int
        FROM ${placement_starter_cost_component}
        WHERE ${placement_starter_cost_component.claim_id} = ${input.authority.claimId}
      )`,
      updated_at: now,
    })
    .where(eq(placement_starter_claim.id, input.authority.claimId));
}

export async function countEligiblePlacementQuestions(
  db: Db | Tx,
  claimId: string,
  attemptId?: string,
): Promise<number> {
  // Eligibility = the question is authorized for this claim, currently POOL-VISIBLE (active, via the
  // shared notDraftPredicate), not archived, and probes the claim's KC. An 'active' draft_status is
  // itself the verification proof — nothing reaches active without passing a verify gate (quiz_verify,
  // source_verify, or an explicit accept). The prior inner join on a fresh experimental:quiz_verify
  // success event WRONGLY excluded active DUPLICATES that were verified via a different path (or a
  // prior attempt): quiz_gen attaches such a live question to the attempt but the outbox terminal_skips
  // re-verifying an already-active question, so no quiz_verify event is ever written for it
  // (YUK-452 round-3, codex P2-B).
  const verified = await db
    .select({ questionId: placement_starter_attempt_question.question_id })
    .from(placement_starter_attempt_question)
    .innerJoin(question, eq(question.id, placement_starter_attempt_question.question_id))
    .innerJoin(
      placement_starter_claim,
      eq(placement_starter_claim.id, placement_starter_attempt_question.claim_id),
    )
    .where(
      and(
        eq(placement_starter_attempt_question.claim_id, claimId),
        ...(attemptId ? [eq(placement_starter_attempt_question.attempt_id, attemptId)] : []),
        eq(placement_starter_attempt_question.verification_status, 'authorized'),
        notDraftPredicate(question.draft_status),
        isNull(sql`${question.metadata}->>'archived_at'`),
        sql`${question.knowledge_ids} @> jsonb_build_array(${placement_starter_claim.knowledge_id})`,
      ),
    );
  return new Set(verified.map((row) => row.questionId)).size;
}

export async function placementAttemptVerificationSettled(
  db: Db | Tx,
  attemptId: string,
): Promise<boolean> {
  // A question's verification is SETTLED when it is already pool-visible (active — verified by
  // definition; an active DUPLICATE the outbox terminal_skips never gets a fresh quiz_verify event,
  // YUK-452 round-3, codex P2-B) OR it carries a terminal quiz_verify verdict (any non-error
  // outcome — pass/needs_review/fail all settle a draft). Only a still-draft question with no
  // terminal verdict keeps the delivery polling.
  const rows = await db
    .select({
      questionId: placement_starter_attempt_question.question_id,
      terminal: sql<boolean>`(
        ${notDraftPredicate(question.draft_status)}
        OR EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${placement_starter_attempt_question.question_id}
            AND ${event.action} = 'experimental:quiz_verify'
            AND ${event.outcome} IS DISTINCT FROM 'error'
        )
      )`,
    })
    .from(placement_starter_attempt_question)
    .innerJoin(question, eq(question.id, placement_starter_attempt_question.question_id))
    .where(eq(placement_starter_attempt_question.attempt_id, attemptId));
  return rows.length > 0 && rows.every((row) => row.terminal);
}

export async function markAttemptVerifying(
  db: Db,
  attempt: PlacementAttemptAuthority,
): Promise<void> {
  const now = new Date();
  // Attempt + claim status must flip together: a crash between the two UPDATEs would leave the
  // attempt 'verifying' while the claim stays 'running' (or vice versa), a split state the fence /
  // reconcile guards do not model. One transaction (YUK-452 review).
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(placement_starter_attempt)
      .set({ status: 'verifying', updated_at: now })
      .where(
        and(
          eq(placement_starter_attempt.id, attempt.attemptId),
          eq(placement_starter_attempt.fencing_token, attempt.fencingToken),
          eq(placement_starter_attempt.status, 'running'),
        ),
      )
      .returning({ id: placement_starter_attempt.id });
    if (rows.length !== 1)
      throw new PlacementStarterStaleAuthorityError('placement attempt fence lost');
    await tx
      .update(placement_starter_claim)
      .set({ status: 'verifying', updated_at: now })
      .where(eq(placement_starter_claim.id, attempt.claimId));
  });
}

export async function finishPlacementAttempt(
  db: Db,
  attempt: PlacementAttemptAuthority,
  status: 'succeeded' | 'underfilled' | 'timed_out' | 'interrupted',
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(placement_starter_attempt)
      .set({ status, lease_expires_at: null, finished_at: now, updated_at: now })
      .where(
        and(
          eq(placement_starter_attempt.id, attempt.attemptId),
          eq(placement_starter_attempt.fencing_token, attempt.fencingToken),
          inArray(placement_starter_attempt.status, ['running', 'verifying']),
        ),
      )
      .returning({ id: placement_starter_attempt.id });
    if (rows.length !== 1)
      throw new PlacementStarterStaleAuthorityError('placement attempt fence lost');
    await tx
      .update(placement_starter_attempt_question)
      .set({ verification_status: status === 'succeeded' ? 'satisfied' : 'superseded' })
      .where(eq(placement_starter_attempt_question.attempt_id, attempt.attemptId));
    // Exhaustion (YUK-452 review): the pg-boss quiz_gen job has retryLimit=2 → exactly 3
    // deliveries. When the FINAL (max_paid_attempts-th) delivery fails to satisfy, there is no
    // further redelivery and no recovery sweeper consumes retry_scheduled, so writing
    // retry_scheduled here would zombie the claim non-terminal forever. Terminalize as
    // 'exhausted' (owner-locked explicit terminal failure state) so placement stops waiting on a
    // batch that will never arrive. Non-final failures stay retry_scheduled — acquirePlacementAttempt
    // accepts that status and the pg-boss retry re-drives the next delivery.
    const [claimRow] = await tx
      .select({ maxPaidAttempts: placement_starter_claim.max_paid_attempts })
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, attempt.claimId))
      .for('update');
    if (!claimRow) throw new PlacementStarterStaleAuthorityError('placement claim missing');
    const exhausted = status !== 'succeeded' && attempt.deliveryNo >= claimRow.maxPaidAttempts;
    await tx
      .update(placement_starter_claim)
      .set(
        status === 'succeeded'
          ? { status: 'satisfied', satisfied_at: now, updated_at: now }
          : exhausted
            ? { status: 'exhausted', exhausted_at: now, updated_at: now }
            : { status: 'retry_scheduled', updated_at: now },
      )
      .where(eq(placement_starter_claim.id, attempt.claimId));
  });
}
