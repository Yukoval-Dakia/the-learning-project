// One paid goal-scope dispatch for an in-flight goal-intent request.
//
// Sibling of learning-intent-request.ts: the learner's words resolve to a
// North-Star goal here, not an atomic learning-item plan. The paid-effect seam
// is the same protocol (admit → claim → send → receipt), but the family is
// `goal_scope_propose` so a goal request never collides with an atomic outline
// request on the same words, and the producer is the canonical
// `runGoalScopeAndWrite` — never LearningIntentOutlineTask.
//
// Identity is (parsed goal topic, attempt). A pending same-topic goal_scope
// proposal is the paid outcome and is replayed rather than repurchased. A send
// whose result is still unknown stays unresolved and is not dispatched again.
// Accept / dismiss / retract seal the create receipt for the attempt that
// produced the proposal.

import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { AgentRunError } from '@/ai/agent-run-error';
import { TaskConfigError } from '@/server/ai/providers';
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
import { resolveSubjectProfile } from '@/subjects/profile';
import { produceGoalScope } from './goals/scope';
import type { RunTaskFn } from './learning-intent';
import { normalizeLearningIntentTopic } from './learning-intent-reuse';

const FAMILY = 'goal_scope_propose';
const UNIT = 'scope';
const LEASE_MS = 150_000;
const POLL_MS = 250;
const JOIN_GRACE_MS = 2_000;

/**
 * Deterministic ai_task_runs PK bound to one paid delivery. The winner passes it
 * to the producer, the runner honors it on attempt 1, and `writeAiProposal`
 * stamps it as the proposal event's `task_run_id` — so a proposal's
 * `task_run_id` back-references the exact delivery that produced it. This is the
 * ownership proof `sealGoalReceipt` needs: an attempt is only sealed by the
 * proposal its own send actually wrote.
 */
function goalScopeTaskRunIdForDelivery(deliveryId: string): string {
  const digest = createHash('sha256').update(deliveryId).digest('hex').slice(0, 32);
  return `goal_scope_task_run_${digest}`;
}

type ReceiptOutcome = 'proposed' | 'provider_failed' | 'not_sent';

interface GoalScopeReceipt {
  readonly outcome: ReceiptOutcome;
  readonly request_id: string;
  readonly task_run_id: string | null;
  readonly proposal_id: string | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly cost_unknown: boolean;
}

interface TopicAttempt {
  readonly identity: PaidEffectIdentity;
  readonly state: string;
  readonly fence: number;
  readonly deliveryId: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly revision: string;
  readonly startedAt: Date;
  readonly result: unknown;
  readonly unresolvedReason: string | null;
}

export interface GoalIntentProposal {
  readonly kind: 'goal_scope';
  readonly proposal_id: string;
  readonly goal_id: string;
  readonly scope_count: number;
}

type OpenAttempt =
  | { readonly kind: 'unsent'; readonly row: TopicAttempt }
  | { readonly kind: 'in_flight'; readonly row: TopicAttempt }
  | { readonly kind: 'unresolved'; readonly row: TopicAttempt }
  | { readonly kind: 'receipt'; readonly row: TopicAttempt };

type SlotDecision =
  | {
      readonly kind: 'winner';
      readonly identity: PaidEffectIdentity;
      readonly fence: number;
      readonly deliveryId: string;
    }
  | { readonly kind: 'join'; readonly identity: PaidEffectIdentity }
  | { readonly kind: 'closed_known'; readonly receipt: GoalScopeReceipt }
  | { readonly kind: 'replay'; readonly proposal: GoalIntentProposal }
  | { readonly kind: 'unresolved' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function receiptFrom(value: unknown): GoalScopeReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const outcome = row.outcome;
  if (outcome !== 'proposed' && outcome !== 'provider_failed' && outcome !== 'not_sent') {
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

function storedGoalTopic(payload: ProposalInboxRow['payload']): string | null {
  return goalIntentTopic(payload);
}

/** The paid-intent key off a goal_scope payload (verbatim words, else title). */
export function goalIntentTopic(payload: {
  readonly kind: string;
  readonly proposed_change: unknown;
}): string | null {
  if (
    payload.kind !== 'goal_scope' ||
    !payload.proposed_change ||
    typeof payload.proposed_change !== 'object'
  ) {
    return null;
  }
  const change = payload.proposed_change as { learner_words?: unknown; title?: unknown };
  const words = typeof change.learner_words === 'string' ? change.learner_words : change.title;
  return typeof words === 'string' && words.length > 0
    ? normalizeLearningIntentTopic(words)
    : null;
}

async function loadTopicAttempts(db: Db | Tx, topic: string): Promise<TopicAttempt[]> {
  const topicKey = normalizeLearningIntentTopic(topic);
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
      created_at: paid_effect.created_at,
      result_json: paid_effect.result_json,
      unresolved_reason: paid_effect.unresolved_reason,
    })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, FAMILY),
        eq(paid_effect.entity_id, topicKey),
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
    startedAt: row.created_at,
    result: row.result_json,
    unresolvedReason: row.unresolved_reason,
  }));
}

/** A pending goal_scope proposal for this topic is the create's paid outcome. */
async function replayPendingGoalIntent(
  db: Db | Tx,
  topic: string,
  notBefore?: Date,
): Promise<GoalIntentProposal | null> {
  const pending = await listProposalInboxRows(db, { status: 'pending', kind: 'goal_scope' });
  const topicKey = normalizeLearningIntentTopic(topic);
  for (const candidate of pending) {
    if (storedGoalTopic(candidate.payload) !== topicKey) continue;
    if (notBefore && candidate.proposed_at.getTime() < notBefore.getTime()) continue;
    const goalId = candidate.target.subject_id;
    if (!goalId) continue;
    const scope = candidate.payload.proposed_change.scope_knowledge_ids;
    return {
      kind: 'goal_scope',
      proposal_id: candidate.id,
      goal_id: goalId,
      scope_count: Array.isArray(scope) ? scope.length : 0,
    };
  }
  return null;
}

async function proposedReceipt(
  db: Db | Tx,
  proposalId: string,
  requestId: string,
): Promise<GoalScopeReceipt> {
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

async function writeReceipt(tx: Tx, row: TopicAttempt, receipt: GoalScopeReceipt): Promise<void> {
  if (!row.deliveryId) return;
  await recordPaidEffectResult(tx, row.identity, row.deliveryId, receipt, { fence: row.fence });
  await recordPaidEffectApplication(tx, row.identity, receipt);
}

async function recordReceipt(
  db: Db,
  identity: PaidEffectIdentity,
  deliveryId: string,
  fence: number,
  receipt: GoalScopeReceipt,
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordPaidEffectResult(tx, identity, deliveryId, receipt, { fence });
    await recordPaidEffectApplication(tx, identity, receipt);
  });
}

/**
 * The proposal event's `task_run_id`. When the producer was dispatched through
 * this seam, that id is `goalScopeTaskRunIdForDelivery(deliveryId)` of the send
 * that wrote it — the ownership proof binding a proposal to the attempt that
 * actually produced it.
 */
async function proposalTaskRunId(tx: Tx, proposalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ task_run_id: event.task_run_id })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  return typeof row?.task_run_id === 'string' ? row.task_run_id : null;
}

async function sealGoalReceipt(tx: Tx, topic: string, proposalId: string): Promise<void> {
  const now = Date.now();
  const proposalRunId = await proposalTaskRunId(tx, proposalId);
  for (const row of await loadTopicAttempts(tx, topic)) {
    const open = classifyAttempt(row, now);
    if (!open || open.kind === 'unsent' || !row.deliveryId) continue;
    // Ownership proof: seal ONLY the attempt whose delivery-derived task_run_id
    // matches this proposal's stamped task_run_id. A later proposal (from the
    // nightly or another producer sharing the title) whose task_run_id does not
    // match any live delivery cannot seal an open attempt — it stays unknown
    // rather than being mis-attributed and releasing the duplicate-send gate.
    if (proposalRunId === null) continue;
    if (goalScopeTaskRunIdForDelivery(row.deliveryId) !== proposalRunId) continue;
    await writeReceipt(tx, row, await proposedReceipt(tx, proposalId, row.deliveryId));
  }
}

/** Close a create receipt once the proposal exists. Failures are logged; the decision stands. */
export async function sealGoalScopeReceipt(
  db: Db,
  topic: string,
  proposalId: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, FAMILY);
      await sealGoalReceipt(tx, topic, proposalId);
    });
  } catch (err) {
    console.error('[goal-intent] receipt seal failed', proposalId, err);
  }
}

/** Same seal inside the caller's transaction (retract already holds the decision lock). */
export async function sealGoalScopeReceiptTx(
  tx: Tx,
  topic: string,
  proposalId: string,
): Promise<void> {
  await lockPaidEffectControlFamily(tx, FAMILY);
  await sealGoalReceipt(tx, topic, proposalId);
}

async function sealPendingProposal(
  database: Db,
  topic: string,
): Promise<GoalIntentProposal | null> {
  const pending = await replayPendingGoalIntent(database, topic);
  if (!pending) return null;
  await sealGoalScopeReceipt(database, topic, pending.proposal_id);
  return pending;
}

/** A decision closes an attempt only when the proposal was born while that send was open. */
async function decisionForAttempt(
  db: Db | Tx,
  topic: string,
  attempt: TopicAttempt,
): Promise<{ kind: 'this_attempt'; proposalId: string } | { kind: 'none' }> {
  const started = attempt.startedAt.getTime();
  let match: { id: string; at: number } | null = null;
  for (const status of ['accepted', 'dismissed', 'stale'] as const) {
    const rows = await listProposalInboxRows(db, { status, kind: 'goal_scope' });
    for (const row of rows) {
      if (storedGoalTopic(row.payload) !== topic) continue;
      const at = row.proposed_at.getTime();
      if (at < started) continue;
      if (!match || at > match.at) match = { id: row.id, at };
    }
  }
  return match ? { kind: 'this_attempt', proposalId: match.id } : { kind: 'none' };
}

function freshInput(topic: string, rows: readonly TopicAttempt[]) {
  const topicKey = normalizeLearningIntentTopic(topic);
  return {
    family: FAMILY,
    entityId: topicKey,
    entityRevision: String(nextAttempt(rows)),
    unit: UNIT,
    input: { topic: topicKey },
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

async function sealUnresolvedToPending(
  tx: Tx,
  topic: string,
  unresolved: TopicAttempt,
): Promise<Extract<SlotDecision, { kind: 'replay' }> | null> {
  const pending = await replayPendingGoalIntent(tx, topic, unresolved.startedAt);
  if (!pending) return null;
  // Recover an unresolved send only against a proposal it provably produced —
  // the proposal's task_run_id must be this delivery's derived id. A pending
  // proposal from another producer sharing the title cannot recover this
  // attempt; it stays unknown rather than being mis-attributed.
  if (unresolved.deliveryId) {
    const runId = await proposalTaskRunId(tx, pending.proposal_id);
    if (runId !== goalScopeTaskRunIdForDelivery(unresolved.deliveryId)) return null;
    await writeReceipt(
      tx,
      unresolved,
      await proposedReceipt(tx, pending.proposal_id, unresolved.deliveryId),
    );
  }
  return { kind: 'replay', proposal: pending };
}

async function resolveUnresolvedAttempt(
  tx: Tx,
  topic: string,
  rows: readonly TopicAttempt[],
  unresolved: TopicAttempt,
): Promise<SlotDecision> {
  const landed = await sealUnresolvedToPending(tx, topic, unresolved);
  if (landed) return landed;
  const decision = await decisionForAttempt(tx, topic, unresolved);
  if (decision.kind === 'this_attempt' && unresolved.deliveryId) {
    // Same ownership proof before sealing: the decision's proposal must be the
    // one this delivery's send wrote, else it cannot close this attempt.
    const runId = await proposalTaskRunId(tx, decision.proposalId);
    if (runId === goalScopeTaskRunIdForDelivery(unresolved.deliveryId)) {
      await writeReceipt(
        tx,
        unresolved,
        await proposedReceipt(tx, decision.proposalId, unresolved.deliveryId),
      );
      return admitFresh(tx, topic, rows);
    }
  }
  return { kind: 'unresolved' };
}

async function claimSlot(db: Db, topic: string): Promise<SlotDecision> {
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, FAMILY);
    // Reconcile under the same admission serialization as the claim: a concurrent
    // first request may have finished its send and written a pending proposal
    // after our caller's own earlier no-pending read. Replay that outcome inside
    // the family lock instead of admitting a fresh paid revision for the same
    // words. This is the C2 fix — the initial pending check is outside the
    // admission transaction, so only this locked re-read closes the interleaving.
    const pending = await replayPendingGoalIntent(tx, topic);
    if (pending) return { kind: 'replay', proposal: pending };
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
      throw new ApiError('inconsistent_state', 'goal intent request disappeared', 500);
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
        console.error('[goal-intent] receipt apply failed', row.identity.entityId, err);
        return row;
      }
      continue;
    }
    if (Date.now() >= deadline) return row;
    await delay(POLL_MS);
  }
}

type JoinOutcome =
  | { readonly kind: 'proposal'; readonly proposal: GoalIntentProposal }
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
    const replay = await replayPendingGoalIntent(db, topic);
    if (replay) return { kind: 'proposal', proposal: replay };
    throw new ApiError(
      'inconsistent_state',
      `proposal ${receipt.proposal_id ?? ''} is not a pending goal intent`,
      500,
    );
  }
  if (row.state === 'applied' && receipt) {
    throw new ApiError(
      receipt.code ?? 'provider_failed',
      receipt.message ?? 'goal intent failed',
      502,
      undefined,
      {
        request_id: receipt.request_id,
        task_run_id: receipt.task_run_id,
        outcome: receipt.outcome,
      },
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
    'goal_intent_in_flight',
    'goal intent request is still in flight',
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
    throw new ApiError('inconsistent_state', 'goal intent request disappeared', 500);
  }
  if (current.state === 'unknown') return { kind: 'unresolved' };
  if (current.state === 'voided' || current.state === 'cancelled') return { kind: 'retry' };
  const deadline =
    (current.sendLeaseExpiresAt?.getTime() ?? Date.now() + LEASE_MS) + JOIN_GRACE_MS;
  const finished = await waitForTerminal(db, identity, deadline);
  return answerSnapshot(db, topic, finished);
}

type OutlineFailure =
  | { readonly kind: 'not_sent'; readonly error: unknown }
  | { readonly kind: 'known'; readonly receipt: GoalScopeReceipt; readonly error: ApiError }
  | { readonly kind: 'post_send_unknown'; readonly error: unknown }
  | { readonly kind: 'unresolved'; readonly reason: string };

/**
 * Classify a producer fault for the paid seam by error identity, not by an
 * attempt flag — the attempt marker only bounds whether `runTaskFn` was invoked
 * / returned, it cannot prove the provider was charged.
 *
 *  - TaskConfigError: pre-send config fault (unknown provider, non-executable
 *    pair, missing credential) thrown during task-config resolution, before any
 *    durable start or provider send → not_sent.
 *  - AgentRunError subtype provider_admission: control-plane/lease fault with an
 *    admission row. It can occur after durable start / provider execution, so it
 *    cannot prove the send never reached the provider → unresolved (fail-closed,
 *    never repurchased), not not_sent.
 *  - AgentRunError stream_no_terminal / api_error_result(null): provider outcome
 *    genuinely unknown → unknown (recoverable, never repurchased).
 *  - AgentRunError other subtype: known provider failure → provider_failed.
 *  - Other Error thrown after the model call returned (callReturned=true): the
 *    parse/proposal-write failed post-send → post_send_unknown.
 *  - Other Error before/inside the call (no post-call output): not_sent.
 */
function classifyOutlineFailure(
  err: unknown,
  requestId: string,
  callReturned: boolean,
): OutlineFailure {
  if (err instanceof TaskConfigError) return { kind: 'not_sent', error: err };
  if (!(err instanceof AgentRunError)) {
    // A non-AgentRunError: only a fault after the model produced output counts
    // as post-send. Inside the runTaskFn call it is a startup/admission fault
    // that never confirmed a provider charge → not_sent.
    return callReturned
      ? { kind: 'post_send_unknown', error: err }
      : { kind: 'not_sent', error: err };
  }
  if (
    err.subtype === 'provider_admission' ||
    err.subtype === 'stream_no_terminal' ||
    (err.subtype === 'api_error_result' && err.apiErrorStatus === null)
  ) {
    return { kind: 'unresolved', reason: err.subtype };
  }
  const receipt: GoalScopeReceipt = {
    outcome: 'provider_failed',
    request_id: requestId,
    task_run_id: err.taskRunId,
    proposal_id: null,
    code: 'provider_failed',
    message: 'provider attempt failed',
    cost_unknown: err.costUsd === undefined,
  };
  return {
    kind: 'known',
    receipt,
    error: new ApiError('provider_failed', 'provider attempt failed', 502, undefined, {
      request_id: requestId,
      task_run_id: err.taskRunId,
      outcome: 'provider_failed',
    }),
  };
}

const NOT_SENT_RECEIPT = (requestId: string): GoalScopeReceipt => ({
  outcome: 'not_sent',
  request_id: requestId,
  task_run_id: null,
  proposal_id: null,
  code: null,
  message: null,
  cost_unknown: false,
});

async function settleWinnerFailure(
  db: Db,
  won: Extract<SlotDecision, { kind: 'winner' }>,
  err: unknown,
  rateToken: number | undefined,
  callReturned: boolean,
): Promise<never> {
  const failure = classifyOutlineFailure(err, won.deliveryId, callReturned);
  switch (failure.kind) {
    case 'not_sent':
      if (rateToken !== undefined) refundRateLimit(rateToken);
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, NOT_SENT_RECEIPT(won.deliveryId));
      throw failure.error;
    case 'post_send_unknown':
      // Provider was paid but the post-send write failed before we could learn
      // the outcome. Mark unknown — recoverable via the unresolved path, never
      // repurchased as a fresh send.
      await db.transaction(async (tx) => {
        await lockPaidEffectControlFamily(tx, FAMILY);
        await markPaidEffectUnknown(tx, won.identity, won.deliveryId, 'post_send_write_failed', {
          fence: won.fence,
        });
      });
      throw new ApiError(
        'goal_intent_in_flight',
        'goal intent request is still in flight',
        409,
        undefined,
        { request_id: won.deliveryId, state: 'unknown' },
      );
    case 'known':
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, failure.receipt);
      throw failure.error;
    case 'unresolved':
      await db.transaction(async (tx) => {
        await lockPaidEffectControlFamily(tx, FAMILY);
        await markPaidEffectUnknown(tx, won.identity, won.deliveryId, failure.reason, {
          fence: won.fence,
        });
      });
      throw new ApiError(
        'goal_intent_in_flight',
        'goal intent request is still in flight',
        409,
        undefined,
        { request_id: won.deliveryId, state: 'unknown' },
      );
  }
}

async function dispatchWinner(
  db: Db,
  words: string,
  goalTitle: string,
  subjectId: string | null,
  runTaskFn: RunTaskFn,
  won: Extract<SlotDecision, { kind: 'winner' }>,
): Promise<GoalIntentProposal> {
  let rateToken: number | undefined;
  let result: Awaited<ReturnType<typeof produceGoalScope>>;
  // `returned` is set only once the model call resolves, so a post-call parse /
  // proposal-write fault is distinguishable from a pre-send config/admission
  // fault. It bounds the call site, never proves a provider charge.
  const attempt = { started: false, returned: false };
  try {
    rateToken = checkRateLimit();
    result = await produceGoalScope({
      db,
      goalTitle,
      learnerWords: words,
      subjectId,
      runTaskFn,
      subjectProfile: resolveSubjectProfile(subjectId),
      // Bind the produced proposal to THIS delivery: the runner honors
      // taskRunId on attempt 1, and writeAiProposal stamps it on the proposal
      // event, so sealGoalReceipt can prove which send wrote which proposal.
      taskRunId: goalScopeTaskRunIdForDelivery(won.deliveryId),
      __attempt: attempt,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'rate_limited') {
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, NOT_SENT_RECEIPT(won.deliveryId));
      throw err;
    }
    return settleWinnerFailure(db, won, err, rateToken, attempt.returned);
  }

  // The producer call is past the paid seam: classify its outcome and close
  // the attempt receipt. Because produceGoalScope throws, an !ok result only
  // surfaces as a thrown error above; here result.ok is always true.
  try {
    if (!result.proposal_id || !result.goal_id) {
      // Benign cold-start no-op (empty/!prepared grid): ok:true, no LLM call,
      // no proposal, no purchase. Close as not_sent so a retry is allowed to
      // resubmit once the graph has content — never a paid failure.
      await recordReceipt(
        db,
        won.identity,
        won.deliveryId,
        won.fence,
        NOT_SENT_RECEIPT(won.deliveryId),
      );
      throw new ApiError('empty_scope', '没有可用于生成目标路径的知识点', 422, undefined, {
        request_id: won.deliveryId,
        outcome: 'not_sent',
      });
    }
    const proposal: GoalIntentProposal = {
      kind: 'goal_scope',
      proposal_id: result.proposal_id,
      goal_id: result.goal_id,
      scope_count: result.scope_count,
    };
    try {
      const receipt = await proposedReceipt(db, proposal.proposal_id, won.deliveryId);
      await recordReceipt(db, won.identity, won.deliveryId, won.fence, receipt);
    } catch (err) {
      console.error('[goal-intent] proposal receipt record failed', proposal.proposal_id, err);
    }
    return proposal;
  } catch (err) {
    // The proposal was written but its receipt bookkeeping failed — the paid
    // outcome stands; surface the error without repurchasing.
    console.error('[goal-intent] post-send handling failed', err);
    throw err;
  }
}

/**
 * Pending same-topic replay, else one in-flight dispatch joined by concurrent
 * retries. The producer is the canonical goal_scope writer; this seam only
 * owns the paid claim/receipt so the same words never repurchase a send.
 */
export async function runGoalIntentRequest(
  database: Db,
  words: string,
  goalTitle: string,
  subjectId: string | null,
  runTaskFn: RunTaskFn,
): Promise<GoalIntentProposal> {
  const pending = await sealPendingProposal(database, words);
  if (pending) return pending;
  await settleExpiredPaidEffectSends(database, { family: FAMILY });
  for (let step = 0; step < 4; step += 1) {
    const slot = await claimSlot(database, words);
    if (slot.kind === 'replay') {
      await sealGoalScopeReceipt(database, words, slot.proposal.proposal_id);
      return slot.proposal;
    }
    if (slot.kind === 'unresolved') break;
    if (slot.kind === 'closed_known') {
      throw new ApiError(
        slot.receipt.code ?? 'goal_intent_failed',
        slot.receipt.message ?? 'goal intent failed',
        502,
        undefined,
        {
          request_id: slot.receipt.request_id,
          task_run_id: slot.receipt.task_run_id,
          outcome: slot.receipt.outcome,
        },
      );
    }
    if (slot.kind === 'winner')
      return dispatchWinner(database, words, goalTitle, subjectId, runTaskFn, slot);
    const joined = await joinAttempt(database, words, slot.identity);
    if (joined.kind === 'proposal') return joined.proposal;
    const sealed = await sealPendingProposal(database, words);
    if (sealed) return sealed;
    if (joined.kind === 'unresolved') break;
  }
  throw new ApiError('goal_intent_in_flight', 'goal intent request is still in flight', 409);
}
