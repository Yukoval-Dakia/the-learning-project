// The one decision transaction for proposal accepts and dismisses. The kernel owns
// the decision lock, the re-check under it of the recorded rate and of the
// proposal's correction state, the single rate event and the decision signal;
// owners supply only their domain effect. Lock order is fixed: proposal_decision
// first, owner domain locks inside the effect.

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { acquireProposalDecisionLock, findExistingRateEvent } from './applier-helpers';
import {
  type ProposalSignalSource,
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from './signals';

export type RecordedProposalRate = NonNullable<Awaited<ReturnType<typeof findExistingRateEvent>>>;

/** Where the decision signal is recorded relative to the decision transaction. */
export type ProposalSignalTiming = 'in_transaction' | 'after_commit';

export interface ProposalRateWrite {
  /** Pre-minted id, for same-transaction rows that cite the rate as caused_by. */
  readonly id?: string;
  /** Shared clock with the owner's same-transaction events; defaults to now. */
  readonly created_at?: Date;
  /** Owner fields stored beside `rating` and the learner's `user_note`. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** learning_item rates have never carried user_note. */
  readonly omitUserNote?: true;
  readonly task_run_id?: string | null;
  readonly cost_micro_usd?: number | null;
}

export interface ProposalAcceptEffectContext {
  readonly tx: Tx;
  /** Writes this accept's one rate event; returns its id. */
  writeRate(rate?: ProposalRateWrite): Promise<string>;
}

/** `skipped` = soft-stale: no rate, no signal, the proposal stays pending. */
export type ProposalAcceptEffectOutcome<TResult> = {
  readonly status: 'accepted' | 'skipped';
  readonly result: TResult;
};

export class SkippedProposalDecision<TResult> {
  constructor(readonly result: TResult) {}
}

export interface ProposalAcceptPlan<TResult, TPrepared> {
  readonly proposal: ProposalSignalSource;
  readonly userNote?: string;
  readonly signal: ProposalSignalTiming;
  /** Public result rebuilt from the recorded accept rate; the kernel reconciles the signal first. */
  replay(rate: RecordedProposalRate): Promise<TResult>;
  /**
   * Owner preflight outside the decision transaction, after the replay fast path.
   * Returning SkippedProposalDecision ends the accept without a rate or signal.
   */
  prepare?(): Promise<TPrepared | SkippedProposalDecision<TResult>>;
  /**
   * The owner's prepare commits its own writes, so the decision is also re-checked under
   * the lock before prepare runs, not only in the decision transaction.
   */
  readonly recheckBeforePrepare?: true;
  /** Owner domain effect inside the decision transaction, after the kernel re-checks. */
  effect(
    ctx: ProposalAcceptEffectContext,
    prepared: TPrepared,
  ): Promise<ProposalAcceptEffectOutcome<TResult>>;
}

export interface ProposalAcceptRun<TResult> {
  readonly outcome: 'accepted' | 'replayed' | 'skipped';
  readonly result: TResult;
}

function conflictWith(proposalId: string, decided: RecordedProposalRate): ApiError {
  return new ApiError(
    'conflict',
    `proposal ${proposalId} already decided as ${decided.decision}`,
    409,
  );
}

type LockedDecision =
  | { readonly status: 'open' }
  | { readonly status: 'decided'; readonly rate: RecordedProposalRate }
  | { readonly status: 'corrected'; readonly state: string };

// A retraction that committed while this decision waited for the lock must stop it, the
// same as a retraction seen before the decision started.
async function readDecisionUnderLock(tx: Tx, proposalId: string): Promise<LockedDecision> {
  await acquireProposalDecisionLock(tx, proposalId);
  const decided = await findExistingRateEvent(tx, proposalId);
  if (decided) return { status: 'decided', rate: decided };
  const correction = await getCorrectionStatus(tx, proposalId);
  if (correction.state !== 'active') return { status: 'corrected', state: correction.state };
  return { status: 'open' };
}

function correctedAccept(proposalId: string, state: string): ApiError {
  return new ApiError('conflict', `proposal ${proposalId} is ${state} and cannot be accepted`, 409);
}

async function writeRateEvent(
  tx: Tx,
  proposalId: string,
  rating: 'accept' | 'dismiss',
  userNote: string | undefined,
  rate: ProposalRateWrite = {},
): Promise<string> {
  const rateEventId = rate.id ?? newId();
  await writeEvent(tx, {
    id: rateEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating,
      ...(userNote && !rate.omitUserNote ? { user_note: userNote } : {}),
      ...rate.payload,
    },
    caused_by_event_id: proposalId,
    ...(rate.task_run_id !== undefined ? { task_run_id: rate.task_run_id } : {}),
    ...(rate.cost_micro_usd !== undefined ? { cost_micro_usd: rate.cost_micro_usd } : {}),
    created_at: rate.created_at ?? new Date(),
  });
  return rateEventId;
}

export async function runProposalAccept<TResult, TPrepared = undefined>(
  db: Db,
  proposalId: string,
  plan: ProposalAcceptPlan<TResult, TPrepared>,
): Promise<ProposalAcceptRun<TResult>> {
  const replayed = async (rate: RecordedProposalRate): Promise<ProposalAcceptRun<TResult>> => {
    await ensureProposalDecisionSignal(db, plan.proposal, 'accept', plan.userNote);
    return { outcome: 'replayed', result: await plan.replay(rate) };
  };

  // Cheap short-circuit; the transaction re-checks under the decision lock.
  const recorded = await findExistingRateEvent(db, proposalId);
  if (recorded) {
    if (recorded.decision !== 'accept') throw conflictWith(proposalId, recorded);
    return replayed(recorded);
  }

  const acceptable = (locked: LockedDecision): LockedDecision => {
    if (locked.status === 'decided' && locked.rate.decision !== 'accept') {
      throw conflictWith(proposalId, locked.rate);
    }
    if (locked.status === 'corrected') throw correctedAccept(proposalId, locked.state);
    return locked;
  };

  if (plan.recheckBeforePrepare) {
    const locked = acceptable(await db.transaction((tx) => readDecisionUnderLock(tx, proposalId)));
    if (locked.status === 'decided') return replayed(locked.rate);
  }

  const prepared = plan.prepare ? await plan.prepare() : (undefined as TPrepared);
  if (prepared instanceof SkippedProposalDecision) {
    return { outcome: 'skipped', result: prepared.result };
  }

  const settled = await db.transaction(async (tx) => {
    const locked = acceptable(await readDecisionUnderLock(tx, proposalId));
    if (locked.status === 'decided') return locked;

    let rateWrites = 0;
    const outcome = await plan.effect(
      {
        tx,
        writeRate: async (rate) => {
          rateWrites += 1;
          if (rateWrites > 1) {
            throw new Error(`accept effect for proposal ${proposalId} wrote a second rate`);
          }
          return writeRateEvent(tx, proposalId, 'accept', plan.userNote, rate);
        },
      },
      prepared,
    );
    if (rateWrites !== (outcome.status === 'accepted' ? 1 : 0)) {
      throw new Error(
        `accept effect for proposal ${proposalId} returned ${outcome.status} after ${rateWrites} rate writes`,
      );
    }
    if (outcome.status === 'accepted' && plan.signal === 'in_transaction') {
      await recordProposalDecisionSignal(tx, plan.proposal, 'accept', plan.userNote);
    }
    return outcome;
  });

  if (settled.status === 'decided') return replayed(settled.rate);
  if (settled.status === 'skipped') return { outcome: 'skipped', result: settled.result };
  if (plan.signal === 'after_commit') {
    await recordProposalDecisionSignal(db, plan.proposal, 'accept', plan.userNote);
  }
  return { outcome: 'accepted', result: settled.result };
}

export interface ProposalDismissPlan {
  readonly proposal: ProposalSignalSource;
  readonly userNote?: string;
  readonly signal: ProposalSignalTiming;
  /** Owner domain effect after a new dismiss rate, inside the decision transaction. */
  effect?(tx: Tx): Promise<void>;
}

export type ProposalDismissedResult = {
  readonly kind: 'dismissed';
  readonly rate_event_id: string | null;
  readonly idempotent?: true;
};

export async function runProposalDismiss(
  db: Db,
  proposalId: string,
  plan: ProposalDismissPlan,
): Promise<ProposalDismissedResult> {
  const settled = await db.transaction(async (tx) => {
    const locked = await readDecisionUnderLock(tx, proposalId);
    if (locked.status === 'decided') {
      if (locked.rate.decision !== 'dismiss') throw conflictWith(proposalId, locked.rate);
      return { rateEventId: locked.rate.id, idempotent: true } as const;
    }
    // Same answer the dispatcher gives a proposal already retracted before the dismiss.
    if (locked.status === 'corrected') return { rateEventId: null, idempotent: true } as const;
    const rateEventId = await writeRateEvent(tx, proposalId, 'dismiss', plan.userNote);
    if (plan.effect) await plan.effect(tx);
    if (plan.signal === 'in_transaction') {
      await recordProposalDecisionSignal(tx, plan.proposal, 'dismiss', plan.userNote);
    }
    return { rateEventId, idempotent: false } as const;
  });

  if (!settled.idempotent && plan.signal === 'after_commit') {
    await recordProposalDecisionSignal(db, plan.proposal, 'dismiss', plan.userNote);
  }
  return {
    kind: 'dismissed',
    rate_event_id: settled.rateEventId,
    ...(settled.idempotent ? { idempotent: true as const } : {}),
  };
}
