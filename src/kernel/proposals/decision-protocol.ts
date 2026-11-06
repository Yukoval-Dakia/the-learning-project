// The one decision transaction for proposal accepts and dismisses. The kernel owns
// the decision lock, the re-check under it of the recorded rate and of the
// proposal's correction state, the single rate event and the decision signal;
// owners supply only their domain effect. Lock order is fixed: proposal_decision
// first, owner domain locks inside the effect.

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  type ExistingRateDecision,
  acquireProposalDecisionLock,
  findExistingRateEvent,
} from './applier-helpers';
import {
  type ProposalSignalSource,
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from './signals';
import { type ProposalDecisionActor, USER_DECISION_ACTOR } from './types';

export type RecordedProposalRate = NonNullable<Awaited<ReturnType<typeof findExistingRateEvent>>>;

/** Where the decision signal is recorded relative to the decision transaction. */
export type ProposalSignalTiming = 'in_transaction' | 'after_commit';

export interface ProposalRateWrite {
  /** Pre-minted id, for same-transaction rows that cite the rate as caused_by. */
  readonly id?: string;
  /** The rating this write records; defaults to the plan's requested rating. */
  readonly rating?: ExistingRateDecision;
  /**
   * Event subject override; defaults to the proposal event itself
   * (subject_kind='event'). knowledge_edge rates keep their wider-rating
   * RateKnowledgeEdge shape (subject_kind='knowledge_edge').
   */
  readonly subject?: { readonly kind: string; readonly id: string };
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

/**
 * First call inside each transaction a prepare step commits on its own. It takes the
 * decision lock there and throws once the proposal is dismissed or retracted; a recorded
 * accept passes, so the owner's idempotent writes replay.
 */
export type ProposalWriteGuard = (tx: Tx) => Promise<void>;

export interface ProposalAcceptPlan<TResult, TPrepared> {
  readonly proposal: ProposalSignalSource;
  readonly userNote?: string;
  /**
   * Decision actor for the one rate event. Omitted = the human inbox path
   * (`user/self`); auto-apply passes the proposing agent's real identity.
   */
  readonly actor?: ProposalDecisionActor;
  readonly signal: ProposalSignalTiming;
  /**
   * The decision this accept requests. The replay condition is "the recorded
   * rating equals this one"; a different recorded decision is a 409. Defaults to
   * 'accept' — owners with multi-decision accepts (knowledge_edge reverse /
   * change_type) pass the requested rating here.
   */
  readonly rating?: ExistingRateDecision;
  /** Public result rebuilt from the recorded accept rate; the kernel reconciles the signal first. */
  replay(rate: RecordedProposalRate): Promise<TResult>;
  /**
   * Owner preflight outside the decision transaction, after the replay fast path.
   * Returning SkippedProposalDecision ends the accept without a rate or signal.
   */
  prepare?(guardWrite: ProposalWriteGuard): Promise<TPrepared | SkippedProposalDecision<TResult>>;
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
  rating: ExistingRateDecision,
  userNote: string | undefined,
  rate: ProposalRateWrite = {},
  actor: ProposalDecisionActor = USER_DECISION_ACTOR,
): Promise<string> {
  const rateEventId = rate.id ?? newId();
  await writeEvent(tx, {
    id: rateEventId,
    actor_kind: actor.kind,
    actor_ref: actor.ref,
    action: 'rate',
    subject_kind: rate.subject?.kind ?? 'event',
    subject_id: rate.subject?.id ?? proposalId,
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
  const requestedRating: ExistingRateDecision = plan.rating ?? 'accept';
  // Learner decision signals feed the coach's acceptance-rate context. An agent
  // auto-apply is not a learner decision, so it must not move those counts; the
  // human inbox path (actor omitted) keeps recording exactly as before.
  const recordsLearnerSignal = plan.actor?.kind !== 'agent';
  const replayed = async (rate: RecordedProposalRate): Promise<ProposalAcceptRun<TResult>> => {
    if (recordsLearnerSignal) {
      await ensureProposalDecisionSignal(db, plan.proposal, 'accept', plan.userNote);
    }
    return { outcome: 'replayed', result: await plan.replay(rate) };
  };

  // Cheap short-circuit; the transaction re-checks under the decision lock.
  const recorded = await findExistingRateEvent(db, proposalId);
  if (recorded) {
    if (recorded.decision !== requestedRating) throw conflictWith(proposalId, recorded);
    return replayed(recorded);
  }

  const acceptable = (locked: LockedDecision): LockedDecision => {
    if (locked.status === 'decided' && locked.rate.decision !== requestedRating) {
      throw conflictWith(proposalId, locked.rate);
    }
    if (locked.status === 'corrected') throw correctedAccept(proposalId, locked.state);
    return locked;
  };

  const guardWrite: ProposalWriteGuard = async (tx) => {
    acceptable(await readDecisionUnderLock(tx, proposalId));
  };
  const prepared = plan.prepare ? await plan.prepare(guardWrite) : (undefined as TPrepared);
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
          return writeRateEvent(
            tx,
            proposalId,
            rate?.rating ?? requestedRating,
            plan.userNote,
            rate,
            plan.actor ?? USER_DECISION_ACTOR,
          );
        },
      },
      prepared,
    );
    if (rateWrites !== (outcome.status === 'accepted' ? 1 : 0)) {
      throw new Error(
        `accept effect for proposal ${proposalId} returned ${outcome.status} after ${rateWrites} rate writes`,
      );
    }
    if (outcome.status === 'accepted' && plan.signal === 'in_transaction' && recordsLearnerSignal) {
      await recordProposalDecisionSignal(tx, plan.proposal, 'accept', plan.userNote);
    }
    return outcome;
  });

  if (settled.status === 'decided') return replayed(settled.rate);
  if (settled.status === 'skipped') return { outcome: 'skipped', result: settled.result };
  if (plan.signal === 'after_commit' && recordsLearnerSignal) {
    await recordProposalDecisionSignal(db, plan.proposal, 'accept', plan.userNote);
  }
  return { outcome: 'accepted', result: settled.result };
}

export interface ProposalDismissPlan {
  readonly proposal: ProposalSignalSource;
  readonly userNote?: string;
  readonly signal: ProposalSignalTiming;
  /**
   * Event subject override for the dismiss rate; defaults to the proposal event
   * itself. knowledge_edge dismisses keep their RateKnowledgeEdge shape.
   */
  readonly rateSubject?: { readonly kind: string; readonly id: string };
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
    const rateEventId = await writeRateEvent(tx, proposalId, 'dismiss', plan.userNote, {
      subject: plan.rateSubject,
    });
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
