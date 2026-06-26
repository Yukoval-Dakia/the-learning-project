import { z } from 'zod';
import {
  GenesisExperimental,
  GoalRowSnapshot,
  type GoalRowSnapshotT,
} from '../schema/event/genesis';
import {
  GoalScopeUpdateExperimental,
  GoalStatusUpdateExperimental,
} from '../schema/event/goal-events';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldGoal — the W2 structural fold for a single `goal` row (YUK-471 Wave 2).
// PURE goal reducer.
// ====================================================================
//
// Projects the current structural state of ONE goal (`goalId`) from the event log, mirroring
// the W1 foldKnowledgeNode pattern. Instead of mutating the `goal` table in place, the
// goal_scope accept path appends events (proposal → rate(accept)), the proposal retract appends
// a correct event, and the status/scope helpers append the W2 action events — and this fold
// REPRODUCES the row the imperative writers (insertGoal / the retract UPDATE /
// updateGoalStatus / updateGoalScope) would have written.
//
// PURITY CONTRACT (identical to W1): no IO, no DB, no newId(), no Date.now() / new Date(). Same
// input → byte-identical output. The reducer NEVER mints ids or timestamps — it reads the goal
// id off the proposal's subject_id / the accept rate's payload.materialized_goal_id and stamps
// row timestamps from the relevant event's `created_at`. Determinism is what makes
// fold(events) == row a checkable invariant.
//
// GATHER STRATEGY (design §1④): Q1 (subject_kind='goal' AND subject_id=goalId — genesis,
// proposal, the W2 status/scope action events) + caused_by chain (the accept `rate` and the
// retract `correct`, both subject_kind='event', caused_by = the proposal id). NO Q2 reverse
// index (goalId == proposal.target.subject_id, so the goal id IS the proposal's subject_id —
// no minting indirection) and NO Q3 merge-into.
//
// VERSION SEMANTICS (critic B1 — MIRROR the historical imperative writes EXACTLY, per-site;
// do NOT apply a blanket +1):
//   - genesis seed:               version carried VERBATIM from the snapshot.
//   - proposal accept (insertGoal): version 0 (insertGoal does NOT set version → DB default 0).
//   - retract (actions.ts:1047, bare UPDATE dormant): NO version bump (status→dormant + updated_at only).
//   - goal_status_update (updateGoalStatus, queries.ts:77): version +1.
//   - goal_scope_update  (updateGoalScope,  queries.ts:106): version +1.
// (updateGoalStatus/Scope have no live caller TODAY; the events + reducer model their transition
// so the path is fold-complete the moment a caller is wired — defer-flip-not-build.)

// The goal_scope proposal carries the proposed change under payload.ai_proposal.proposed_change
// (writer.ts default branch wraps the AiProposal payload). We read only the structural fields
// the goal materialization consumes; the loose parse mirrors W1's per-branch focused parse.
const GoalProposedChange = z.object({
  title: z.string().optional(),
  subject_id: z.string().nullable().optional(),
  scope_knowledge_ids: z.array(z.string()).optional(),
  sequence_hint: z.number().optional(),
});

// The retract correct event — we read only correction_kind (focused parse, mirrors W1's
// KnowledgeArchivePayload approach: validate the field the branch needs, not the whole envelope,
// so the reducer is robust to optional envelope fields like affected_refs).
const CorrectionPayload = z.object({
  correction_kind: z.string(),
});

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors
// foldKnowledgeNode.toParseInput). Each per-branch safeParse feeds this to its dedicated schema
// so a malformed payload is rejected at the reducer boundary rather than trusted.
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

// Stable (created_at asc, id asc) comparator — the canonical event read order (identical
// tiebreak to foldKnowledgeNode).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldGoal: skipping malformed event', { action, event_id: eventId, error });
}

/**
 * Pure structural fold of a single `goal` row from the event log.
 *
 * @param goalId  the goal row id to project
 * @param events  ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS
 *                which affect `goalId` — callers pass a superset (the IO shell narrows via the
 *                gather first, but the reducer must be correct on a superset too).
 * @returns the projected row, or `null` if `goalId` was never created/seeded.
 */
export function foldGoal(goalId: string, events: FoldEvent[]): GoalRowSnapshotT | null {
  // A4 (augment) — sort the events ONCE up front so BOTH passes read the canonical
  // (created_at asc, id asc) order. Pass 1 previously iterated the RAW unsorted `events`, so a
  // duplicate / retried accept `rate` (same caused_by propose id) resolved order-dependently
  // (Map.set last-write wins by ARRAY position, not event order) → a non-deterministic fold.
  // Iterating `ordered` makes the picked accept deterministic (last-by-sorted-order), keeping the
  // reducer a pure function of the event SET (not its arrival order).
  const ordered = [...events].sort(byCreatedThenId);

  // ---------- pass 1: accept resolution index ----------
  //
  // A goal_scope proposal materializes the goal ONLY if its propose event was ACCEPTED — a
  // `rate` event with payload.rating==='accept' whose caused_by_event_id names the propose
  // event. dismiss / no-rate → no row. We capture that accept's created_at (the materialization
  // moment, used to stamp the row) + the materialized_goal_id, keyed by the propose event id.
  // The retract `correct` is NOT pre-resolved here — it is applied as an ORDERED event in pass
  // 2 (so a status/scope update that lands between accept and retract folds in the right
  // chronological order), routed to the goal via the propose id it is caused_by.
  const acceptedAtByProposeId = new Map<string, Date>();
  const materializedGoalByProposeId = new Map<string, string>();

  for (const fe of ordered) {
    if (fe.action !== 'rate' || fe.subject_kind !== 'event') continue;
    const payload = fe.payload as { rating?: unknown; materialized_goal_id?: unknown };
    if (payload.rating !== 'accept') continue;
    const proposeId = fe.caused_by_event_id;
    if (!proposeId) continue;
    acceptedAtByProposeId.set(proposeId, fe.created_at);
    if (typeof payload.materialized_goal_id === 'string') {
      materializedGoalByProposeId.set(proposeId, payload.materialized_goal_id);
    }
  }

  // ---------- pass 2: apply in (created_at asc, id asc) order ----------
  // (`ordered` was sorted once at the top of the fn — both passes share it; see A4.)
  let row: GoalRowSnapshotT | null = null;
  // The propose event id that materialized goalId (set when the proposal branch creates the
  // row) — used to route the retract `correct` event (whose subject is the proposal, not the
  // goal) to this goal.
  let materializingProposeId: string | null = null;

  for (const fe of ordered) {
    // genesis seed — the base state (version, timestamps and all carried verbatim).
    if (fe.action === 'experimental:genesis' && fe.subject_kind === 'goal') {
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      if (g.data.subject_id !== goalId) continue;
      const seed = GoalRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = { ...seed.data, scope_knowledge_ids: [...seed.data.scope_knowledge_ids] };
      continue;
    }

    // proposal materialization — a goal_scope `experimental:proposal` whose subject_id is the
    // goal id. CREATE the row from the proposed_change ONLY if accepted (acceptedAt present)
    // AND the accept's materialized_goal_id matches goalId. status='active', source +
    // source_ref provenance mirror insertGoal in accept.ts; timestamps = the ACCEPT moment;
    // version 0 (insertGoal does NOT set version).
    if (
      fe.action === 'experimental:proposal' &&
      fe.subject_kind === 'goal' &&
      fe.subject_id === goalId
    ) {
      const acceptedAt = acceptedAtByProposeId.get(fe.id);
      if (!acceptedAt) continue; // un-accepted proposal → no row
      const materializedGoal = materializedGoalByProposeId.get(fe.id);
      // The materialized goal id MUST match (defensive: the accept names it; goalId == subject_id).
      if (materializedGoal !== undefined && materializedGoal !== goalId) continue;
      const aiProposal = (fe.payload as { ai_proposal?: { proposed_change?: unknown } })
        .ai_proposal;
      const pc = GoalProposedChange.safeParse(aiProposal?.proposed_change ?? {});
      if (!pc.success) {
        warnMalformed('experimental:proposal(goal)', fe.id, pc.error);
        continue;
      }
      row = {
        id: goalId,
        title: pc.data.title ?? '',
        subject_id: pc.data.subject_id ?? null,
        scope_knowledge_ids: [...(pc.data.scope_knowledge_ids ?? [])],
        sequence_hint:
          typeof pc.data.sequence_hint === 'number' && Number.isFinite(pc.data.sequence_hint)
            ? pc.data.sequence_hint
            : 0,
        status: 'active',
        source: 'goal_scope_proposal',
        source_ref: fe.id,
        created_at: acceptedAt,
        updated_at: acceptedAt,
        version: 0,
      };
      materializingProposeId = fe.id;
      continue;
    }

    // RETRACT — a proposal-level retract (correct, correction_kind='retract') chained to the
    // propose that materialized this goal tombstones it to 'dormant' (actions.ts:1043-1048),
    // stamping updated_at = the retract moment WITHOUT a version bump. The correct event's
    // subject is the PROPOSAL (subject_kind='event', caused_by = propose id), so we route it to
    // the goal via materializingProposeId. Applied as an ORDERED event so it interleaves
    // correctly with any status/scope update.
    if (fe.action === 'correct' && fe.subject_kind === 'event') {
      if (row === null || materializingProposeId === null) continue;
      if (fe.caused_by_event_id !== materializingProposeId) continue;
      const cp = CorrectionPayload.safeParse(fe.payload);
      if (!cp.success || cp.data.correction_kind !== 'retract') continue;
      // Idempotent (mirrors the WHERE status='active' guard): only an active goal dormants.
      if (row.status !== 'active') continue;
      row = { ...row, status: 'dormant', updated_at: fe.created_at };
      continue;
    }

    // goal_status_update (W2) — status transition. Mirrors updateGoalStatus: status→new,
    // version+1, updated_at = event time. Requires an existing row (the helper no-ops if the
    // goal doesn't exist).
    if (
      fe.action === 'experimental:goal_status_update' &&
      fe.subject_kind === 'goal' &&
      fe.subject_id === goalId
    ) {
      if (row === null) continue;
      const s = GoalStatusUpdateExperimental.safeParse(toParseInput(fe));
      if (!s.success) {
        warnMalformed('experimental:goal_status_update', fe.id, s.error);
        continue;
      }
      row = {
        ...row,
        status: s.data.payload.status,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // goal_scope_update (W2) — re-scope (title / scope_knowledge_ids / sequence_hint patch).
    // Mirrors updateGoalScope: apply ONLY the provided fields, version+1, updated_at = event
    // time. source / subject_id are set-once provenance — NOT mutated here.
    if (
      fe.action === 'experimental:goal_scope_update' &&
      fe.subject_kind === 'goal' &&
      fe.subject_id === goalId
    ) {
      if (row === null) continue;
      const sc = GoalScopeUpdateExperimental.safeParse(toParseInput(fe));
      if (!sc.success) {
        warnMalformed('experimental:goal_scope_update', fe.id, sc.error);
        continue;
      }
      const patch = sc.data.payload;
      row = {
        ...row,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.scope_knowledge_ids !== undefined
          ? { scope_knowledge_ids: [...patch.scope_knowledge_ids] }
          : {}),
        ...(patch.sequence_hint !== undefined ? { sequence_hint: patch.sequence_hint } : {}),
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      // A5 — trailing continue for parity with every other branch: defends against a fall-through
      // if a new branch is appended after this (currently last) one. Biome flags it as unnecessary
      // TODAY precisely because it is the last branch — the suppression keeps the guard intentional.
      // biome-ignore lint/correctness/noUnnecessaryContinue: defensive — keeps every reducer branch uniformly terminated so appending a branch can't introduce silent fall-through.
      continue;
    }
  }

  return row;
}
