// One paid outline dispatch for an in-flight learning-intent request.
//
// Identity is (topic, attempt). A live send is joined. A known domain result,
// including unknown cost, is a terminal receipt and is not retried to obtain a
// price. A send whose result is still unknown (lease ended, no proposal) stays
// unresolved and is not dispatched again. A decided proposal seals that receipt
// and may open a later attempt. Accept, dismiss, and retract seal the create
// receipt so a later decision cannot leave the topic pinned on `unknown`.

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
  /** True when the provider attempt finished without a trustworthy price. The attempt is still terminal. */
  readonly cost_unknown: boolean;
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
  | { readonly kind: 'join'; readonly identity: PaidEffectIdentity }
  | { readonly kind: 'closed_known'; readonly receipt: LearningIntentReceipt }
  | { readonly kind: 'unresolved' };

/**
 * Open slot of one outline attempt. Closed rows (applied / voided / cancelled) are absent.
 * `unresolved` is an admitted send with no result. It is not a claim and cannot become `winner`.
 */
type OpenAttempt =
  | { readonly kind: 'unsent'; readonly row: TopicAttempt }
  | { readonly kind: 'in_flight'; readonly row: TopicAttempt }
  | { readonly kind: 'unresolved'; readonly row: TopicAttempt }
  | { readonly kind: 'receipt'; readonly row: TopicAttempt };

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

function leaseEnded(row: TopicAttempt, now: number): boolean {
  return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() <= now;
}

function classifyAttempt(row: TopicAttempt, now: number): OpenAttempt | null {
  switch (row.state) {
    case 'pending':
      return { kind: 'unsent', row };
    case 'sending':
      return leaseEnded(row, now) ? { kind: 'unresolved', row } : { kind: 'in_flight', row };
    case 'unknown':
      return { kind: 'unresolved', row };
    case 'receipt_ready':
      return { kind: 'receipt', row };
    default:
      return null;
  }
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
    cost_unknown: row.cost_unknown === true,
  };
}

function taskRunFromReason(reason: string | null): string | null {
  if (!reason) return null;
  const match = /task_run_id=(\S+)/.exec(reason);
  return match?.[1] && match[1] !== 'none' ? match[1] : null;
}

function domainFromReason(reason: string | null): { code: string; outcome: ReceiptOutcome } | null {
  if (!reason) return null;
  const match = /^domain:([a-z_]+) code:([a-z0-9_]+)/.exec(reason);
  const outcome = match?.[1];
  const code = match?.[2];
  if (
    !outcome ||
    !code ||
    (outcome !== 'outline_rejected' &&
      outcome !== 'proposal_failed' &&
      outcome !== 'provider_failed')
  ) {
    return null;
  }
  return { outcome, code };
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
    cost_unknown: false,
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

async function writeReceipt(
  tx: Tx,
  row: TopicAttempt,
  receipt: LearningIntentReceipt,
): Promise<void> {
  if (!row.deliveryId) return;
  await recordPaidEffectResult(tx, row.identity, row.deliveryId, receipt, { fence: row.fence });
  await recordPaidEffectApplication(tx, row.identity, receipt);
}

async function sealOutlineReceipt(tx: Tx, topic: string, proposalId: string): Promise<void> {
  const now = Date.now();
  for (const row of await loadTopicAttempts(tx, topic)) {
    const open = classifyAttempt(row, now);
    if (!open || open.kind === 'unsent' || !row.deliveryId) continue;
    await writeReceipt(tx, row, await proposedReceipt(tx, proposalId, row.deliveryId));
  }
}

/** Close a create receipt once the proposal exists. Failures are logged; the decision already stands. */
export async function sealLearningIntentOutlineReceipt(
  db: Db,
  topic: string,
  proposalId: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, FAMILY);
      await sealOutlineReceipt(tx, topic, proposalId);
    });
  } catch (err) {
    console.error('[learning-intent] outline receipt seal failed', proposalId, err);
  }
}

/** Same seal inside the caller's transaction (retract already holds the decision lock). */
export async function sealLearningIntentOutlineReceiptTx(
  tx: Tx,
  topic: string,
  proposalId: string,
): Promise<void> {
  await lockPaidEffectControlFamily(tx, FAMILY);
  await sealOutlineReceipt(tx, topic, proposalId);
}

export function learningIntentTopic(payload: {
  readonly kind: string;
  readonly proposed_change: unknown;
}): string | null {
  if (
    payload.kind !== 'learning_item' ||
    !payload.proposed_change ||
    typeof payload.proposed_change !== 'object'
  ) {
    return null;
  }
  const topic = (payload.proposed_change as { topic?: unknown }).topic;
  return typeof topic === 'string' && topic.length > 0 ? topic : null;
}

async function newestDecidedIntent(db: Db | Tx, topic: string): Promise<string | null> {
  let newest: { id: string; at: number } | null = null;
  for (const status of ['accepted', 'dismissed', 'stale'] as const) {
    const rows = await listProposalInboxRows(db, { status, kind: 'learning_item' });
    for (const row of rows) {
      if (storedIntentTopic(row.payload) !== topic) continue;
      const at = row.proposed_at.getTime();
      if (!newest || at > newest.at) newest = { id: row.id, at };
    }
  }
  return newest?.id ?? null;
}

function freshInput(topic: string, rows: readonly TopicAttempt[]) {
  return {
    family: FAMILY,
    entityId: topic,
    entityRevision: String(nextAttempt(rows)),
    unit: UNIT,
    input: { topic },
  };
}

async function claimDelivery(
  tx: Tx,
  identity: PaidEffectIdentity,
  deliveryId: string,
): Promise<SlotDecision> {
  const claim = await claimPaidEffectSend(tx, identity, {
    backend: 'pg-boss',
    deliveryId,
    leaseExpiresAt: new Date(Date.now() + LEASE_MS),
  });
  if (claim.kind !== 'claimed') return { kind: 'join', identity };
  return { kind: 'winner', identity, fence: claim.fence, deliveryId };
}

async function admitFresh(
  tx: Tx,
  topic: string,
  rows: readonly TopicAttempt[],
): Promise<SlotDecision> {
  const deliveryId = newId();
  const input = freshInput(topic, rows);
  const identity = computePaidEffectIdentity(input);
  const admitted = await admitPaidEffectIntent(tx, input);
  if (admitted.kind === 'existing' && admitted.state !== 'pending') {
    return { kind: 'join', identity };
  }
  return claimDelivery(tx, identity, deliveryId);
}

async function resolveUnresolvedAttempt(
  tx: Tx,
  topic: string,
  rows: readonly TopicAttempt[],
  unresolved: TopicAttempt,
): Promise<SlotDecision> {
  const decided = await newestDecidedIntent(tx, topic);
  if (decided && unresolved.deliveryId) {
    await writeReceipt(tx, unresolved, await proposedReceipt(tx, decided, unresolved.deliveryId));
    return admitFresh(tx, topic, rows);
  }
  const domain = domainFromReason(unresolved.unresolvedReason);
  if (domain && unresolved.deliveryId) {
    const receipt: LearningIntentReceipt = {
      outcome: domain.outcome,
      request_id: unresolved.deliveryId,
      task_run_id: taskRunFromReason(unresolved.unresolvedReason),
      proposal_id: null,
      code: domain.code,
      message: null,
      cost_unknown: true,
    };
    await writeReceipt(tx, unresolved, receipt);
    return { kind: 'closed_known', receipt };
  }
  return { kind: 'unresolved' };
}

async function claimSlot(db: Db, topic: string): Promise<SlotDecision> {
  return db.transaction(async (tx) => {
    // The read and the claim share the family lock. Two creates that both saw an
    // empty slot would otherwise admit two attempts before either row existed.
    await lockPaidEffectControlFamily(tx, FAMILY);
    const now = Date.now();
    const rows = await loadTopicAttempts(tx, topic);
    const open = rows
      .map((row) => classifyAttempt(row, now))
      .filter((row): row is OpenAttempt => row !== null);
    const inFlight = open.find((row) => row.kind === 'in_flight');
    if (inFlight) return { kind: 'join', identity: inFlight.row.identity };
    const unresolved = open.find((row) => row.kind === 'unresolved');
    if (unresolved) return resolveUnresolvedAttempt(tx, topic, rows, unresolved.row);
    const receipt = open.find((row) => row.kind === 'receipt');
    if (receipt) return { kind: 'join', identity: receipt.row.identity };
    const unsent = open.find((row) => row.kind === 'unsent');
    if (unsent) return claimDelivery(tx, unsent.row.identity, newId());
    return admitFresh(tx, topic, rows);
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

type JoinOutcome =
  | { readonly kind: 'proposal'; readonly proposal: LearningIntentProposal }
  | { readonly kind: 'retry' }
  | { readonly kind: 'unresolved' };

async function answerSnapshot(
  db: Db,
  topic: string,
  row: PaidEffectSnapshot,
): Promise<JoinOutcome> {
  if (row.state === 'unknown') return { kind: 'unresolved' };
  if (row.state === 'voided' || row.state === 'cancelled') return { kind: 'retry' };
  const receipt = receiptFrom(row.state === 'applied' ? row.application : row.result);
  if (row.state === 'applied' && receipt?.outcome === 'not_sent') return { kind: 'retry' };
  if (row.state === 'applied' && receipt?.outcome === 'proposed') {
    const replay = await replayPendingLearningIntent(db, topic);
    if (replay) return { kind: 'proposal', proposal: replay };
    throw new ApiError(
      'inconsistent_state',
      `proposal ${receipt.proposal_id ?? ''} is not a pending learning intent`,
      500,
      undefined,
      { request_id: receipt.request_id, task_run_id: receipt.task_run_id },
    );
  }
  if (row.state === 'applied' && receipt) {
    throw domainError(
      receipt.code ?? 'learning_intent_failed',
      receipt.message ?? 'learning intent failed',
      receipt.request_id,
      receipt.task_run_id,
      receipt.outcome,
    );
  }
  if (
    row.state === 'sending' &&
    row.sendLeaseExpiresAt &&
    row.sendLeaseExpiresAt.getTime() <= Date.now()
  ) {
    return { kind: 'unresolved' };
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
): Promise<JoinOutcome> {
  const current = await readPaidEffect(db, identity);
  if (!current) {
    throw new ApiError('inconsistent_state', 'learning intent request disappeared', 500);
  }
  if (current.state === 'unknown') return { kind: 'unresolved' };
  if (current.state === 'voided' || current.state === 'cancelled') return { kind: 'retry' };
  const deadline = (current.sendLeaseExpiresAt?.getTime() ?? Date.now() + LEASE_MS) + JOIN_GRACE_MS;
  const finished = await waitForTerminal(db, identity, deadline);
  return answerSnapshot(db, topic, finished);
}

function knownReceipt(fact: LearningIntentFailureFact, requestId: string): LearningIntentReceipt {
  return {
    outcome: fact.domainOutcome,
    request_id: requestId,
    task_run_id: fact.taskRunId,
    proposal_id: null,
    code: fact.code,
    message: fact.message.slice(0, 500),
    cost_unknown: fact.costBasis === 'unknown',
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
      cost_unknown: false,
    });
    throw err;
  }
  // Unknown cost is still a known domain outcome: record it and stop. A later
  // create is a new attempt; this one is not dispatched again to discover a price.
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
    cost_unknown: err instanceof AgentRunError && err.costUsd === undefined,
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
        cost_unknown: false,
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
    await sealLearningIntentOutlineReceipt(database, topic, replay.proposal_id);
    return replay;
  }
  await settleExpiredPaidEffectSends(database, { family: FAMILY });
  for (let step = 0; step < 4; step += 1) {
    const slot = await claimSlot(database, topic);
    if (slot.kind === 'unresolved') break;
    if (slot.kind === 'closed_known') {
      throw domainError(
        slot.receipt.code ?? 'learning_intent_failed',
        slot.receipt.message ?? 'learning intent failed',
        slot.receipt.request_id,
        slot.receipt.task_run_id,
        slot.receipt.outcome,
      );
    }
    if (slot.kind === 'winner') return dispatchWinner(database, topic, runTaskFn, slot);
    const joined = await joinAttempt(database, topic, slot.identity);
    if (joined.kind === 'proposal') return joined.proposal;
    if (joined.kind === 'unresolved') break;
  }
  throw new ApiError(
    'learning_intent_in_flight',
    'learning intent request is still in flight',
    409,
  );
}
