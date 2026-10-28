import type { ProposalDecisionInputT, ProposalDecisionResourceT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { getCorrectionStatus } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type { ProposalLifecycleResult } from '@/kernel/proposals';
import { findExistingRateEvent } from '@/kernel/proposals/applier-helpers';
import { getProposalInboxRow } from '@/kernel/proposals/inbox';
import { acceptAiProposal, dismissAiProposal, retractAiProposal } from '@/server/proposals/actions';

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

function resultIsIdempotent(result: ProposalLifecycleResult): boolean {
  return result.idempotent === true;
}

/**
 * YUK-1404 — soft-stale block_merge accept: the applier skipped the merge and
 * wrote no rate event or signal, so there is no immutable event to point at.
 * Structural and state checks keep a malformed result from being served as stale.
 */
function isStaleBlockMergeAccept(
  decision: ProposalDecisionInputT['decision'],
  result: ProposalLifecycleResult,
): result is ProposalLifecycleResult & { kind: 'block_merge'; stale: true } {
  return decision === 'accept' && result.kind === 'block_merge' && result.stale === true;
}

/**
 * Create the canonical immutable decision representation for a proposal.
 *
 * accept/reverse/change_type/dismiss → chained `rate`; retract → chained
 * `correct(retract)`. Same decision replay → existing event, idempotent;
 * a different terminal decision → 409. Retract may follow accept/dismiss.
 *
 * `decision_event_id` is readable via GET /api/events/:id for an honest Location.
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
    const existingRate = await findExistingRateEvent(db, proposalId);
    if (existingRate) {
      if (existingRate.decision !== input.decision) {
        throw conflict(proposalId, existingRate.decision);
      }
      // Only accept re-enters the per-kind applier, which re-drives best-effort
      // note_generate on re-accept; accept appliers self-guard idempotency.
      // reverse/change_type/dismiss have no re-drive hop and would turn a
      // same-decision replay from 200 into 409, so serve that replay here.
      if (input.decision !== 'accept') {
        return {
          proposal_id: proposalId,
          proposal_kind: proposal.kind,
          decision: input.decision,
          decision_event_id: existingRate.id,
          proposal_status: proposal.status,
          created: false,
          idempotent: true,
          result: null,
        };
      }
    }
  }

  let result: ProposalLifecycleResult;
  try {
    if (input.decision === 'retract') {
      result = await retractAiProposal(db, proposalId, {
        reason_md: input.reason_md,
        affected_refs: input.affected_refs,
      });
    } else if (input.decision === 'dismiss') {
      result = await dismissAiProposal(db, proposalId, { user_note: input.user_note });
    } else if (input.decision === 'change_type') {
      if (!input.new_relation_type) {
        throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
      }
      result = await acceptAiProposal(db, proposalId, {
        decision: input.decision,
        new_relation_type: input.new_relation_type,
        user_note: input.user_note,
      });
    } else if (input.decision === 'accept') {
      result = await acceptAiProposal(db, proposalId, {
        decision: 'accept',
        user_note: input.user_note,
        corrected_payload: input.corrected_payload,
        confirm_lossy: input.confirm_lossy,
      });
    } else if (input.decision === 'reverse') {
      result = await acceptAiProposal(db, proposalId, {
        decision: 'reverse',
        user_note: input.user_note,
      });
    } else {
      throw new ApiError('validation_error', 'unsupported proposal decision', 400);
    }
  } catch (err) {
    normalizeDomainError(err);
  }

  const refreshed = await getProposalInboxRow(db, proposalId);
  if (!refreshed) {
    throw new ApiError('not_found', `proposal ${proposalId} not found after decision`, 404);
  }

  // YUK-1404 — a soft-stale block_merge accept committed nothing, so serve the
  // honest pending representation (200, decision_event_id:null) instead of 500.
  // Every other completed decision still requires an immutable event below.
  if (
    isStaleBlockMergeAccept(input.decision, result) &&
    proposal.kind === 'block_merge' &&
    refreshed.status === 'pending'
  ) {
    return {
      proposal_id: proposalId,
      proposal_kind: proposal.kind,
      decision: 'accept',
      decision_event_id: null,
      proposal_status: refreshed.status,
      created: false,
      idempotent: false,
      result,
    };
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
