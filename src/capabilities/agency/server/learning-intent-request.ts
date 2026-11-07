// One paid outline dispatch for an in-flight learning-intent request.
//
// Identity is (topic, attempt), not topic alone. A known terminal receipt or a
// decided proposal opens the next attempt, so a later intent for the same words
// can still be created. sending/unknown never starts another provider call.
// Unknown cost stays on the attempt and is not retried to obtain a price.

import { and, eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import { newId } from '@/core/ids';
import type { PaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import { computePaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import { lockPaidEffectControlFamily } from '@/core/paid-work/server/paid-effect-control';
import {
  type PaidEffectSnapshot,
  admitPaidEffectIntent,
  claimPaidEffectSend,
  markPaidEffectUnknown,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  settleExpiredPaidEffectSends,
} from '@/core/paid-work/server/paid-effect-store';
import type { Db, Tx } from '@/db/client';
import { event, paid_effect } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { type ProposalInboxRow, listProposalInboxRows } from '@/kernel/proposals/inbox';
import { checkRateLimit, refundRateLimit } from '@/kernel/request-rate-limit';
import { LearningIntentProposalResponseSchema } from '../api/contracts';
import {
  type LearningIntentFailureFact,
  type LearningIntentProposal,
  type RunTaskFn,
  learningIntentFailureFact,
  planLearningIntent,
} from './learning-intent';

const FAMILY = 'learning_intent_outline';
const UNIT = 'outline';
/** Outlives one outline attempt (task timeout 120s) so a live call is not classed unknown mid-flight. */
const LEASE_MS = 150_000;
const POLL_MS = 250;
const JOIN_GRACE_MS = 2_000;

type ReceiptOutcome =
  | 'proposed'
  | 'outline_rejected'
  | 'proposal_failed'
  | 'provider_failed'
  | 'not_sent';

interface LearningIntentReceipt {
  readonly outcome: ReceiptOutcome;
  readonly request_id: string;
  readonly task_run_id: string | null;
  readonly proposal_id: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

interface TopicAttempt {
  readonly identity: PaidEffectIdentity;
  readonly state: string;
  readonly fence: number;
  readonly deliveryId: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly revision: string;
  readonly result: unknown;
  readonly unresolvedReason: string | null;
}

type SlotDecision =
  | {
      readonly kind: 'winner';
      readonly identity: PaidEffectIdentity;
      readonly fence: number;
      readonly deliveryId: string;
    }
  | { readonly kind: 'join'; readonly identity: PaidEffectIdentity };

const OPEN_RANK: Record<string, number> = {
  unknown: 0,
  sending: 1,
  receipt_ready: 2,
  pending: 3,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedIntentTopic(payload: ProposalInboxRow['payload']): string | null {
  if (payload.kind !== 'learning_item') return null;
  const topic = payload.proposed_change.topic;
  return typeof topic === 'string' && topic.length > 0 ? topic : null;
}

function attemptNumber(revision: string): number {
  return /^[1-9][0-9]*$/.test(revision) ? Number(revision) : 0;
}

function nextAttempt(rows: readonly TopicAttempt[]): number {
  return rows.reduce((max, row) => Math.max(max, attemptNumber(row.revision)), 0) + 1;
}

function pickOpen(rows: readonly TopicAttempt[]): TopicAttempt | null {
  let open: TopicAttempt | null = null;
  for (const row of rows) {
    const rank = OPEN_RANK[row.state];
    if (rank === undefined) continue;
    if (!open || rank < (OPEN_RANK[open.state] ?? Number.POSITIVE_INFINITY)) open = row;
  }
  return open;
}

function receiptFrom(value: unknown): LearningIntentReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const outcome = row.outcome;
  if (
    outcome !== 'proposed' &&
    outcome !== 'outline_rejected' &&
    outcome !== 'proposal_failed' &&
    outcome !== 'provider_failed' &&
    outcome !== 'not_sent'
  ) {
    return null;
  }
  const requestId = row.request_id;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  return {
    outcome,
    request_id: requestId,
    task_run_id: typeof row.task_run_id === 'string' ? row.task_run_id : null,
    proposal_id: typeof row.proposal_id === 'string' ? row.proposal_id : null,
    code: typeof row.code === 'string' ? row.code : null,
    message: typeof row.message === 'string' ? row.message : null,
  };
}

function taskRunFromReason(reason: string | null): string | null {
  if (!reason) return null;
  const match = /task_run_id=(\S+)/.exec(reason);
  return match?.[1] && match[1] !== 'none' ? match[1] : null;
}

function domainFromReason(reason: string | null): { code: string; outcome: string } | null {
  if (!reason) return null;
  const match = /^domain:([a-z_]+) code:([a-z0-9_]+)/.exec(reason);
  if (!match?.[1] || !match[2]) return null;
  return { outcome: match[1], code: match[2] };
}

function statusForCode(code: string): number {
  if (code === 'topic_not_found') return 422;
  if (code === 'proposal_failed') return 500;
  return 502;
}

function domainError(
  code: string,
  message: string,
  requestId: string | null,
  taskRunId: string | null,
  outcome: string,
): ApiError {
  return new ApiError(code, message, statusForCode(code), undefined, {
    request_id: requestId,
    task_run_id: taskRunId,
    outcome,
  });
}

function unknownError(
  requestId: string | null,
  taskRunId: string | null,
  reason: string | null,
): ApiError {
  const domain = domainFromReason(reason);
  if (domain) {
    return domainError(
      domain.code,
      'learning intent failed before a known-cost result was recorded',
      requestId,
      taskRunId ?? taskRunFromReason(reason),
      domain.outcome,
    );
  }
  return new ApiError(
    'learning_intent_result_unknown',
    'learning intent result is unknown and will not be dispatched again',
    409,
    undefined,
    {
      request_id: requestId,
      task_run_id: taskRunId ?? taskRunFromReason(reason),
      state: 'unknown',
    },
  );
}

async function loadTopicAttempts(db: Db | Tx, topic: string): Promise<TopicAttempt[]> {
  const stored = await db
    .select({
      family: paid_effect.family,
      entity_id: paid_effect.entity_id,
      entity_revision: paid_effect.entity_revision,
      unit: paid_effect.unit,
      input_digest: paid_effect.input_digest,
      state: paid_effect.state,
      fence: paid_effect.fence,
      delivery_id: paid_effect.delivery_id,
      send_lease_expires_at: paid_effect.send_lease_expires_at,
      result_json: paid_effect.result_json,
      unresolved_reason: paid_effect.unresolved_reason,
    })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, FAMILY),
        eq(paid_effect.entity_id, topic),
        eq(paid_effect.unit, UNIT),
      ),
    );
  return stored.map((row) => ({
    identity: {
      family: row.family,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      unit: row.unit,
      inputDigest: row.input_digest,
    },
    state: row.state,
    fence: row.fence,
    deliveryId: row.delivery_id,
    leaseExpiresAt: row.send_lease_expires_at,
    revision: row.entity_revision,
    result: row.result_json,
    unresolvedReason: row.unresolved_reason,
  }));
}

async function replayPendingLearningIntent(
  database: Db,
  topic: string,
): Promise<LearningIntentProposal | null> {
  const pending = await listProposalInboxRows(database, {
    status: 'pending',
    kind: 'learning_item',
  });
  for (const candidate of pending) {
    if (storedIntentTopic(candidate.payload) !== topic) continue;
    const restored = LearningIntentProposalResponseSchema.safeParse({
      proposal_id: candidate.id,
      ...candidate.payload.proposed_change,
    });
    if (restored.success) return restored.data;
  }
  return null;
}

async function proposedReceipt(
  db: Db | Tx,
  proposalId: string,
  requestId: string,
): Promise<LearningIntentReceipt> {
  const [row] = await db
    .select({ task_run_id: event.task_run_id })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  return {
    outcome: 'proposed',
    request_id: requestId,
    task_run_id: row?.task_run_id ?? null,
    proposal_id: proposalId,
    code: null,
    message: null,
  };
}

async function recordReceipt(
  db: Db,
  identity: PaidEffectIdentity,
  deliveryId: string,
  fence: number,
  receipt: LearningIntentReceipt,
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordPaidEffectResult(tx, identity, deliveryId, receipt, { fence });
    await recordPaidEffectApplication(tx, identity, receipt);
  });
}

async function healProposedReceipt(db: Db, topic: string, proposalId: string): Promise<void> {
  const rows = await loadTopicAttempts(db, topic);
  for (const row of rows) {
    if (row.state === 'applied' || row.state === 'cancelled' || row.state === 'voided') continue;
    if (row.state === 'pending' || !row.deliveryId) continue;
    const receipt = await proposedReceipt(db, proposalId, row.deliveryId);
    try {
      await recordReceipt(db, row.identity, row.deliveryId, row.fence, receipt);
    } catch (err) {
      console.error('[learning-intent] proposal receipt record failed', proposalId, err);
    }
  }
}

async function claimSlot(db: Db, topic: string): Promise<SlotDecision> {
  return db.transaction(async (tx) => {
    // The read and the claim share the family lock. Two creates that both saw an
    // empty slot would otherwise admit two attempts before either row existed.
    await lockPaidEffectControlFamily(tx, FAMILY);
    const rows = await loadTopicAttempts(tx, topic);
    const open = pickOpen(rows);
    if (open && open.state !== 'pending') return { kind: 'join', identity: open.identity };

    const deliveryId = newId();
    const delivery = {
      backend: 'pg-boss' as const,
      deliveryId,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    };
    const identity =
      open?.identity ??
      computePaidEffectIdentity({
        family: FAMILY,
        entityId: topic,
        entityRevision: String(nextAttempt(rows)),
        unit: UNIT,
        input: { topic },
      });
    if (!open) {
      const admitted = await admitPaidEffectIntent(tx, {
        family: FAMILY,
        entityId: topic,
        entityRevision: identity.entityRevision,
        unit: UNIT,
        input: { topic },
      });
      if (admitted.kind === 'existing' && admitted.state !== 'pending') {
        return { kind: 'join', identity };
      }
    }
    const claim = await claimPaidEffectSend(tx, identity, delivery);
    if (claim.kind !== 'claimed') return { kind: 'join', identity };
    return { kind: 'winner', identity, fence: claim.fence, deliveryId };
  });
}

async function applyStoredReceipt(db: Db, row: PaidEffectSnapshot): Promise<void> {
  if (row.state !== 'receipt_ready' || row.result == null) return;
  await db.transaction(async (tx) => {
    await recordPaidEffectApplication(tx, row.identity, row.result);
  });
}

async function waitForTerminal(
  db: Db,
  identity: PaidEffectIdentity,
  deadline: number,
): Promise<PaidEffectSnapshot> {
  for (;;) {
    const row = await readPaidEffect(db, identity);
    if (!row) {
      throw new ApiError('inconsistent_state', 'learning intent request disappeared', 500);
    }
    if (
      row.state === 'applied' ||
      row.state === 'unknown' ||
      row.state === 'voided' ||
      row.state === 'cancelled'
    ) {
      return row;
    }
    if (row.state === 'receipt_ready') {
      try {
        await applyStoredReceipt(db, row);
      } catch (err) {
        console.error('[learning-intent] receipt apply failed', row.identity.entityId, err);
        return row;
      }
      continue;
    }
    if (Date.now() >= deadline) return row;
    await delay(POLL_MS);
  }
}

async function answerSnapshot(
  db: Db,
  topic: string,
  row: PaidEffectSnapshot,
): Promise<LearningIntentProposal> {
  if (row.state === 'unknown' || row.state === 'voided') {
    throw unknownError(row.delivery.deliveryId, null, row.unresolvedReason);
  }
  const receipt = receiptFrom(row.state === 'applied' ? row.application : row.result);
  if (row.state === 'applied' && receipt?.outcome === 'proposed') {
    const replay = await replayPendingLearningIntent(db, topic);
    if (replay) return replay;
    throw new ApiError(
      'inconsistent_state',
      `proposal ${receipt.proposal_id ?? ''} is not a pending learning intent`,
      500,
      undefined,
      { request_id: receipt.request_id, task_run_id: receipt.task_run_id },
    );
  }
  if (row.state === 'applied' && receipt && receipt.outcome !== 'not_sent') {
    throw domainError(
      receipt.code ?? 'learning_intent_failed',
      receipt.message ?? 'learning intent failed',
      receipt.request_id,
      receipt.task_run_id,
      receipt.outcome,
    );
  }
  throw new ApiError(
    'learning_intent_in_flight',
    'learning intent request is still in flight',
    409,
    undefined,
    { request_id: row.delivery.deliveryId, state: row.state },
  );
}

async function joinAttempt(
  db: Db,
  topic: string,
  identity: PaidEffectIdentity,
): Promise<LearningIntentProposal> {
  const current = await readPaidEffect(db, identity);
  if (!current) {
    throw new ApiError('inconsistent_state', 'learning intent request disappeared', 500);
  }
  if (current.state === 'unknown' || current.state === 'voided') {
    throw unknownError(current.delivery.deliveryId, null, current.unresolvedReason);
  }
  const deadline = (current.sendLeaseExpiresAt?.getTime() ?? Date.now() + LEASE_MS) + JOIN_GRACE_MS;
  const finished = await waitForTerminal(db, identity, deadline);
  return answerSnapshot(db, topic, finished);
}

function failureReason(fact: LearningIntentFailureFact): string {
  return `domain:${fact.domainOutcome} code:${fact.code} task_run_id=${fact.taskRunId ?? 'none'}`;
}

function knownReceipt(fact: LearningIntentFailureFact, requestId: string): LearningIntentReceipt {
  return {
    outcome: fact.domainOutcome,
    request_id: requestId,
    task_run_id: fact.taskRunId,
    proposal_id: null,
    code: fact.code,
    message: fact.message.slice(0, 500),
  };
}

async function settleWinnerFailure(
  db: Db,
  won: Extract<SlotDecision, { kind: 'winner' }>,
  err: unknown,
  rateToken: number | undefined,
): Promise<never> {
  const fact = learningIntentFailureFact(err);
  if (!fact && !(err instanceof AgentRunError)) {
    if (rateToken !== undefined) refundRateLimit(rateToken);
    await recordReceipt(db, won.identity, won.deliveryId, won.fence, {
      outcome: 'not_sent',
      request_id: won.deliveryId,
      task_run_id: null,
      proposal_id: null,
      code: null,
      message: null,
    });
    throw err;
  }
  const unknownCost =
    (fact && fact.costBasis === 'unknown') ||
    (err instanceof AgentRunError && err.costUsd === undefined);
  if (unknownCost) {
    const reason = fact
      ? failureReason(fact)
      : `domain:provider_failed code:provider_failed task_run_id=${
          err instanceof AgentRunError ? err.taskRunId : 'none'
        }`;
    await db.transaction(async (tx) => {
      await markPaidEffectUnknown(tx, won.identity, won.deliveryId, reason, { fence: won.fence });
    });
    if (fact) {
      throw domainError(
        fact.code,
        fact.message,
        won.deliveryId,
        fact.taskRunId,
        fact.domainOutcome,
      );
    }
    throw unknownError(won.deliveryId, err instanceof AgentRunError ? err.taskRunId : null, reason);
  }
  if (fact) {
    await recordReceipt(
      db,
      won.identity,
      won.deliveryId,
      won.fence,
      knownReceipt(fact, won.deliveryId),
    );
    throw domainError(fact.code, fact.message, won.deliveryId, fact.taskRunId, fact.domainOutcome);
  }
  const taskRunId = err instanceof AgentRunError ? err.taskRunId : null;
  await recordReceipt(db, won.identity, won.deliveryId, won.fence, {
    outcome: 'provider_failed',
    request_id: won.deliveryId,
    task_run_id: taskRunId,
    proposal_id: null,
    code: 'provider_failed',
    message: 'provider attempt failed',
  });
  throw domainError(
    'provider_failed',
    'provider attempt failed',
    won.deliveryId,
    taskRunId,
    'provider_failed',
  );
}

async function dispatchWinner(
  db: Db,
  topic: string,
  runTaskFn: RunTaskFn,
  won: Extract<SlotDecision, { kind: 'winner' }>,
): Promise<LearningIntentProposal> {
  let rateToken: number | undefined;
  try {
    rateToken = checkRateLimit();
    const proposal = await planLearningIntent({ db, topic, runTaskFn });
    try {
      const receipt = await proposedReceipt(db, proposal.proposal_id, won.deliveryId);
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, receipt);
    } catch (err) {
      console.error('[learning-intent] proposal receipt record failed', proposal.proposal_id, err);
    }
    return proposal;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'rate_limited') {
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, {
        outcome: 'not_sent',
        request_id: won.deliveryId,
        task_run_id: null,
        proposal_id: null,
        code: null,
        message: null,
      });
      throw err;
    }
    return settleWinnerFailure(db, won, err, rateToken);
  }
}

/** Pending same-topic replay, else one in-flight dispatch joined by concurrent retries. */
export async function runLearningIntentRequest(
  database: Db,
  topic: string,
  runTaskFn: RunTaskFn,
): Promise<LearningIntentProposal> {
  const replay = await replayPendingLearningIntent(database, topic);
  if (replay) {
    await healProposedReceipt(database, topic, replay.proposal_id);
    return replay;
  }
  await settleExpiredPaidEffectSends(database, { family: FAMILY });
  const slot = await claimSlot(database, topic);
  if (slot.kind === 'join') return joinAttempt(database, topic, slot.identity);
  return dispatchWinner(database, topic, runTaskFn, slot);
}
