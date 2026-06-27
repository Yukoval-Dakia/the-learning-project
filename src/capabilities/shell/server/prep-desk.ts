// YUK-406 / YUK-440 (教研团 Phase 0 / U4 备课台) — prep-desk read model. Surfaces the
// top ≤3 PENDING conjecture proposals as the "为你而备" 备课台 card feed (NOT a backlog
// / task list). Conjectures are induced by the nightly research-meeting sleep job and
// land on the existing experimental:proposal event/inbox path (writeAiProposal default
// + proposalWhere) — ZERO inbox/writer change, same precedent as goal_scope.
//
// Two hard invariants this read model enforces (defense in depth):
//   1. Internal calibration NUMBERS never cross the wire. `confidence`,
//      `predicted_p`, and `baseline_p_at_induction` are all internal calibration
//      probabilities — `confidence` is read locally ONLY to compute salience (=
//      confidence × recurrence_count) then DROPPED; `predicted_p` / `baseline_p` are
//      consumed by the U8 typed-ledger reconcile loop straight from the EVENT-log
//      payload, NOT from this felt read model. None of the three may appear on
//      PrepDeskConjecture nor anywhere in the JSON response: a raw probability on the
//      felt card (the existing ProposalCard.tsx renders any `confidence` field as a
//      `%` bar) lets the owner "optimize the number" — the explicit anti-guilt KILL
//      criterion. `predicted_p` = P(you answer correctly) is the most guilt-inducing
//      of the three and is structurally low for EVERY card by the induction
//      precondition, so it carries no per-card signal anyway. If the design lane wants
//      emphasis it must derive a NON-numeric server signal, not a bare probability.
//   2. The PENDING conjecture carries an UNRUN discriminating probe (`probe_md`). At
//      read time NO probe question has been served yet (serving happens on accept via
//      serveProbeOnce), so the wire surfaces the probe TEXT — the question the team is
//      *about to ask* — NOT a {question_id,status} CTA. claim + evidence back-link +
//      unrun probe_md together are the non-exportable artifact the Anki-export tripwire
//      requires (a conjecture-with-provenance must not be exportable to a flashcard).
//
// See docs/design/handoff/2026-06-27-prep-desk-conjectures.md and
// docs/design/2026-06-27-a13-ts-half-design.md.

import type { Db } from '@/db/client';
import { listProposalInboxPage } from '@/server/proposals/inbox';

// 备课台 surfaces at most 3 conjectures — a guilt-free, finite "为你而备" feed, never a
// growing backlog. Salience sorts the fetched pending window before this cap.
export const PREP_DESK_MAX = 3;

// Fetch limit so salience can rank up to the 50 most-recent pending conjectures before
// the ≤3 cap (the inbox page is salience-agnostic recency order; we re-sort locally).
// With nightly induction + the felt cap the pending set stays far below 50; if it ever
// exceeded that, a high-salience older conjecture could fall outside this window.
const PREP_DESK_FETCH_LIMIT = 50;

/** Back-link to the evidence that induced the conjecture (failure events / questions). */
export interface PrepDeskEvidenceRef {
  kind: string;
  id: string;
}

/**
 * The wire-shape contract the 备课台 card UI consumes. NOTE: `confidence` is
 * deliberately absent — it never crosses the wire (invariant 1 above).
 */
export interface PrepDeskConjecture {
  /** The conjecture id === the proposal event id (the conjecture has no separate row). */
  id: string;
  /** The misconception belief, from proposed_change.claim_md. */
  claim: string;
  /** The KC the belief is about. */
  knowledge_id: string;
  /** The induced cause category. */
  cause_category: string;
  /** The UNRUN discriminating probe text — the question the team is about to ask. */
  probe_md: string;
  /** How many times the (cause × KC) failure cell recurred (≥2). */
  recurrence_count: number;
  /** Whether the probe is one only THIS misconception fails. */
  discriminating: boolean;
  // NOTE: `predicted_p` / `baseline_p_at_induction` are deliberately ABSENT — they are
  // internal calibration probabilities (consumed by the U8 reconcile loop from the
  // event-log payload), never wired to the felt card (invariant 1 above).
  /** Whether the owner rewrote the claim (edit path). */
  corrected_by_owner: boolean;
  /** Evidence back-link (failure events / questions that induced the conjecture). */
  evidence: PrepDeskEvidenceRef[];
  /** ISO-8601 proposed timestamp. */
  proposed_at: string;
}

export interface PrepDeskConjecturesResult {
  conjectures: PrepDeskConjecture[];
}

/**
 * Load the top ≤3 pending conjectures for the 备课台 card, ranked by salience
 * (confidence × recurrence_count, DESC). Confidence is read locally for ranking only
 * and is stripped from every returned row.
 */
export async function loadPrepDeskConjectures(db: Db): Promise<PrepDeskConjecturesResult> {
  const { rows } = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'conjecture',
    limit: PREP_DESK_FETCH_LIMIT,
  });

  const ranked = rows
    .flatMap((row) => {
      // Narrow the discriminated union to the conjecture variant so proposed_change is
      // typed as ConjectureProposalChange. Defensive: skip any non-conjecture row.
      if (row.payload.kind !== 'conjecture') return [];
      const change = row.payload.proposed_change;
      // confidence is read HERE for salience and never escapes this scope.
      const salience = change.confidence * change.recurrence_count;
      const conjecture: PrepDeskConjecture = {
        id: row.id,
        claim: change.claim_md,
        knowledge_id: change.knowledge_id,
        cause_category: change.cause_category,
        probe_md: change.probe_md,
        recurrence_count: change.recurrence_count,
        discriminating: change.discriminating,
        // predicted_p / baseline_p_at_induction intentionally NOT mapped — internal
        // calibration numbers stay off the felt wire (invariant 1).
        corrected_by_owner: change.corrected_by_owner,
        evidence: row.payload.evidence_refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        proposed_at: row.proposed_at.toISOString(),
      };
      return [{ salience, conjecture }];
    })
    .sort((a, b) => b.salience - a.salience)
    .slice(0, PREP_DESK_MAX)
    .map((entry) => entry.conjecture);

  return { conjectures: ranked };
}
