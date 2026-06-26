import { describe, expect, it } from 'vitest';
import type { GoalRowSnapshotT } from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';
import { foldGoal } from './goal';

// ====================================================================
// foldGoal — pure goal reducer unit tests (YUK-471 Wave 2).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent. The
// reducer safeParses internally; passing plain objects matching the schema
// shapes exercises that path and keeps the test pure.
//
// VERSION SEMANTICS (critic B1 — mirror the historical imperative writes EXACTLY):
//   - insertGoal (accept.ts / goal-create.ts): does NOT set version → DB default 0.
//   - goal_scope accept rate: NO separate version bump (insertGoal stamped 0).
//   - retract (actions.ts:1047, bare UPDATE dormant): does NOT bump version.
//   - genesis: carries version verbatim from the snapshot.
//   - goal_status_update / goal_scope_update (updateGoalStatus/Scope): bump version +1.
// ====================================================================

let seq = 0;
function nextId(prefix = 'evt'): string {
  seq += 1;
  return `${prefix}_${seq.toString().padStart(4, '0')}`;
}

const T0 = new Date('2026-06-25T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// experimental:proposal / goal — the goal_scope propose event (writer.ts default branch).
// subject_id = goalId (target.subject_id reserved by runGoalScopeAndWrite).
function goalPropose(opts: {
  id?: string;
  created_at: Date;
  goalId: string;
  title: string;
  subjectId?: string | null;
  scope?: string[];
  sequenceHint?: number;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('propose'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'goal_scope',
    action: 'experimental:proposal',
    subject_kind: 'goal',
    subject_id: opts.goalId,
    outcome: 'partial',
    caused_by_event_id: null,
    payload: {
      ai_proposal: {
        kind: 'goal_scope',
        target: { subject_kind: 'goal', subject_id: opts.goalId },
        proposed_change: {
          title: opts.title,
          subject_id: opts.subjectId ?? null,
          scope_knowledge_ids: opts.scope ?? [],
          sequence_hint: opts.sequenceHint ?? 0,
        },
      },
    },
  };
}

// rate accept of a goal_scope proposal (accept.ts). subject_kind='event', caused_by=proposeId,
// payload.materialized_goal_id = goalId.
function rateAccept(opts: {
  id?: string;
  created_at: Date;
  causedBy: string;
  goalId: string;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('rate'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.causedBy,
    outcome: 'success',
    caused_by_event_id: opts.causedBy,
    payload: { rating: 'accept', materialized_goal_id: opts.goalId },
  };
}

// correct retract of a proposal (actions.ts retractAiProposal). subject_kind='event',
// caused_by=proposeId, payload.correction_kind='retract'.
function correctRetract(opts: { id?: string; created_at: Date; causedBy: string }): FoldEvent {
  return {
    id: opts.id ?? nextId('correct'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.causedBy,
    outcome: 'success',
    caused_by_event_id: opts.causedBy,
    payload: { correction_kind: 'retract', reason_md: 'retracted' },
  };
}

function genesis(opts: { created_at: Date; row: GoalRowSnapshotT }): FoldEvent {
  return {
    id: nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'goal',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

function statusUpdate(opts: {
  created_at: Date;
  goalId: string;
  status: 'active' | 'dormant' | 'done';
}): FoldEvent {
  return {
    id: nextId('status'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:goal_status_update',
    subject_kind: 'goal',
    subject_id: opts.goalId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { status: opts.status },
  };
}

function scopeUpdate(opts: {
  created_at: Date;
  goalId: string;
  patch: { title?: string; scope_knowledge_ids?: string[]; sequence_hint?: number };
}): FoldEvent {
  return {
    id: nextId('scope'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'goal_scope',
    action: 'experimental:goal_scope_update',
    subject_kind: 'goal',
    subject_id: opts.goalId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: opts.patch,
  };
}

function goalSnapshot(over: Partial<GoalRowSnapshotT> = {}): GoalRowSnapshotT {
  return {
    id: 'goal_1',
    title: 'Master derivatives',
    subject_id: 'subj_math',
    scope_knowledge_ids: ['k_a', 'k_b'],
    sequence_hint: 0,
    status: 'active',
    source: 'goal_scope_proposal',
    source_ref: 'evt_propose',
    created_at: T0,
    updated_at: T0,
    version: 0,
    ...over,
  };
}

describe('foldGoal — proposal + accept chain', () => {
  it('projects a goal materialized from a goal_scope proposal accept (status=active, version=0)', () => {
    const propose = goalPropose({
      created_at: at(0),
      goalId: 'goal_1',
      title: 'Master derivatives',
      subjectId: 'subj_math',
      scope: ['k_a', 'k_b'],
      sequenceHint: 3,
    });
    const accept = rateAccept({ created_at: at(1000), causedBy: propose.id, goalId: 'goal_1' });
    const row = foldGoal('goal_1', [propose, accept]);
    expect(row).not.toBeNull();
    expect(row?.id).toBe('goal_1');
    expect(row?.title).toBe('Master derivatives');
    expect(row?.subject_id).toBe('subj_math');
    expect(row?.scope_knowledge_ids).toEqual(['k_a', 'k_b']);
    expect(row?.sequence_hint).toBe(3);
    expect(row?.status).toBe('active');
    expect(row?.source).toBe('goal_scope_proposal');
    expect(row?.source_ref).toBe(propose.id);
    // accept-time stamps + NO version bump (insertGoal stamps version 0).
    expect(row?.created_at.getTime()).toBe(at(1000).getTime());
    expect(row?.updated_at.getTime()).toBe(at(1000).getTime());
    expect(row?.version).toBe(0);
  });

  it('returns null for a proposal that was never accepted (no row materialized)', () => {
    const propose = goalPropose({ created_at: at(0), goalId: 'goal_1', title: 'X' });
    expect(foldGoal('goal_1', [propose])).toBeNull();
  });

  it('applies retract → dormant, updated_at bumped, version UNCHANGED (mirrors bare UPDATE)', () => {
    const propose = goalPropose({
      created_at: at(0),
      goalId: 'goal_1',
      title: 'X',
      scope: ['k_a'],
    });
    const accept = rateAccept({ created_at: at(1000), causedBy: propose.id, goalId: 'goal_1' });
    const retract = correctRetract({ created_at: at(2000), causedBy: propose.id });
    const row = foldGoal('goal_1', [propose, accept, retract]);
    expect(row?.status).toBe('dormant');
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
    expect(row?.version).toBe(0); // retract does NOT bump version (actions.ts:1047)
  });
});

describe('foldGoal — genesis seed', () => {
  it('seeds the full row from genesis verbatim (incl version)', () => {
    const snap = goalSnapshot({ status: 'done', version: 4, sequence_hint: 7 });
    const row = foldGoal('goal_1', [genesis({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('returns null when no event seeds/creates the goal', () => {
    expect(foldGoal('goal_unknown', [])).toBeNull();
  });
});

describe('foldGoal — status/scope action events bump version', () => {
  it('applies a status update → status changes, version+1, updated_at=event time', () => {
    const snap = goalSnapshot({ status: 'active', version: 0 });
    const row = foldGoal('goal_1', [
      genesis({ created_at: at(0), row: snap }),
      statusUpdate({ created_at: at(5000), goalId: 'goal_1', status: 'done' }),
    ]);
    expect(row?.status).toBe('done');
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(5000).getTime());
  });

  it('applies a scope update → patched fields, version+1, untouched fields preserved', () => {
    const snap = goalSnapshot({
      title: 'Old',
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      version: 0,
    });
    const row = foldGoal('goal_1', [
      genesis({ created_at: at(0), row: snap }),
      scopeUpdate({
        created_at: at(5000),
        goalId: 'goal_1',
        patch: { title: 'New', sequence_hint: 9 },
      }),
    ]);
    expect(row?.title).toBe('New');
    expect(row?.sequence_hint).toBe(9);
    expect(row?.scope_knowledge_ids).toEqual(['k_a']); // not in patch → preserved
    expect(row?.subject_id).toBe('subj_math'); // set-once provenance, never mutated
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(5000).getTime());
  });

  it('applies two sequential status updates → version+2', () => {
    const snap = goalSnapshot({ status: 'active', version: 0 });
    const row = foldGoal('goal_1', [
      genesis({ created_at: at(0), row: snap }),
      statusUpdate({ created_at: at(5000), goalId: 'goal_1', status: 'dormant' }),
      statusUpdate({ created_at: at(6000), goalId: 'goal_1', status: 'active' }),
    ]);
    expect(row?.status).toBe('active');
    expect(row?.version).toBe(2);
  });
});

describe('foldGoal — isolation', () => {
  it('ignores events for other goal ids (superset input)', () => {
    const p1 = goalPropose({ created_at: at(0), goalId: 'goal_1', title: 'One', scope: ['k_a'] });
    const a1 = rateAccept({ created_at: at(1000), causedBy: p1.id, goalId: 'goal_1' });
    const p2 = goalPropose({ created_at: at(0), goalId: 'goal_2', title: 'Two' });
    const a2 = rateAccept({ created_at: at(1000), causedBy: p2.id, goalId: 'goal_2' });
    const row = foldGoal('goal_1', [p1, a1, p2, a2]);
    expect(row?.id).toBe('goal_1');
    expect(row?.title).toBe('One');
  });
});
