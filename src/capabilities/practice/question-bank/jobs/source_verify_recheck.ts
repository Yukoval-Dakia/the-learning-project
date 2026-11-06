// source_verify recheck paid-effect claim (split out of source_verify.ts).
//
// One command event pays at most one verify attempt. Every delivery (ordinary
// job, pg-boss redelivery, sweep recovery carrying the command id) enters
// through claimSourceVerifyRecheck: 'sending'/'unknown'/'receipt_ready' rows
// mean a prior delivery reached the paid call and never committed an outcome —
// never re-paid. An 'applied' row is terminal EXCEPT the provable not_sent
// settlement (a delivery that can show no provider query ever started): only
// that opens a new attempt row with a bumped attempt counter under the same
// command identity.

import { and, eq } from 'drizzle-orm';
import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  recordPaidEffectApplication,
  recordPaidEffectResult,
} from '@/db/paid-effect-store';
import { paid_effect } from '@/db/schema';

export type SourceVerifyRecheckClaim = {
  identity: PaidEffectIdentity;
  fence: number;
  deliveryId: string;
};

export type SourceVerifyRecheckClaimOutcome =
  | { kind: 'claimed'; identity: PaidEffectIdentity; fence: number }
  | { kind: 'held'; state: string };

export async function claimSourceVerifyRecheck(input: {
  db: Db;
  questionId: string;
  commandEventId: string;
  deliveryId: string;
}): Promise<SourceVerifyRecheckClaimOutcome> {
  return input.db.transaction(async (tx) => {
    const priorRows = await tx
      .select({
        state: paid_effect.state,
        input_json: paid_effect.input_json,
        result_json: paid_effect.result_json,
      })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, 'source_verify'),
          eq(paid_effect.entity_id, input.questionId),
          eq(paid_effect.entity_revision, input.commandEventId),
          eq(paid_effect.unit, 'source_verify@1'),
        ),
      );
    const pending = priorRows.find((row) => row.state === 'pending');
    if (priorRows.some((row) => ['sending', 'unknown', 'receipt_ready'].includes(row.state))) {
      return { kind: 'held' as const, state: 'sending' };
    }
    if (
      priorRows.some(
        (row) =>
          row.state === 'applied' &&
          (row.result_json == null ||
            typeof row.result_json !== 'object' ||
            (row.result_json as Record<string, unknown>).status !== 'not_sent'),
      )
    ) {
      return { kind: 'held' as const, state: 'applied' };
    }
    const attempt =
      pending != null
        ? (((pending.input_json as Record<string, unknown> | null)?.attempt as
            | number
            | undefined) ?? 1)
        : Math.max(
            0,
            ...priorRows.map((row) => {
              const value = (row.input_json as Record<string, unknown> | null)?.attempt;
              return typeof value === 'number' && Number.isInteger(value) ? value : 1;
            }),
          ) + 1;
    const recheckEffect = {
      family: 'source_verify' as const,
      entityId: input.questionId,
      entityRevision: input.commandEventId,
      unit: 'source_verify@1' as const,
      input: pending?.input_json ?? {
        question_id: input.questionId,
        command_event_id: input.commandEventId,
        attempt,
      },
    };
    const admitted = await admitPaidEffectIntent(tx, recheckEffect);
    if (admitted.kind === 'existing' && admitted.state !== 'pending') {
      return { kind: 'held' as const, state: admitted.state };
    }
    const identity = computePaidEffectIdentity(recheckEffect);
    const send = await claimPaidEffectSend(tx, identity, {
      backend: 'pg-boss',
      deliveryId: input.deliveryId,
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    });
    if (send.kind !== 'claimed') {
      return { kind: 'held' as const, state: send.kind === 'refused' ? send.state : 'pending' };
    }
    return { kind: 'claimed' as const, identity, fence: send.fence };
  });
}

/** The delivery provably sent nothing (no provider query started): record the
 * not_sent receipt + application under its own delivery so the next claim
 * attempt may proceed. Both writes must commit together to avoid a stuck receipt. */
export async function settleRecheckNotSent(
  tx: Tx,
  claim: SourceVerifyRecheckClaim,
  questionId: string,
  commandEventId: string,
): Promise<void> {
  try {
    await recordPaidEffectResult(
      tx,
      claim.identity,
      claim.deliveryId,
      { status: 'not_sent' },
      { fence: claim.fence },
    );
    await recordPaidEffectApplication(tx, claim.identity, {
      question_id: questionId,
      command_event_id: commandEventId,
      status: 'not_sent',
    });
  } catch (error) {
    console.error('[source_verify] not_sent settlement failed', questionId, error);
    throw error;
  }
}
