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
//      the set. Attempts, grading, settlement, block_merge and every kind
//      without a retract declaration are rejected per item, never accepted.
//   2. A per-item report: one failure or rejection never rolls back another
//      item's committed accept.
//   3. Idempotent replay: an item already carrying an accept decision is
//      reported as such without a second decision write; an item decided any
//      other way is rejected.
//   4. A durable batch anchor (`batch_id -> proposal_ids`) written only when a
//      new accept lands, so a confirmed set can be revoked through the
//      canonical single retract path after the inbox refreshes.
//
// Install note: `installBatchConfirmEligibility` publishes the derived kind
// set through the kernel port so inbox rows carry `batch_confirm_eligible`
// without kernel importing a capability manifest.

import { createId } from '@paralleldrive/cuid2';
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
import { acceptAiProposal } from './accept-action';
import { proposalLifecycleRegistry } from './lifecycle-context';

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
  'note_update',
  'relearn',
  'variant_question',
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

/**
 * Confirm a set of pending proposals. `input` is the raw HTTP body; the
 * canonical schema owns validation so the route and future callers share one
 * contract.
 */
export async function batchAcceptProposals(db: Db, input: unknown): Promise<BatchAcceptResult> {
  const parsed = parseInput(input);
  const ids = [...new Set(parsed.proposal_ids)];
  const eligible = batchConfirmEligibleKinds();

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
    if (terminal === 'accept') {
      items.push(item(id, payload.kind, 'already_accepted', null));
      continue;
    }
    if (!eligible.has(payload.kind)) {
      items.push(item(id, payload.kind, 'rejected', 'kind_not_batchable'));
      continue;
    }
    try {
      await acceptAiProposal(db, id, {
        ...(parsed.user_note ? { user_note: parsed.user_note } : {}),
      });
      items.push(item(id, payload.kind, 'accepted', null));
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

  // The anchor exists to revoke this set later, so it is written only when a
  // new accept actually landed — a fully replayed batch already has its anchor.
  let batchId: string | null = null;
  if (acceptedIds.length > 0) {
    batchId = `proposal_batch_${createId()}`;
    await writeEvent(db, {
      id: `evt_${batchId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: PROPOSAL_BATCH_ACCEPT_ACTION,
      subject_kind: 'proposal_batch',
      subject_id: batchId,
      outcome: 'success',
      payload: {
        version: 1,
        proposal_ids: acceptedIds,
        items,
      },
    });
  }

  return {
    batch_id: batchId,
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
