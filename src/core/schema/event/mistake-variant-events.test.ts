import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// mistake_variant create-event parse-barrier tests (YUK-471 Wave 2, critic A4 + B5).
//
// parseEvent (Event.parse) routes `experimental:mistake_variant_create` to the dedicated typed
// schema (./mistake-variant-events.ts), NOT the loose generic ExperimentalEvent fallback. The
// runtime creation BASE event carries the FULL initial row INCLUDING the fold-blind cause_category
// — the fold trusts it as ground truth, so a malformed payload silently falling through to the
// generic record would corrupt the projection. Honest-reject (critic B5): wrong shape /
// subject_id != row.id / extra .strict() field must THROW at the barrier.
//
// No DB / no IO — pure schema parsing.
// ====================================================================

// A well-formed MistakeVariantRowSnapshot (dates as ISO strings — z.coerce.date() accepts them).
function mvRow(id = 'mv_1', over: Record<string, unknown> = {}) {
  return {
    id,
    parent_question_id: 'q_parent',
    variant_question_id: null,
    proposal_event_id: 'evt_propose',
    status: 'draft' as const,
    failure_reasons: [],
    cause_category: 'concept_confusion',
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
    ...over,
  };
}

function createEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'agent',
    actor_ref: 'variant_gen',
    action: 'experimental:mistake_variant_create',
    subject_kind: 'mistake_variant',
    subject_id: 'mv_1',
    outcome: 'success',
    payload: { row: mvRow('mv_1') },
    ...over,
  };
}

describe('parseEvent — experimental:mistake_variant_create routing + coherence', () => {
  it('ACCEPTS a well-formed create event (carries the fold-blind cause_category)', () => {
    const parsed: EventT = parseEvent(createEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:mistake_variant_create');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('mistake_variant');
    expect((parsed as { subject_id: string }).subject_id).toBe('mv_1');
  });

  it('ACCEPTS a create with a NULL cause_category (uncategorized variant)', () => {
    const parsed = parseEvent(
      createEnvelope({ payload: { row: mvRow('mv_1', { cause_category: null }) } }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:mistake_variant_create');
  });

  it('REJECTS a create whose payload.row is missing parent_question_id (the notNull column)', () => {
    const badRow = mvRow('mv_1') as Record<string, unknown>;
    badRow.parent_question_id = undefined;
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS a create where subject_id !== payload.row.id (superRefine)', () => {
    expect(() =>
      parseEvent(createEnvelope({ subject_id: 'mv_mismatch', payload: { row: mvRow('mv_1') } })),
    ).toThrow();
  });

  it('REJECTS a create with an EXTRA unknown field in the row (.strict(), critic B3)', () => {
    const badRow = mvRow('mv_1') as Record<string, unknown>;
    badRow.bogus_extra = 'nope';
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS a create with an unknown status value (typed routing, not generic fallback)', () => {
    expect(() =>
      parseEvent(createEnvelope({ payload: { row: mvRow('mv_1', { status: 'archived' }) } })),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the create action', () => {
    expect(() => parseEvent(createEnvelope({ subject_kind: 'goal' }))).toThrow();
  });
});
