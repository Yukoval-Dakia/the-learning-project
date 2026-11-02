// Placement claim authority for questions and uncapped paid effects (YUK-1468 FULL policy).
// One owner for: binding a question to a live delivery attempt with its verification epoch
// (quiz_gen persist, sourcing_web submit/resume), reading a question's current binding, and the
// fence + ledger of every real paid effect of a sourcing_web claim. Reservation-based paid calls
// of the original quiz_gen policy stay in placement-starter-attempts.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
} from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { writeVerifyDispatchIntent } from '../../server/verify-dispatch-outbox';
import type { SupplyTraceV1T } from '@/kernel/supply-contracts';
import {
  type PlacementAttemptAuthority,
  type PlacementCostComponentKind,
  PlacementStarterAdmissionError,
  type PlacementVerificationAuthority,
  assertPlacementAttemptFence,
  assertPlacementAuthority,
  recomputePlacementKnownCost,
} from './placement-starter-attempts';

/** Server-side authority for a sourcing_web placement paid effect, at either granularity. */
export type PlacementPaidEffectAuthority =
  | { scope: 'attempt'; attempt: PlacementAttemptAuthority }
  | { scope: 'question'; authority: PlacementVerificationAuthority };

function paidEffectOwner(authority: PlacementPaidEffectAuthority) {
  return authority.scope === 'attempt'
    ? {
        claimId: authority.attempt.claimId,
        attemptId: authority.attempt.attemptId,
        questionId: null,
      }
    : {
        claimId: authority.authority.claim_id,
        attemptId: authority.authority.attempt_id,
        questionId: authority.authority.question_id,
      };
}

/**
 * Gate before a real paid call on a sourcing_web claim. Uses the same fence/epoch facts as the
 * original quiz_gen/quiz_verify path; there is no reservation because this policy has no money
 * cap. A stale delivery, superseded epoch or terminal claim cannot start new spend.
 */
export async function assertPlacementPaidEffectAuthority(
  db: Db,
  authority: PlacementPaidEffectAuthority,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (authority.scope === 'attempt') await assertPlacementAttemptFence(tx, authority.attempt);
    else await assertPlacementAuthority(tx, authority.authority);
    const [claim] = await tx
      .select({ route: placement_starter_claim.supply_route })
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, paidEffectOwner(authority).claimId));
    if (claim?.route !== 'sourcing_web') {
      throw new PlacementStarterAdmissionError(
        'placement paid effect without reservation requires a sourcing_web claim',
      );
    }
  });
}

/**
 * Record one real paid effect of a sourcing_web claim after the call returned or failed.
 * Identity is the actual provider task run; a call whose run id or cost is unavailable is
 * recorded under its invocation key with cost NULL (unknown, never 0), which makes the claim's
 * known cost unknown. Bookkeeping is not fenced: money spent under an authority checked before
 * the call is recorded even if that delivery has since lost its lease. Idempotent per
 * (run, kind, question), so replays never merge two effects or count one twice.
 */
export async function recordPlacementPaidEffect(
  db: Db,
  input: {
    authority: PlacementPaidEffectAuthority;
    kind: PlacementCostComponentKind;
    invocationKey: string;
    providerTaskRunId: string | null | undefined;
    /** The runner's reported USD cost; null/undefined = unknown. */
    costUsd: number | null | undefined;
    now?: Date;
  },
): Promise<{ costUnknown: boolean }> {
  const now = input.now ?? new Date();
  const owner = paidEffectOwner(input.authority);
  const runId = input.providerTaskRunId || `unknown:${input.invocationKey}`;
  const cost = input.providerTaskRunId ? costUsdToMicroUsd(input.costUsd ?? null) : null;
  if (cost !== null && cost < 0) {
    throw new PlacementStarterAdmissionError('placement settled cost must be nonnegative');
  }
  const id = createHash('sha256')
    .update(`${runId}\0${input.kind}\0${owner.questionId ?? ''}`)
    .digest('hex');
  await db.transaction(async (tx) => {
    const [claim] = await tx
      .select({ route: placement_starter_claim.supply_route })
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, owner.claimId))
      .for('update');
    if (claim?.route !== 'sourcing_web') {
      throw new PlacementStarterAdmissionError(
        'placement paid effect without reservation requires a sourcing_web claim',
      );
    }
    await tx
      .insert(placement_starter_cost_component)
      .values({
        id,
        claim_id: owner.claimId,
        attempt_id: owner.attemptId,
        component_kind: input.kind,
        question_id: owner.questionId,
        provider_task_run_id: runId,
        cost_micro_usd: cost,
        over_cap: null,
        created_at: now,
      })
      .onConflictDoNothing();
    await recomputePlacementKnownCost(tx, owner.claimId, now);
  });
  return { costUnknown: cost === null };
}

/**
 * The single question-authority writer for placement deliveries (quiz_gen persist and the
 * sourcing_web submit/resume). In the caller's question/publication transaction it binds the
 * question to the live attempt with a fresh verification epoch and writes the verifier intent
 * carrying the full authority. `allowPersistedReplay` re-reads this attempt's own epoch;
 * `rebindSuperseded` moves a question a lost earlier delivery of the SAME claim had bound onto
 * the current attempt with a new epoch, so that delivery's late verifier writes are refused.
 */
export async function authorizePlacementQuestion(
  tx: Tx,
  input: {
    attempt: PlacementAttemptAuthority | undefined;
    questionId: string;
    canonicalHash: string;
    verifier: 'quiz_verify' | 'source_verify';
    supplyTrace: SupplyTraceV1T | undefined;
    allowPersistedReplay: boolean;
    rebindSuperseded?: boolean;
    now: Date;
  },
): Promise<PlacementVerificationAuthority | null> {
  const { attempt, questionId, canonicalHash, supplyTrace, allowPersistedReplay, now } = input;
  if (!attempt) return null;
  const columns = {
    claimId: placement_starter_attempt_question.claim_id,
    attemptId: placement_starter_attempt_question.attempt_id,
    questionId: placement_starter_attempt_question.question_id,
    epoch: placement_starter_attempt_question.verification_authority_epoch,
  };
  const inserted = await tx
    .insert(placement_starter_attempt_question)
    .values({
      attempt_id: attempt.attemptId,
      claim_id: attempt.claimId,
      question_id: questionId,
      canonical_hash: canonicalHash,
      verification_authority_epoch: randomUUID(),
      verification_status: 'authorized',
      created_at: now,
    })
    .onConflictDoNothing()
    .returning(columns);
  let persisted = inserted[0];
  if (inserted.length > 1) {
    throw new Error('placement authority insert returned multiple rows');
  }
  if (!persisted && allowPersistedReplay) {
    [persisted] = await tx
      .select(columns)
      .from(placement_starter_attempt_question)
      .where(
        and(
          eq(placement_starter_attempt_question.attempt_id, attempt.attemptId),
          eq(placement_starter_attempt_question.question_id, questionId),
        ),
      )
      .limit(1);
  }
  if (!persisted && input.rebindSuperseded) {
    [persisted] = await tx
      .update(placement_starter_attempt_question)
      .set({
        attempt_id: attempt.attemptId,
        verification_authority_epoch: randomUUID(),
        verification_status: 'authorized',
      })
      .where(
        and(
          eq(placement_starter_attempt_question.claim_id, attempt.claimId),
          eq(placement_starter_attempt_question.question_id, questionId),
          eq(placement_starter_attempt_question.verification_status, 'superseded'),
        ),
      )
      .returning(columns);
  }
  if (!persisted) return null;
  const authority: PlacementVerificationAuthority = {
    claim_id: persisted.claimId,
    attempt_id: persisted.attemptId,
    question_id: persisted.questionId,
    verification_authority_epoch: persisted.epoch,
    fencing_token: attempt.fencingToken,
  };
  await writeVerifyDispatchIntent(tx, {
    questionId: persisted.questionId,
    verifier: input.verifier,
    supplyTrace,
    placementAuthority: authority,
    createdAt: now,
  });
  return authority;
}

/** The current authorized placement binding of a question, with its attempt's live fence. */
export async function readPlacementQuestionAuthority(
  db: Db | Tx,
  questionId: string,
): Promise<PlacementVerificationAuthority | null> {
  const [row] = await db
    .select({
      claim_id: placement_starter_attempt_question.claim_id,
      attempt_id: placement_starter_attempt_question.attempt_id,
      question_id: placement_starter_attempt_question.question_id,
      verification_authority_epoch: placement_starter_attempt_question.verification_authority_epoch,
      fencing_token: placement_starter_attempt.fencing_token,
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
        eq(placement_starter_attempt_question.question_id, questionId),
        eq(placement_starter_attempt_question.verification_status, 'authorized'),
        eq(placement_starter_claim.supply_route, 'sourcing_web'),
      ),
    )
    .limit(1);
  return row ?? null;
}

type PaidResult = { task_run_id?: string | null; cost_usd?: number | null };

/**
 * Paid-call hooks for one placement-bound question verification (the verify framework's
 * before/settle/release seams, plus a runTask wrapper for single calls). Each real call is
 * gated on the question's claim/attempt/epoch/fence and recorded with its real run id and cost;
 * a call that threw after the gate is recorded unknown. No reservation: uncapped policy.
 */
export function buildPlacementQuestionPaidCalls(
  db: Db,
  questionId: string,
  authority: PlacementVerificationAuthority,
) {
  const owner = { scope: 'question' as const, authority };
  const key = (kind: string, invocationId: string) =>
    `${authority.attempt_id}:${questionId}:${kind}:${invocationId}`;
  const record = (
    kind: PlacementCostComponentKind,
    invocationKey: string,
    result: PaidResult | null,
  ) =>
    recordPlacementPaidEffect(db, {
      authority: owner,
      kind,
      invocationKey,
      providerTaskRunId: result?.task_run_id ?? null,
      costUsd: result?.cost_usd ?? null,
    });
  return {
    assertBefore: () => assertPlacementPaidEffectAuthority(db, owner),
    solve: {
      beforePaidCall: async () => assertPlacementPaidEffectAuthority(db, owner),
      settlePaidCall: async (
        kind: 'solution_check' | 'semantic_judge',
        invocationId: string,
        result: { task_run_id?: string; cost_usd?: number },
      ) => {
        await record('solution_check', key(kind, invocationId), result);
      },
      releasePaidCall: async (kind: 'solution_check' | 'semantic_judge', invocationId: string) => {
        await record('solution_check', key(kind, invocationId), null);
      },
    },
    /** Record every call `run` makes under `kind` (the caller asserts before). */
    wrapRunTask<Args extends unknown[], R extends PaidResult>(
      kind: PlacementCostComponentKind,
      run: (...args: Args) => Promise<R>,
    ): (...args: Args) => Promise<R> {
      return async (...args) => {
        const invocationKey = key(kind, randomUUID());
        let result: R;
        try {
          result = await run(...args);
        } catch (error) {
          await record(kind, invocationKey, null);
          throw error;
        }
        await record(kind, invocationKey, result);
        return result;
      };
    },
  };
}
