// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier. Owned by the
// agency package (the nightly 例会 sleep job is the single proposer of
// `conjecture` proposals; this is the owner-decision applier). Three semantics:
//
//   accept — owner agrees with the DIRECTION of the conjecture. This is a
//            calibration ANCHOR, NOT a confirmed weakness. `weakness_confirmed`
//            is ALWAYS false here — only the probe one-shot (a later task) mints
//            a confirmed weakness via its own confirmation path.
//   edit   — owner rewrote the claim (corrected_payload). corrected_by_owner=true
//            and the owner's version is written to mem0 CORE via the INJECTABLE
//            ConjectureCoreWriter seam (default no-op so tests / cold-start never
//            hit live mem0). Still NOT auto-confirmed.
//   reject — handled by dismissAiProposal's default branch (writeGenericRateEvent
//            rating='dismiss' + recordProposalDecisionSignal → digest); not here.
//
// ND-5 RED LINE: this path NEVER writes FSRS / review state, NEVER enrolls a
// learning item, NEVER touches review scheduling. A conjecture accept is a
// calibration anchor, not a learning-item event.
//
// Canonical identity (a13 design §6 / MISMATCH #1): the conjecture has NO
// separate row in PR-1 — the conjecture IS the proposal event, so its stable id
// (`conjecture_id`, referenced downstream as `conjecture_event_id`) is the
// proposalId. `target.subject_kind === 'mind_model'`, `target.subject_id ===
// knowledge_id`. The kind literal is `'conjecture'` (NOT `'mind_model'`).
//
// import 环 gate：本文件不得 import producers/writer/actions；共享 helper 走
// @/server/proposals/applier-helpers（与 sibling proposal-appliers 同约束）。

import {
  K_PROMOTE,
  misconceptionPromoteEnabled,
  promoteConjectureToMisconception,
} from '@/capabilities/agency/server/misconception-promote';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';

export interface ConjectureApplierOpts {
  decision?: string;
  user_note?: string;
  // EDIT path: the owner-rewritten conjecture payload (canonical field names,
  // MISMATCH #2). Presence ⇒ corrected_by_owner=true + a CORE write.
  corrected_payload?: { claim_md?: string; cause_category?: string; knowledge_id?: string };
}

export interface ConjectureAcceptResult {
  kind: 'conjecture';
  rate_event_id: string;
  // = proposalId (the conjecture event id; the conjecture has no separate row).
  conjecture_id: string;
  // false on plain accept (agree with direction); true on edit (owner rewrote).
  corrected_by_owner: boolean;
  // ALWAYS false: accept/edit never confirm a weakness — the probe does (later task).
  weakness_confirmed: false;
  idempotent?: boolean;
}

// Single owner of mem0 CORE writes for conjectures. Injected (default no-op in
// tests / cold-start; wired to the live mem0 CORE writer by the agency worker
// composition root in a later task). The sleep job is the only proposer; CORE is
// read-only to copilot (single-writer invariant) — this seam preserves that by
// being the lone write path for owner-corrected conjecture claims.
export type ConjectureCoreWriter = (input: {
  conjecture_id: string;
  claim_md: string;
  corrected_by_owner: boolean;
}) => Promise<void>;

let coreWriter: ConjectureCoreWriter = async () => {
  // Phase-deferred (feedback_phase_deferred_comments): default no-op. The live
  // mem0 CORE writer is injected by the agency worker composition root once the
  // mem0 wiring task lands; tests inject a spy via setConjectureCoreWriter.
};

export function setConjectureCoreWriter(writer: ConjectureCoreWriter): void {
  coreWriter = writer;
}

export async function acceptConjectureProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: ConjectureApplierOpts = {},
): Promise<ConjectureAcceptResult> {
  ensureAcceptOnly('conjecture', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  // The conjecture's stable identity is the proposal event id (no separate row).
  const conjectureId = proposalId;

  // Idempotency: a prior accept rate event short-circuits (409s on a non-accept
  // prior decision via existingAcceptRate). No second rate event, no second CORE
  // write — re-accept returns the recorded corrected_by_owner verbatim.
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const ratePayload = existingRate.payload as { corrected_by_owner?: boolean };
    return {
      kind: 'conjecture',
      rate_event_id: existingRate.id,
      conjecture_id: conjectureId,
      corrected_by_owner: ratePayload.corrected_by_owner === true,
      weakness_confirmed: false,
      idempotent: true,
    };
  }

  const isEdit = opts.corrected_payload !== undefined;
  const correctedClaim =
    isEdit && typeof opts.corrected_payload?.claim_md === 'string'
      ? opts.corrected_payload.claim_md
      : undefined;

  const now = new Date();
  const rateEventId = newId();

  // YUK-531 PR-3 — the rate write + the (dark, flag-gated) misconception promotion
  // are ATOMIC in ONE db.transaction. When the flag is OFF this is effect-identical to
  // today (a single rate-event INSERT, same payload — wrapping one write in BEGIN/COMMIT
  // changes no observable row). When ON, atomicity is load-bearing: a crash AFTER the
  // rate write but BEFORE the misconception upsert would otherwise strand a
  // misconception-less accept that the idempotency guard above then permanently skips.
  //
  // ND-5 RED LINE preserved: this path still NEVER writes FSRS / review / learning-item
  // state. A minted misconception is SOFT-track (source='soft', dark flag) — an AI prior
  // the owner agreed with, NOT a confirmed weakness (only the probe one-shot mints that).
  await db.transaction(async (tx) => {
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      // RateEvent.payload (known.ts:268) is non-strict — these extra keys are
      // stripped by parse but PERSISTED raw on the event row (verified queries.ts;
      // mirrors goal_scope's materialized_goal_id). The read model + calibration
      // retro read them off the row.
      payload: {
        rating: 'accept',
        conjecture_id: conjectureId,
        // accept = agree with direction (NOT confirmed); edit = corrected_by_owner.
        corrected_by_owner: isEdit,
        calibration_anchor: isEdit ? 'edit' : 'accept',
        ...(correctedClaim ? { corrected_claim_md: correctedClaim } : {}),
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    // DARK promotion hop. Reads recurrence_count off the persisted proposal change
    // (NOT a fresh gatherConjectureEvidence). K_PROMOTE=2 is redundant with the
    // induction floor (every conjecture already recurred ≥2) — the real gate is the
    // flag + the human accept (see misconception-promote.ts). On an EDIT accept the
    // owner's rewritten claim becomes the misconception title.
    if (misconceptionPromoteEnabled() && Number(change.recurrence_count) >= K_PROMOTE) {
      const evidenceEventIds = proposal.payload.evidence_refs
        .filter((ref) => ref.kind === 'event')
        .map((ref) => ref.id);
      await promoteConjectureToMisconception(tx, {
        conjectureId,
        knowledgeId: requiredString(change.knowledge_id, 'knowledge_id', proposalId),
        claimMd: correctedClaim ?? requiredString(change.claim_md, 'claim_md', proposalId),
        causeCategory: requiredString(change.cause_category, 'cause_category', proposalId),
        confidence: Number(change.confidence),
        recurrenceCount: Number(change.recurrence_count),
        evidenceEventIds,
        now,
      });
    }
  });

  // EDIT only: the owner's rewritten claim goes to mem0 CORE (single-writer
  // seam). Accept-not-confirmed: NO weakness minted, NO FSRS write (ND-5).
  if (isEdit) {
    const claim = correctedClaim ?? requiredString(change.claim_md, 'claim_md', proposalId);
    await coreWriter({ conjecture_id: conjectureId, claim_md: claim, corrected_by_owner: true });
  }

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return {
    kind: 'conjecture',
    rate_event_id: rateEventId,
    conjecture_id: conjectureId,
    corrected_by_owner: isEdit,
    weakness_confirmed: false,
  };
}
