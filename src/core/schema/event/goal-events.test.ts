import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// Goal action-event parse-barrier tests (YUK-471 Wave 2).
//
// parseEvent (Event.parse) routes experimental:goal_status_update /
// experimental:goal_scope_update to their dedicated typed schemas
// (./goal-events.ts), NOT the loose generic ExperimentalEvent fallback. A
// malformed payload must THROW at the barrier — proving the typed branch matches
// (the fold trusts these to reproduce version/updated_at, so a malformed payload
// silently falling through to the generic record would corrupt the projection).
//
// No DB / no IO — pure schema parsing.
// ====================================================================

function statusEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:goal_status_update',
    subject_kind: 'goal',
    subject_id: 'goal_1',
    outcome: 'success',
    payload: { status: 'done' },
    ...over,
  };
}

function scopeEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'agent',
    actor_ref: 'goal_scope',
    action: 'experimental:goal_scope_update',
    subject_kind: 'goal',
    subject_id: 'goal_1',
    outcome: 'success',
    payload: { title: 'New title', scope_knowledge_ids: ['k_a'], sequence_hint: 2 },
    ...over,
  };
}

describe('parseEvent — experimental:goal_status_update routing', () => {
  it('ACCEPTS a well-formed status update', () => {
    const parsed: EventT = parseEvent(statusEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:goal_status_update');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('goal');
  });

  it('REJECTS an unknown status value (proves typed routing, not generic fallback)', () => {
    expect(() => parseEvent(statusEnvelope({ payload: { status: 'archived' } }))).toThrow();
  });

  it('REJECTS a missing status field', () => {
    expect(() => parseEvent(statusEnvelope({ payload: {} }))).toThrow();
  });

  it('REJECTS a wrong subject_kind', () => {
    expect(() => parseEvent(statusEnvelope({ subject_kind: 'event' }))).toThrow();
  });
});

describe('parseEvent — experimental:goal_scope_update routing', () => {
  it('ACCEPTS a well-formed scope update with all patch fields', () => {
    const parsed = parseEvent(scopeEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:goal_scope_update');
  });

  it('ACCEPTS a partial scope update (only sequence_hint)', () => {
    const parsed = parseEvent(scopeEnvelope({ payload: { sequence_hint: 5 } }));
    expect((parsed as { action: string }).action).toBe('experimental:goal_scope_update');
  });

  it('REJECTS an unknown patch key (.strict() — e.g. mutating set-once subject_id)', () => {
    expect(() => parseEvent(scopeEnvelope({ payload: { subject_id: 'subj_other' } }))).toThrow();
  });

  it('REJECTS a non-array scope_knowledge_ids', () => {
    expect(() =>
      parseEvent(scopeEnvelope({ payload: { scope_knowledge_ids: 'not-an-array' } })),
    ).toThrow();
  });
});
