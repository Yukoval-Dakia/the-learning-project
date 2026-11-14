// Batch confirmation for reversible proposals (YUK-2009).
//
// Not a second accept implementation: every item still goes through the one
// canonical `acceptAiProposal` path (proposal decision lock, single rate event,
// owner applier, CAS/lossy declarations intact). This module adds what a set
// needs on top of the single-card lane:
//
//   1. Kind eligibility: the B-strength (human-confirmed) kinds whose declared
//      retract path actually reverses the accepted effect, so a confirmed set
//      stays undoable through the canonical single-item retract. `question_edit`
//      declares retract only to guard an unapplied edit_request and refuses
//      once applied — the owner requires a new edit proposal — so it is not in
//      the set. `note_update` is out too: its undo restores the pre-apply body
//      without checking whether later edits landed, and a batch revoke has no
//      time window — one click would silently roll back every edit since the
//      apply. `variant_question` is out as well: accept publishes the
//      materialized question into the general pool, but its retract only
//      re-projects the mistake_variant row and never un-publishes, so a
//      "revoked" question would stay servable. Attempts, grading, settlement,
//      block_merge and every kind without a retract declaration are rejected
//      per item, never accepted.
//   2. A per-item report: one failure or rejection never rolls back another
//      item's committed accept.
//   3. Idempotent replay: `batch_id` is derived from the id set, so a retry is
//      the same batch, not a new one. An item already carrying an accept
//      decision — whether from an earlier run of this batch or the single
//      path — reports `already_accepted` without a second decision write.
//   4. Durable identity BEFORE the first effect: the members anchor
//      (`stage:'members'`) is persisted before any accept runs, so a crash or
//      failed result write can never strand committed accepts without a
//      recoverable batch. Result anchors (`stage:'result'`) record the
//      accepted set for revoke-by-batch; a retry that finds members-only — or
//      members whose accepts grew since the recorded set — writes another
//      result anchor, and readers fold the union of all of them.
//
// No request rate limiter: input is bounded (<=200 ids), every item goes
// through the canonical per-proposal decision lock so replays are no-ops, and
// the id-derived batch_id makes concurrent duplicates collapse onto one
// anchor — the worst-case cost of a spammed call equals the same accepts sent
// individually through the existing single path, which is already unthrottled.
//
// Install note: `installBatchConfirmEligibility` publishes the derived kind
// set through the kernel port so inbox rows carry `batch_confirm_eligible`
// without kernel importing a capability manifest.

import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  type AiProposalPayloadT,
  ProposalBatchAcceptInput,
  aiProposalKindStrength,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  PROPOSAL_BATCH_ACCEPT_ACTION,
  installBatchConfirmEligibleKinds,
} from '@/kernel/proposals/batch-confirm';
import { acceptAiProposal } from '@/server/proposals/accept-action';
import { proposalLifecycleRegistry } from '@/server/proposals/lifecycle-context';

export type BatchAcceptItemStatus = 'accepted' | 'already_accepted' | 'rejected' | 'failed';

export interface BatchAcceptItem {
  readonly proposal_id: string;
  readonly kind: string;
  readonly status: BatchAcceptItemStatus;
  readonly code: string | null;
  readonly reason_md: string | null;
}

export interface BatchAcceptResult {
  readonly batch_id: string | null;
  readonly items: BatchAcceptItem[];
  readonly summary: {
    readonly requested: number;
    readonly accepted: number;
    readonly already_accepted: number;
    readonly rejected: number;
    readonly failed: number;
  };
}

const ITEM_REASONS = {
  proposal_not_found: '找不到这条改动。',
  kind_not_batchable: '这类改动不支持成套确认。',
  already_decided: '这条改动已经处理过了。',
  accept_failed: '确认没有完成，请稍后再试。',
} as const;

/**
 * Kinds certified batch-confirmable: B-strength and post-accept revocable.
 * The live registry is still consulted on every call, so a kind losing its
 * accept or retract declaration — or being re-strengthened — drops out of
 * the set rather than staying accepted on a stale whitelist.
 */
const BATCH_CONFIRMABLE_KINDS: ReadonlySet<string> = new Set([
  'completion',
  'goal_scope',
  'relearn',
]);

export function batchConfirmEligibleKinds(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const kind of BATCH_CONFIRMABLE_KINDS) {
    const decl = proposalLifecycleRegistry.get(kind);
    if (aiProposalKindStrength[kind as AiProposalPayloadT['kind']] !== 'B') continue;
    if (!decl?.accept || !decl.retract) continue;
    out.add(kind);
  }
  return out;
}

/** Composition roots install the derived set so inbox rows can carry the flag. */
export function installBatchConfirmEligibility(): void {
  installBatchConfirmEligibleKinds([...batchConfirmEligibleKinds()]);
}

/** The batch is the id set: a retry re-derives the same identity. */
export function proposalBatchId(ids: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex')
    .slice(0, 24);
  return `proposal_batch_${digest}`;
}

const MEMBERS_EVENT_ID = (batchId: string) => `evt_${batchId}`;
// Content-keyed so a concurrent write of the SAME accepted set dedupes on the
// primary key while a set that grew between runs lands as a second anchor —
// revoke-by-batch folds the union, it does not overwrite history.
const RESULT_EVENT_ID = (batchId: string, acceptedIds: readonly string[]) =>
  `${MEMBERS_EVENT_ID(batchId)}:result:${createHash('sha256')
    .update([...acceptedIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 12)}`;

function parseInput(input: unknown) {
  const parsed = ProposalBatchAcceptInput.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }
  return parsed.data;
}

function proposalPayload(payload: unknown): AiProposalPayloadT | null {
  const raw = (payload as { ai_proposal?: unknown } | null)?.ai_proposal;
  if (raw === undefined) return null;
  try {
    return parseAiProposalPayload(raw);
  } catch {
    return null;
  }
}

function item(
  proposalId: string,
  kind: string,
  status: BatchAcceptItemStatus,
  code: keyof typeof ITEM_REASONS | null,
  reasonOverride?: string | null,
): BatchAcceptItem {
  return {
    proposal_id: proposalId,
    kind,
    status,
    code,
    reason_md: code === null ? (reasonOverride ?? null) : ITEM_REASONS[code],
  };
}

interface BatchAnchors {
  members: typeof event.$inferSelect | null;
  /** At least one result anchor exists — the batch is closed (even when empty). */
  hasResult: boolean;
  /** Union of every result anchor's accepted set — the revocable batch. */
  acceptedIds: ReadonlySet<string>;
}

async function loadBatchAnchors(db: Db, batchId: string): Promise<BatchAnchors> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION), eq(event.subject_id, batchId)))
    .orderBy(event.created_at);
  const acceptedIds = new Set<string>();
  const anchors: BatchAnchors = { members: null, hasResult: false, acceptedIds };
  for (const row of rows) {
    const payload = row.payload as { stage?: unknown; proposal_ids?: unknown };
    if (payload.stage === 'members') anchors.members ??= row;
    if (payload.stage === 'result') {
      anchors.hasResult = true;
      if (Array.isArray(payload.proposal_ids)) {
        for (const id of payload.proposal_ids) {
          if (typeof id === 'string') acceptedIds.add(id);
        }
      }
    }
  }
  return anchors;
}

/**
 * Persist the recoverable identity before the first effect. `writeEvent`
 * ignores duplicate ids, so a concurrent run writing the same deterministic
 * anchor is a no-op — but if no anchor can be read back afterwards, nothing
 * may run: an accept committed without a durable batch would be unrecoverable
 * for revoke-by-set.
 */
async function ensureMembersAnchor(db: Db, batchId: string, ids: string[]): Promise<void> {
  await writeEvent(db, {
    id: MEMBERS_EVENT_ID(batchId),
    actor_kind: 'user',
    actor_ref: 'self',
    action: PROPOSAL_BATCH_ACCEPT_ACTION,
    subject_kind: 'proposal_batch',
    subject_id: batchId,
    outcome: 'success',
    payload: {
      version: 2,
      batch_id: batchId,
      stage: 'members',
      proposal_ids: ids,
    },
    // Internal bookkeeping anchor, not learner activity — a non-null stamp
    // keeps it out of memory extraction and brief scopes (auto-apply precedent).
    ingest_at: new Date(),
  });
  const { members } = await loadBatchAnchors(db, batchId);
  if (!members) {
    throw new ApiError(
      'batch_anchor_unavailable',
      'proposal batch identity could not be persisted; no accept was attempted',
      500,
    );
  }
}

async function writeResultAnchor(
  db: Db,
  batchId: string,
  acceptedIds: readonly string[],
  items: BatchAcceptItem[],
): Promise<void> {
  await writeEvent(db, {
    id: RESULT_EVENT_ID(batchId, acceptedIds),
    actor_kind: 'user',
    actor_ref: 'self',
    action: PROPOSAL_BATCH_ACCEPT_ACTION,
    subject_kind: 'proposal_batch',
    subject_id: batchId,
    outcome: 'success',
    payload: {
      version: 2,
      batch_id: batchId,
      stage: 'result',
      proposal_ids: [...acceptedIds].sort(),
      items,
    },
    // Same opt-out as the members anchor: audit trail, not memory-worthy activity.
    ingest_at: new Date(),
  });
}

/**
 * Confirm a set of pending proposals. `input` is the raw HTTP body; the
 * canonical schema owns validation so the route and future callers share one
 * contract.
 */
export async function batchAcceptProposals(db: Db, input: unknown): Promise<BatchAcceptResult> {
  const parsed = parseInput(input);
  const ids = [...new Set(parsed.proposal_ids)];
  const batchId = proposalBatchId(ids);
  const eligible = batchConfirmEligibleKinds();

  // Identity and membership must outlive this call before the first effect
  // lands; a finished batch keeps its result anchor and only replays items.
  await ensureMembersAnchor(db, batchId, ids);
  const anchorsBefore = await loadBatchAnchors(db, batchId);

  const proposalRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids));
  const proposalById = new Map(proposalRows.map((row) => [row.id, row]));

  const corrections = await getCorrectionStatuses(db, ids);

  // Latest terminal rate per proposal: 'accept' replays report as
  // already_accepted; any other terminal decision rejects the item. A
  // non-terminal rate leaves the proposal pending.
  const rateRows = await db
    .select({
      proposalId: event.caused_by_event_id,
      rating: event.payload,
      createdAt: event.created_at,
      id: event.id,
    })
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, ids)))
    .orderBy(desc(event.created_at), desc(event.id));
  const terminalRatingById = new Map<string, string>();
  for (const row of rateRows) {
    if (!row.proposalId || terminalRatingById.has(row.proposalId)) continue;
    const rating = (row.rating as { rating?: unknown } | null)?.rating;
    if (
      rating === 'accept' ||
      rating === 'dismiss' ||
      rating === 'reverse' ||
      rating === 'change_type' ||
      rating === 'rollback'
    ) {
      terminalRatingById.set(row.proposalId, rating);
    }
  }

  const items: BatchAcceptItem[] = [];
  const acceptedIds: string[] = [];

  for (const id of ids) {
    const row = proposalById.get(id);
    if (!row) {
      items.push(item(id, 'unknown', 'failed', 'proposal_not_found'));
      continue;
    }
    const payload = proposalPayload(row.payload);
    if (!payload) {
      // Unparseable or legacy payload: the eligibility proof cannot run, so the
      // item is rejected rather than accepted on a guess.
      items.push(item(id, 'unknown', 'rejected', 'kind_not_batchable'));
      continue;
    }
    const terminal = terminalRatingById.get(id);
    // A correction wins over the surviving accept rate: retract leaves the
    // 'accept' rate in place and marks the proposal via a correct event, so
    // ordering this first keeps a retracted item decided instead of replayable.
    if (
      (corrections.get(id)?.state ?? 'active') !== 'active' ||
      (terminal && terminal !== 'accept')
    ) {
      items.push(item(id, payload.kind, 'rejected', 'already_decided'));
      continue;
    }
    // Eligibility precedes the accepted-state read: a kind that cannot be
    // batch-revoked must not enter the anchor even when it was already
    // accepted through the single path — the set would claim it as revocable
    // while its retract refuses.
    if (!eligible.has(payload.kind)) {
      items.push(item(id, payload.kind, 'rejected', 'kind_not_batchable'));
      continue;
    }
    if (terminal === 'accept') {
      items.push(item(id, payload.kind, 'already_accepted', null));
      acceptedIds.push(id);
      continue;
    }
    try {
      const accepted = await acceptAiProposal(db, id, {
        ...(parsed.user_note ? { user_note: parsed.user_note } : {}),
      });
      // The canonical replay flag distinguishes a fresh decision from an
      // accept that raced in via the single path or an earlier batch run.
      const status = accepted.idempotent === true ? 'already_accepted' : 'accepted';
      items.push(item(id, payload.kind, status, null));
      acceptedIds.push(id);
    } catch (err) {
      if (err instanceof ApiError) {
        const status =
          err.code === 'conflict' || err.code === 'not_pending' ? 'rejected' : 'failed';
        items.push(
          item(
            id,
            payload.kind,
            status,
            status === 'rejected' ? 'already_decided' : 'accept_failed',
            status === 'failed' ? err.message : null,
          ),
        );
      } else {
        console.warn('[proposal-batch-accept] accept failed', {
          proposal_id: id,
          kind: payload.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        items.push(item(id, payload.kind, 'failed', 'accept_failed'));
      }
    }
  }

  // The result anchors are what revoke-by-batch consumes. The first run to
  // reach this point always writes one — even with an empty accepted set, so a
  // fully rejected batch reads `closed` instead of staying `open` forever. A
  // later run writes another only when its accepted set adds members beyond
  // the recorded union — covering both crash recovery (an earlier run
  // committed accepts and died before recording them; its members anchor is
  // still here, so this retry completes the same batch instead of minting a
  // second one) and a retry that newly accepted a member the first run could
  // not.
  const effectiveAccepted = [...new Set([...anchorsBefore.acceptedIds, ...acceptedIds])];
  if (!anchorsBefore.hasResult || effectiveAccepted.length > anchorsBefore.acceptedIds.size) {
    await writeResultAnchor(db, batchId, effectiveAccepted, items);
  }
  const { acceptedIds: recordedAccepted } = await loadBatchAnchors(db, batchId);

  return {
    batch_id: recordedAccepted.size > 0 ? batchId : null,
    items,
    summary: {
      requested: ids.length,
      accepted: items.filter((entry) => entry.status === 'accepted').length,
      already_accepted: items.filter((entry) => entry.status === 'already_accepted').length,
      rejected: items.filter((entry) => entry.status === 'rejected').length,
      failed: items.filter((entry) => entry.status === 'failed').length,
    },
  };
}
