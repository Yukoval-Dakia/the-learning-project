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
      throw new PlacementStarterAdmissionError('placement starter budget exhausted');
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

export async function recordPlacementAttemptOutput(
  db: Db,
  attempt: PlacementAttemptAuthority,
  input: { taskRunId: string; outputText: string; costMicroUsd: number; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const outputHash = createHash('sha256').update(input.outputText).digest('hex');
  await db.transaction(async (tx) => {
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
    await addAuthorizedCostComponent(tx, {
      authority: attempt,
      kind: 'quiz_gen',
      taskRunId: input.taskRunId,
      costMicroUsd: input.costMicroUsd,
      now,
    });
  });
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
  const [attempt] = await tx
    .select({ fence: placement_starter_attempt.fencing_token })
    .from(placement_starter_attempt)
    .where(eq(placement_starter_attempt.id, input.authority.attemptId));
  if (attempt?.fence !== input.authority.fencingToken) {
    throw new PlacementStarterStaleAuthorityError('placement cost authority is stale');
  }
  const id = createHash('sha256')
    .update(`${input.taskRunId}\0${input.kind}\0${input.questionId ?? ''}`)
    .digest('hex');
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
): Promise<number> {
  const verified = await db
    .select({ questionId: placement_starter_attempt_question.question_id })
    .from(placement_starter_attempt_question)
    .innerJoin(question, eq(question.id, placement_starter_attempt_question.question_id))
    .innerJoin(
      placement_starter_claim,
      eq(placement_starter_claim.id, placement_starter_attempt_question.claim_id),
    )
    .innerJoin(
      event,
      and(
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, question.id),
        eq(event.action, 'experimental:quiz_verify'),
        eq(event.outcome, 'success'),
      ),
    )
    .where(
      and(
        eq(placement_starter_attempt_question.claim_id, claimId),
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
  const rows = await db
    .select({
      questionId: placement_starter_attempt_question.question_id,
      terminal: sql<boolean>`EXISTS (
        SELECT 1 FROM ${event}
        WHERE ${event.subject_kind} = 'question'
          AND ${event.subject_id} = ${placement_starter_attempt_question.question_id}
          AND ${event.action} = 'experimental:quiz_verify'
          AND ${event.outcome} IS DISTINCT FROM 'error'
      )`,
    })
    .from(placement_starter_attempt_question)
    .where(eq(placement_starter_attempt_question.attempt_id, attemptId));
  return rows.length > 0 && rows.every((row) => row.terminal);
}

export async function markAttemptVerifying(
  db: Db,
  attempt: PlacementAttemptAuthority,
): Promise<void> {
  const now = new Date();
  const rows = await db
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
  await db
    .update(placement_starter_claim)
    .set({ status: 'verifying', updated_at: now })
    .where(eq(placement_starter_claim.id, attempt.claimId));
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
    await tx
      .update(placement_starter_claim)
      .set(
        status === 'succeeded'
          ? { status: 'satisfied', satisfied_at: now, updated_at: now }
          : { status: 'retry_scheduled', updated_at: now },
      )
      .where(eq(placement_starter_claim.id, attempt.claimId));
  });
}
