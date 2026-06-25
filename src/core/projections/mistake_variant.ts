import { z } from 'zod';
import {
  GenesisExperimental,
  MistakeVariantRowSnapshot,
  type MistakeVariantRowSnapshotT,
} from '../schema/event/genesis';
import { MistakeVariantCreateExperimental } from '../schema/event/mistake-variant-events';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldMistakeVariant — the W2 structural fold for a single `mistake_variant` row (YUK-471 Wave 2).
// PURE mistake_variant reducer. The HARDEST W2 entity: cause_category is a FOLD-BLIND field.
// ====================================================================
//
// Projects the current structural state of ONE mistake_variant (`mvId`) from the event log,
// mirroring the W1 foldKnowledgeNode / W2 foldGoal patterns. Instead of mutating the
// `mistake_variant` table in place, variant_gen appends the BASE create event, the accept path
// appends a rate(accept), verify appends an experimental:variant_verify, dismiss/retract append a
// rate(dismiss) / correct(retract) — and this fold REPRODUCES the row the imperative writers
// (variant_gen INSERT / the accept/verify/dismiss/retract UPDATEs) would have written.
//
// ── A4 CORRECTION (critic A4 — base = create OR genesis) ─────────────────────────────────────
// The row's BASE/init state comes from EITHER:
//   - experimental:mistake_variant_create — the RUNTIME creation base (variant_gen, post-W2), OR
//   - experimental:genesis                — the BACKFILL base (pre-W2 rows).
// BOTH carry the FULL initial MistakeVariantRowSnapshot in payload.row, INCLUDING the fold-blind
// `cause_category`. Genesis is the backfill-only seed; the create event is the runtime-creation
// seed — using genesis on the creation hot path would corrupt the "genesis ⇒ pre-W2 row"
// invariant, so creation gets its OWN event. The reducer treats whichever appears first (sorted by
// created_at) as the base, then applies the caused_by chain.
//
// ── FOLD-BLINDNESS (cause_category) ──────────────────────────────────────────────────────────
// variant_gen computes cause_category at INSERT via effectiveCauseForFailureAttempt() and NO
// downstream event (accept / verify / dismiss / retract) carries it. The ONLY way the fold can
// reproduce it is from the base event's snapshot — which is exactly why the create event (and the
// backfill genesis) snapshot the WHOLE row. cause_category is set-once at the base and never
// mutated by the chain.
//
// PURITY CONTRACT (identical to W1/goal): no IO, no DB, no newId(), no Date.now() / new Date().
// Same input → byte-identical output. updated_at = keep-last event created_at. NO version column
// (mirrors knowledge_edge — the mistake_variant table has none).
//
// GATHER STRATEGY (design §2④, A4-adjusted): Q1 (subject_kind='mistake_variant' AND
// subject_id=mvId → the base create/genesis event) gives the proposal_event_id off the base
// snapshot; then the caused_by chain (rate / correct / experimental:variant_verify whose
// caused_by_event_id = that proposal_event_id) gives accept/dismiss/verify/retract. NO Q2 reverse
// index (mvId == createId()-preallocated subject_id) and NO Q3 merge-into.

// The verify event payload — we read only the verdict + failure_reasons the broken-flip needs
// (focused parse, mirrors goal's CorrectionPayload: validate the fields the branch consumes, not
// the whole envelope, so the reducer is robust to the verify event's many other payload keys).
const VariantVerifyPayload = z.object({
  verdict: z.enum(['pass', 'fail']),
  failure_reasons: z.array(z.string()).optional(),
});

// The retract correct event — read only correction_kind (focused parse, mirrors foldGoal).
const CorrectionPayload = z.object({
  correction_kind: z.string(),
});

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors
// foldGoal.toParseInput). The base-event branches feed this to their dedicated schema so a
// malformed base payload is rejected at the reducer boundary rather than trusted.
function toParseInput(fe: FoldEvent): unknown {
  return {
    actor_kind: fe.actor_kind,
    actor_ref: fe.actor_ref,
    action: fe.action,
    subject_kind: fe.subject_kind,
    subject_id: fe.subject_id,
    outcome: fe.outcome,
    payload: fe.payload,
    caused_by_event_id: fe.caused_by_event_id ?? undefined,
  };
}

// Stable (created_at asc, id asc) comparator — the canonical event read order (identical tiebreak
// to foldGoal / foldKnowledgeNode).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldMistakeVariant: skipping malformed event', {
    action,
    event_id: eventId,
    error,
  });
}

/**
 * Pure structural fold of a single `mistake_variant` row from the event log.
 *
 * @param mvId    the mistake_variant row id to project.
 * @param events  ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS which
 *                affect `mvId` — callers pass a superset (the IO shell narrows via the gather first,
 *                but the reducer must be correct on a superset too).
 * @returns the projected row, or `null` if `mvId` was never created/seeded.
 */
export function foldMistakeVariant(
  mvId: string,
  events: FoldEvent[],
): MistakeVariantRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: MistakeVariantRowSnapshotT | null = null;
  // The variant_question proposal event id this row was created from — read off the BASE event's
  // snapshot (proposal_event_id). The accept/verify/dismiss/retract events are chained to the
  // PROPOSAL (caused_by = proposalId), so we route them to this row via this id.
  let proposalId: string | null = null;

  for (const fe of ordered) {
    // ---------- BASE: experimental:mistake_variant_create (runtime creation, critic A4) ----------
    if (
      fe.action === 'experimental:mistake_variant_create' &&
      fe.subject_kind === 'mistake_variant'
    ) {
      // FIRST BASE WINS (self-defense, matching the file-header contract) — once a base has seeded
      // the row, a second base event is ignored. Today backfill scoping guarantees a create + a
      // genesis never coexist for the same id, so this is unreachable; the guard makes the reducer
      // robust if that invariant ever weakens (no silent re-seed clobbering the chain state).
      if (row !== null) continue;
      const c = MistakeVariantCreateExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:mistake_variant_create', fe.id, c.error);
        continue;
      }
      if (c.data.subject_id !== mvId) continue;
      row = {
        ...c.data.payload.row,
        failure_reasons: [...c.data.payload.row.failure_reasons],
      };
      proposalId = row.proposal_event_id;
      continue;
    }

    // ---------- BASE: experimental:genesis (backfill seed of a pre-W2 row) ----------
    if (fe.action === 'experimental:genesis' && fe.subject_kind === 'mistake_variant') {
      // FIRST BASE WINS (see the create branch above).
      if (row !== null) continue;
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      if (g.data.subject_id !== mvId) continue;
      const seed = MistakeVariantRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = { ...seed.data, failure_reasons: [...seed.data.failure_reasons] };
      proposalId = row.proposal_event_id;
      continue;
    }

    // From here on a base must exist + carry a proposal id (the chain is keyed by it).
    if (row === null || proposalId === null) continue;
    // The chain events are caused_by the PROPOSAL; ignore anything not chained to this row's proposal.
    if (fe.caused_by_event_id !== proposalId) continue;

    // ---------- E2 accept — rate(accept) → active + variant_question_id ----------
    if (fe.action === 'rate' && fe.subject_kind === 'event') {
      const payload = fe.payload as {
        rating?: unknown;
        materialized_question_id?: unknown;
      };
      if (payload.rating === 'accept') {
        row = {
          ...row,
          status: 'active',
          variant_question_id:
            typeof payload.materialized_question_id === 'string'
              ? payload.materialized_question_id
              : row.variant_question_id,
          updated_at: fe.created_at,
        };
        continue;
      }
      // ---------- E4 dismiss — rate(dismiss) → dismissed ----------
      if (payload.rating === 'dismiss') {
        row = { ...row, status: 'dismissed', updated_at: fe.created_at };
        continue;
      }
      continue;
    }

    // ---------- E3 verify — experimental:variant_verify, fail → broken / pass → touch ----------
    if (fe.action === 'experimental:variant_verify') {
      const v = VariantVerifyPayload.safeParse(fe.payload);
      if (!v.success) {
        warnMalformed('experimental:variant_verify', fe.id, v.error);
        continue;
      }
      if (v.data.verdict === 'fail') {
        row = {
          ...row,
          status: 'broken',
          failure_reasons: [...(v.data.failure_reasons ?? [])],
          updated_at: fe.created_at,
        };
      } else {
        // pass — touch updated_at only (mirrors variant_verify.ts:303-309).
        row = { ...row, updated_at: fe.created_at };
      }
      continue;
    }

    // ---------- E5 retract — correct(retract) → dismissed ----------
    if (fe.action === 'correct' && fe.subject_kind === 'event') {
      const cp = CorrectionPayload.safeParse(fe.payload);
      if (!cp.success || cp.data.correction_kind !== 'retract') continue;
      // STATUS GUARD (mirrors foldGoal:208 + the imperative writer's WHERE) — the imperative
      // retract (actions.ts retractAiProposal) guards BOTH its SELECT and UPDATE on
      // `inArray(status, ['draft','active'])`, so a terminal (broken | dismissed) row is NEVER
      // touched. retractAiProposal only requireProposal (not assertPending), so a retract event CAN
      // be written after a verify-FAIL (broken) or a dismiss (dismissed) — the fold must MIRROR the
      // imperative no-op (leave status + updated_at), else fold != row.
      if (row.status !== 'draft' && row.status !== 'active') continue;
      row = { ...row, status: 'dismissed', updated_at: fe.created_at };
    }
  }

  return row;
}
