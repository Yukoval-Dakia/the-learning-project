// YUK-406 Phase 0 (关系脑 thin slice) — deterministic 取证 (NO LLM).
//
// Aggregates recent failure attempts into (cause_category × knowledge_id) "cells"
// that are candidate CONJECTURES about how the owner thinks. PURE function: the
// caller (research_meeting_nightly job) fetches FailureAttempt[] via
// getFailureAttempts({ since }) and a per-knowledge mastery projection, then hands
// them in. No DB import here so the recurrence/salience math stays unit-testable in
// isolation (mirrors the DepsOverride injection pattern across the agency jobs).
//
// Two gates keep one-off noise out of the surface:
//   - recurrence floor (>= 2 distinct attempts for a cell), and
//   - dedup against already-raised conjecture keys (knownConjectureKeys — for the
//     MVP these are the keys of currently-pending conjecture proposals, so the same
//     cause × KC is not re-proposed while one is still open).
//
// A13 (YUK-440) accountability seam woven in: each cell snapshots `baseline_p` =
// the learner's PFA mastery p(L) for the KC (getMasteryProjection.mastery). The job
// stamps it onto the conjecture as `baseline_p_at_induction` — the number the
// qualitative claim must later beat (scoring/flip is DEFERRED per ADR-0046; the cell
// only carries the snapshot).

import type { CauseCategoryT } from '@/core/schema/cause';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';

/** A conjecture must recur across at least this many distinct failure attempts. */
export const CONJECTURE_RECURRENCE_FLOOR = 2;

/**
 * theta_precision below this ⇒ wide SE (thetaSe = 1/√precision) ⇒ low confidence in
 * the θ̂ point estimate ⇒ "probe here". DEFAULT precision is 1 at cold start (a weak
 * 1-unit prior, SE = 1), so a KC barely observed sits below the threshold and is
 * flagged. Placeholder scale until fixed-anchor calibration (ADR-0043); 1.5 ≈ SE 0.82,
 * i.e. flag anything not yet firmly pinned.
 */
export const LOW_PRECISION_THRESHOLD = 1.5;

/** Stable dedup / sort key for a (cause_category, knowledge_id) conjecture cell. */
export function conjectureKey(causeCategory: CauseCategoryT, knowledgeId: string): string {
  return `${causeCategory}::${knowledgeId}`;
}

export interface EvidenceCell {
  /** conjectureKey(cause_category, knowledge_id) — stable dedup / sort key. */
  key: string;
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** Distinct failure attempts contributing to this cell (>= CONJECTURE_RECURRENCE_FLOOR). */
  recurrence_count: number;
  /** provenance — the attempt event ids, in first-seen order (→ evidence_refs). */
  evidence_event_ids: string[];
  /** θ̂ for this KC, or null when no mastery row exists (cold start). */
  theta_hat: number | null;
  /** Cumulative Fisher information for θ̂, or null on cold start. */
  theta_precision: number | null;
  /**
   * A13 (YUK-440) baseline: PFA mastery p(L) for this KC (getMasteryProjection.mastery),
   * or null on cold start. The job snapshots this as the conjecture's
   * `baseline_p_at_induction` — the number the qualitative claim must later beat.
   */
  baseline_p: number | null;
  /** true ⇒ low-precision (or unknown) KC: a good place to spend the one probe. */
  probe_here: boolean;
  /** true iff any contributing attempt has an owner-supplied (source:'user') cause. */
  has_owner_cause: boolean;
}

export interface GatherConjectureEvidenceInput {
  /** Recent failure attempts (caller fetched via getFailureAttempts({ since })). */
  failures: FailureAttempt[];
  /** knowledge_id → mastery projection (caller resolved via getMasteryProjection). */
  masteryByKnowledgeId: Map<string, MasteryProjection>;
  /** dedup: conjectureKey(...) values already raised — skip these cells. */
  knownConjectureKeys: Set<string>;
}

interface CellAccumulator {
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** distinct attempt ids, insertion-ordered (Map preserves first-seen order). */
  attemptIds: Map<string, true>;
  hasOwnerCause: boolean;
}

export function gatherConjectureEvidence(input: GatherConjectureEvidenceInput): EvidenceCell[] {
  const { failures, masteryByKnowledgeId, knownConjectureKeys } = input;

  // 1. Fan each failure out across (effective cause_category × each referenced KC).
  const acc = new Map<string, CellAccumulator>();
  for (const failure of failures) {
    const cause = effectiveCauseForFailureAttempt(failure);
    if (cause === null) continue; // no active cause — cannot attribute a conjecture
    const isOwnerCause = cause.source === 'user';
    for (const knowledgeId of failure.referenced_knowledge_ids) {
      const key = conjectureKey(cause.primary_category, knowledgeId);
      const cell =
        acc.get(key) ??
        ({
          cause_category: cause.primary_category,
          knowledge_id: knowledgeId,
          attemptIds: new Map<string, true>(),
          hasOwnerCause: false,
        } satisfies CellAccumulator);
      cell.attemptIds.set(failure.attempt_event_id, true); // Map ⇒ distinct, ordered
      if (isOwnerCause) cell.hasOwnerCause = true;
      acc.set(key, cell);
    }
  }

  // 2. Keep cells at/above the recurrence floor, skip already-known, attach mastery.
  const cells: EvidenceCell[] = [];
  for (const [key, cell] of acc) {
    if (cell.attemptIds.size < CONJECTURE_RECURRENCE_FLOOR) continue;
    if (knownConjectureKeys.has(key)) continue; // dedup against pending conjectures
    const mastery = masteryByKnowledgeId.get(cell.knowledge_id) ?? null;
    const thetaHat = mastery?.theta_hat ?? null;
    const thetaPrecision = mastery?.theta_precision ?? null;
    const baselineP = mastery?.mastery ?? null;
    // Unknown mastery (cold start) is itself a reason to probe; otherwise probe when
    // precision is low (thetaSe(precision) is wide).
    const probeHere = thetaPrecision === null ? true : thetaPrecision < LOW_PRECISION_THRESHOLD;
    cells.push({
      key,
      cause_category: cell.cause_category,
      knowledge_id: cell.knowledge_id,
      recurrence_count: cell.attemptIds.size,
      evidence_event_ids: [...cell.attemptIds.keys()],
      theta_hat: thetaHat,
      theta_precision: thetaPrecision,
      baseline_p: baselineP,
      probe_here: probeHere,
      has_owner_cause: cell.hasOwnerCause,
    });
  }

  // 3. Salience-first deterministic order: recurrence DESC, probe_here first, key ASC.
  cells.sort(
    (a, b) =>
      b.recurrence_count - a.recurrence_count ||
      Number(b.probe_here) - Number(a.probe_here) ||
      a.key.localeCompare(b.key),
  );
  return cells;
}
