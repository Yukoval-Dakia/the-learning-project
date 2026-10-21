import { z } from 'zod';
import {
  GenesisExperimental,
  MistakeVariantRowSnapshot,
  type MistakeVariantRowSnapshotT,
} from '../schema/event/genesis';
import { MistakeVariantCreateExperimental } from '../schema/event/mistake-variant-events';
import type { FoldEvent } from './fold-event';

// Pure mistake_variant reducer. Base is the runtime create or the backfill genesis, first
// one wins; both snapshot the whole row because cause_category is fold-blind — no downstream
// event carries it. The accept/verify/dismiss/retract chain is keyed by the base's proposal id.
//
// No IO, ids, or clocks; updated_at is the last applied event time, and the table has no
// version column. Gather is Q1 for the base plus its caused_by chain.

// Focused parse: only the fields the broken-flip consumes are required.
const VariantVerifyPayload = z.object({
  verdict: z.enum(['pass', 'fail']),
  failure_reasons: z.array(z.string()).optional(),
});

// Focused parse: only correction_kind is consumed.
const CorrectionPayload = z.object({
  correction_kind: z.string(),
});

// Rebuild the parse input from the flat row so each base branch validates its payload.
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

// Canonical event order, shared by the sibling reducers.
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

/** Project one variant; callers may pass a superset. Null when no base exists. */
export function foldMistakeVariant(
  mvId: string,
  events: FoldEvent[],
): MistakeVariantRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: MistakeVariantRowSnapshotT | null = null;
  // Chain events point at the proposal, not this row; route them through this id.
  let proposalId: string | null = null;

  for (const fe of ordered) {
    // ---------- BASE: mistake_variant_create — runtime creation ----------
    if (
      fe.action === 'experimental:mistake_variant_create' &&
      fe.subject_kind === 'mistake_variant'
    ) {
      // First base wins; a duplicate must not clobber the chain state.
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

    // Chain events must belong to this row's proposal.
    if (row === null || proposalId === null) continue;
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
      // The imperative retract guards both SELECT and UPDATE on draft/active, so a terminal
      // row must stay untouched even if a retract event was written after verify/dismiss.
      if (row.status !== 'draft' && row.status !== 'active') continue;
      row = { ...row, status: 'dismissed', updated_at: fe.created_at };
      // biome-ignore lint/complexity/noUselessContinue: defensive — guards a future appended branch
      continue;
    }
  }

  return row;
}
