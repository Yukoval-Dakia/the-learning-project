import type { ProposalDecisionInputT, ProposalDecisionResourceT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { getCorrectionStatus } from '@/server/events/corrections';
import { ApiError } from '@/server/http/errors';
import { acceptAiProposal, dismissAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { findExistingRateEvent } from '@/server/proposals/applier-helpers';
import { getProposalInboxRow } from '@/server/proposals/inbox';

function conflict(proposalId: string, existingDecision: string): ApiError {
  return new ApiError(
    'conflict',
    `proposal ${proposalId} already decided as ${existingDecision}`,
    409,
  );
}

function normalizeDomainError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (/PR A.*propose_new/i.test(message)) {
    throw new ApiError('unsupported_mutation', message, 400);
  }
  if (/^unknown_mutation/i.test(message)) {
    throw new ApiError('unknown_mutation', message, 400);
  }
  if (/not.*pending|already rated/i.test(message)) {
    throw new ApiError('not_pending', message, 409);
  }
  if (/not found/i.test(message)) {
    throw new ApiError('not_found', message, 404);
  }
  if (/^stale/i.test(message)) {
    throw new ApiError('stale', message, 409);
  }
  throw err;
}

function resultIsIdempotent(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { idempotent?: unknown }).idempotent === true
  );
}

/**
 * Create the canonical immutable decision representation for a proposal.
 *
 * Matrix:
 * - accept/reverse/change_type/dismiss -> one chained `rate` event
 * - retract -> one effective chained `correct(retract)` event
 * - same normalized decision replay -> existing event, 200/idempotent
 * - different terminal decision -> 409
 * - retract may follow an accept/dismiss because it is the L3 correction lane
 *
 * `decision_event_id` is readable through GET /api/events/:id, allowing the
 * HTTP handler to return an honest Location for newly created decisions.
 */
export async function createProposalDecision(
  db: Db,
  proposalId: string,
  input: ProposalDecisionInputT,
): Promise<ProposalDecisionResourceT> {
  const proposal = await getProposalInboxRow(db, proposalId);
  if (!proposal) {
    throw new ApiError('not_found', `proposal ${proposalId} not found`, 404);
  }

  const correction = await getCorrectionStatus(db, proposalId);
  if (correction.state === 'retracted') {
    if (input.decision !== 'retract') throw conflict(proposalId, 'retract');
    return {
      proposal_id: proposalId,
      proposal_kind: proposal.kind,
      decision: 'retract',
      decision_event_id: correction.correction_event_id,
      proposal_status: proposal.status,
      created: false,
      idempotent: true,
      result: null,
    };
  }

  if (input.decision !== 'retract') {
    // Keep the cross-decision conflict guard, but DROP the idempotent short-circuit:
    // a same-decision re-decision now falls through to acceptAiProposal / dismissAiProposal,
    // whose per-kind appliers self-guard idempotency (YUK-681 audit: all 16 accept-family
    // kinds SAFE). This is what makes learning_item's idempotent branch re-drive the
    // best-effort note_generate enqueue on re-accept — the recovery path this early return
    // previously made unreachable (YUK-681 P2). The applier's result carries `idempotent:true`,
    // which `resultIsIdempotent` below detects, so the response still reports created:false.
    const existingRate = await findExistingRateEvent(db, proposalId);
    if (existingRate && existingRate.decision !== input.decision) {
      throw conflict(proposalId, existingRate.decision);
    }
  }

  let result: unknown;
  try {
    if (input.decision === 'retract') {
      result = await retractAiProposal(db, proposalId, {
        reason_md: input.reason_md,
        affected_refs: input.affected_refs,
      });
    } else if (input.decision === 'dismiss') {
      result = await dismissAiProposal(db, proposalId, { user_note: input.user_note });
    } else {
      result = await acceptAiProposal(db, proposalId, {
        decision: input.decision,
        new_relation_type: input.new_relation_type,
        user_note: input.user_note,
      });
    }
  } catch (err) {
    normalizeDomainError(err);
  }

  const refreshed = await getProposalInboxRow(db, proposalId);
  if (!refreshed) {
    throw new ApiError('not_found', `proposal ${proposalId} not found after decision`, 404);
  }

  const decisionEventId =
    input.decision === 'retract'
      ? (await getCorrectionStatus(db, proposalId)).correction_event_id
      : ((await findExistingRateEvent(db, proposalId))?.id ?? null);
  if (!decisionEventId) {
    throw new ApiError(
      'decision_event_missing',
      `proposal ${proposalId} decision completed without an immutable event`,
      500,
    );
  }
  const idempotent = resultIsIdempotent(result);

  return {
    proposal_id: proposalId,
    proposal_kind: proposal.kind,
    decision: input.decision,
    decision_event_id: decisionEventId,
    proposal_status: refreshed.status,
    created: !idempotent,
    idempotent,
    result,
  };
}
