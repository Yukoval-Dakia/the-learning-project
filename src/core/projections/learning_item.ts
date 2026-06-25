import {
  GenesisExperimental,
  LearningItemRowSnapshot,
  type LearningItemRowSnapshotT,
} from '../schema/event/genesis';
import {
  LearningItemArchiveExperimental,
  LearningItemCompleteExperimental,
  LearningItemRelearnExperimental,
} from '../schema/event/learning-item-events';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldLearningItem — the W2 structural fold for a single `learning_item` row (YUK-471 Wave 2).
// PURE learning_item reducer. The entity with the MOST EXCLUDED columns of the W2 trio.
// ====================================================================
//
// Projects the current structural state of ONE learning_item (`itemId`) from the event log,
// mirroring the W1 foldKnowledgeNode / W2 foldGoal / foldMistakeVariant patterns. Instead of
// mutating the `learning_item` table in place, the INSERT sites append a per-id
// experimental:genesis BASE event, completion appends an experimental:learning_item_complete,
// relearn appends an experimental:learning_item_relearn, and retract/archive appends an
// experimental:learning_item_archive — and this fold REPRODUCES the row the imperative writers
// (the learning_intent / ai_dream INSERTs / the complete-relearn-archive UPDATEs) would have
// written.
//
// ── BASE = genesis only (design §3②/§3⑥) ─────────────────────────────────────────────────────
// Unlike mistake_variant (which needs a dedicated runtime create event to carry the fold-blind
// cause_category, critic A4), learning_item has NO fold-blind field — the genesis snapshot fully
// seeds the row. So the INSERT sites write a per-id experimental:genesis as the BASE event (NOT a
// dedicated create event), and the reducer treats genesis as the sole seed. Each learning_item id
// (hub + each child) folds INDEPENDENTLY: child_learning_item_ids is EXCLUDED from the snapshot
// (the tree is read via parent_learning_item_id, never the child array), so the hub never depends
// on child state; parent_learning_item_id is just a snapshot field genesis carries verbatim and no
// event mutates.
//
// PURITY CONTRACT (identical to W1/goal/mistake_variant): no IO, no DB, no newId(), no Date.now() /
// new Date(). Same input → byte-identical output. The reducer NEVER mints ids or timestamps — it
// stamps completed_at / archived_at / updated_at from the relevant event's `created_at`.
//
// GATHER STRATEGY (design §3④): Q1 ONLY (subject_kind='learning_item' AND subject_id=itemId →
// genesis + the W2 complete/relearn/archive action events). NO caused_by chain (the recommended
// route writes dedicated subject-keyed action events, so the status transitions are fold-visible
// via Q1 — no rate-payload `materialized_learning_item_id` side-channel reverse-lookup), NO Q2
// reverse index (itemId == genesis subject_id), NO Q3 merge-into.
//
// VERSION SEMANTICS (critic B1 — MIRROR the historical imperative writes EXACTLY, per-site):
//   - genesis seed (INSERT sites):  version carried VERBATIM from the snapshot (the INSERT default 0).
//   - complete (proposal-appliers.ts): version +1 (the imperative UPDATE sets version=item.version+1).
//   - relearn  (proposal-appliers.ts): version +1 (the imperative UPDATE sets version=item.version+1).
//   - archive/retract (actions.ts learning_item block, bare UPDATE archived_at + archived_reason +
//     updated_at): NO version bump — the reducer MIRRORS that (behaviour-preserving; §7.7 flags a
//     version-unification question as a follow-up, NOT changed in this lane).
//
// TERMINAL-STATUS GUARD (mistake_variant BLOCKER lesson): each transition applies ONLY when the row
// matches the imperative writer's WHERE; otherwise it is a no-op (continue):
//   - complete: imperative WHERE status IN (pending, in_progress) — else conflict (never UPDATEd).
//   - relearn:  imperative WHERE status IN (done, resting)        — else conflict (never UPDATEd).
//   - archive:  imperative WHERE archived_at IS NULL              — already-archived stays put.

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors
// foldGoal.toParseInput). Each per-branch safeParse feeds this to its dedicated schema so a
// malformed payload is rejected at the reducer boundary rather than trusted.
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
// to foldGoal / foldMistakeVariant / foldKnowledgeNode).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldLearningItem: skipping malformed event', { action, event_id: eventId, error });
}

/**
 * Pure structural fold of a single `learning_item` row from the event log.
 *
 * @param itemId  the learning_item row id to project.
 * @param events  ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS which
 *                affect `itemId` — callers pass a superset (the IO shell narrows via the gather
 *                first, but the reducer must be correct on a superset too).
 * @returns the projected row, or `null` if `itemId` was never created/seeded.
 */
export function foldLearningItem(
  itemId: string,
  events: FoldEvent[],
): LearningItemRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: LearningItemRowSnapshotT | null = null;

  for (const fe of ordered) {
    // ---------- BASE: experimental:genesis (the sole seed; design §3②/§3⑥) ----------
    if (fe.action === 'experimental:genesis' && fe.subject_kind === 'learning_item') {
      // FIRST BASE WINS (self-defense, matching the sibling reducers) — once a base has seeded the
      // row, a second genesis is ignored. Backfill scoping guarantees one genesis per id, so this
      // is unreachable today; the guard keeps the reducer robust if that invariant ever weakens.
      if (row !== null) continue;
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      if (g.data.subject_id !== itemId) continue;
      const seed = LearningItemRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = { ...seed.data, knowledge_ids: [...seed.data.knowledge_ids] };
      continue;
    }

    // From here on a base must exist (the action events mutate an already-seeded row).
    if (row === null) continue;

    // ---------- complete — status→done, completed_at=event time, version+1 ----------
    // Mirrors acceptCompletionProposal (proposal-appliers.ts): the imperative pre-check SELECT is
    // WHERE id=itemId AND archived_at IS NULL, then asserts status IN (pending,in_progress). The
    // reducer applies it ONLY when the row matches that FULL WHERE; any other status OR an archived
    // row is a no-op (terminal-status guard — the imperative writer would have 404'd on an archived
    // row or 409'd on a wrong status, never UPDATEd, so the fold must leave the row).
    if (
      fe.action === 'experimental:learning_item_complete' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const c = LearningItemCompleteExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:learning_item_complete', fe.id, c.error);
        continue;
      }
      // FULL imperative WHERE mirror: status IN (pending,in_progress) AND archived_at IS NULL
      // (proposal-appliers.ts SELECT guards isNull(archived_at) before the status assert). live path
      // 404s before any UPDATE on an archived row, so this never diverges live — it just makes the
      // reducer an exact mirror (review #3).
      if ((row.status !== 'pending' && row.status !== 'in_progress') || row.archived_at !== null) {
        continue;
      }
      row = {
        ...row,
        status: 'done',
        completed_at: fe.created_at,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // ---------- relearn — status→in_progress, completed_at=null, version+1 ----------
    // Mirrors acceptRelearnProposal (proposal-appliers.ts): the imperative pre-check SELECT is
    // WHERE id=itemId AND archived_at IS NULL, then asserts status IN (done, resting). The reducer
    // applies it ONLY when the row matches that FULL WHERE; any other status OR an archived row is a
    // no-op (terminal-status guard). completed_at=null is a structural reset (a relearn-retract
    // synthetic clock cannot restore the original complete time — the fold accepts null).
    if (
      fe.action === 'experimental:learning_item_relearn' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const r = LearningItemRelearnExperimental.safeParse(toParseInput(fe));
      if (!r.success) {
        warnMalformed('experimental:learning_item_relearn', fe.id, r.error);
        continue;
      }
      // FULL imperative WHERE mirror: status IN (done,resting) AND archived_at IS NULL
      // (proposal-appliers.ts SELECT guards isNull(archived_at) before the status assert). live path
      // 404s before any UPDATE on an archived row, so this never diverges live (review #3).
      if ((row.status !== 'done' && row.status !== 'resting') || row.archived_at !== null) {
        continue;
      }
      row = {
        ...row,
        status: 'in_progress',
        completed_at: null,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // ---------- archive — archived_at=event time, archived_reason, updated_at, NO version bump ----------
    // Mirrors the actions.ts learning_item retract block (bare UPDATE archived_at + archived_reason
    // + updated_at; WHERE archived_at IS NULL). The reducer applies it ONLY when archived_at IS NULL
    // (the imperative writer's WHERE — terminal-status guard); an already-archived row is a no-op so
    // a second archive doesn't bump archived_at/archived_reason (matching the idempotent retract).
    if (
      fe.action === 'experimental:learning_item_archive' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const a = LearningItemArchiveExperimental.safeParse(toParseInput(fe));
      if (!a.success) {
        warnMalformed('experimental:learning_item_archive', fe.id, a.error);
        continue;
      }
      if (row.archived_at !== null) continue;
      row = {
        ...row,
        archived_at: fe.created_at,
        archived_reason: a.data.payload.reason,
        updated_at: fe.created_at,
      };
    }
  }

  return row;
}
