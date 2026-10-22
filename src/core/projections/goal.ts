import { z } from 'zod';
import { resolveKnownSubjectId } from '@/subjects/profile';
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

// Pure goal reducer. genesis or an accepted goal_scope proposal seeds the row; retract
// tombstones it to dormant; status/scope updates bump version. Version changes mirror the
// imperative writers per site, not a blanket +1. No IO/ids/clocks, so events always fold
// to the same row. Gather is Q1 plus the caused_by accept/retract chain.

// Focused parse of the proposal's structural fields; the full AiProposal payload is not needed.
const GoalProposedChange = z.object({
  title: z.string().optional(),
  subject_id: z.string().nullable().optional(),
  scope_knowledge_ids: z.array(z.string()).optional(),
  sequence_hint: z.number().optional(),
});

// Validate only the field this branch consumes, not the whole correction envelope.
const CorrectionPayload = z.object({
  correction_kind: z.string(),
});

// Rebuild the parse input from the flat row so each branch validates its payload.
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
  console.warn('foldGoal: skipping malformed event', { action, event_id: eventId, error });
}

/** Project one goal from its events; callers may pass a superset. Null when no base exists. */
export function foldGoal(goalId: string, events: FoldEvent[]): GoalRowSnapshotT | null {
  // Sort once so both passes see event order, not arrival order; duplicate accepts
  // then resolve deterministically.
  const ordered = [...events].sort(byCreatedThenId);

  // ---------- pass 1: accept resolution ----------
  // Only an accepted propose materializes a goal. Capture the accept moment and id;
  // retract is applied in pass 2 so it interleaves chronologically.
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

  // ---------- pass 2: apply in canonical order ----------
  let row: GoalRowSnapshotT | null = null;
  // Routes the proposal-subject retract event back to this goal.
  let materializingProposeId: string | null = null;

  for (const fe of ordered) {
    // genesis seed — base state carried verbatim.
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
      row = {
        ...seed.data,
        scope_knowledge_ids: [...seed.data.scope_knowledge_ids],
        // Legacy genesis payloads predate these columns; default to the column default and
        // always materialize so parity compares a value on both sides.
        scope_mode: seed.data.scope_mode ?? 'explicit',
        declared_stage: seed.data.declared_stage ?? null,
      };
      continue;
    }

    // proposal materialization — accepted only; timestamps use the accept moment and
    // version stays 0, mirroring insertGoal.
    if (
      fe.action === 'experimental:proposal' &&
      fe.subject_kind === 'goal' &&
      fe.subject_id === goalId
    ) {
      const acceptedAt = acceptedAtByProposeId.get(fe.id);
      if (!acceptedAt) continue; // un-accepted proposal → no row
      const materializedGoal = materializedGoalByProposeId.get(fe.id);
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
        // Same normalization as the accept writer (alias→canonical, unknown→null) so
        // fold == row; replay can drift only if the subject row was hard-removed.
        subject_id: pc.data.subject_id ? resolveKnownSubjectId(pc.data.subject_id) : null,
        scope_knowledge_ids: [...(pc.data.scope_knowledge_ids ?? [])],
        // An accepted scope is an explicit user-confirmed selection, never live-derived.
        scope_mode: 'explicit',
        sequence_hint:
          typeof pc.data.sequence_hint === 'number' && Number.isFinite(pc.data.sequence_hint)
            ? pc.data.sequence_hint
            : 0,
        status: 'active',
        // The proposal carries no learner-declared stage; null means undeclared, not guessed.
        declared_stage: null,
        source: 'goal_scope_proposal',
        source_ref: fe.id,
        created_at: acceptedAt,
        updated_at: acceptedAt,
        version: 0,
      };
      materializingProposeId = fe.id;
      continue;
    }

    // RETRACT — proposal-level retract tombstones an active goal without a version bump.
    // Its subject is the proposal, so route it through materializingProposeId.
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

    // goal_status_update — mirrors updateGoalStatus: new status, version +1, event time.
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

    // goal_scope_update — apply only provided fields, version +1. Provenance is set once.
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
        // An explicit null clears the learner-declared stage; retract does not touch it.
        ...(patch.declared_stage !== undefined ? { declared_stage: patch.declared_stage } : {}),
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      // Keep every branch uniformly terminated so an appended branch cannot fall through.
      // biome-ignore lint/complexity/noUselessContinue: defensive — keeps every reducer branch uniformly terminated so appending a branch can't introduce silent fall-through.
      continue;
    }
  }

  return row;
}
