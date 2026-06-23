import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// GenesisExperimental parse-barrier tests (YUK-471 W1 PR-A1).
//
// parseEvent (Event.parse) routes `experimental:genesis` to the SPECIALISED
// GenesisExperimental schema, NOT the loose generic ExperimentalEvent fallback.
// These tests pin that routing + the schema's coherence superRefine, plus the
// RateEvent.payload.materialized_ids optionality keystone the fold relies on.
//
// The critical adversarial assertion is the malformed-payload case: if genesis
// fell through to the generic ExperimentalEvent (payload = arbitrary record), a
// malformed payload.row would PASS. We assert it THROWS — proving the dedicated
// typed branch is the one matching.
//
// No DB / no IO — pure schema parsing.
// ====================================================================

// A well-formed KnowledgeRowSnapshot (the structural subset, dates as ISO strings
// since the seed roundtrips through jsonb — z.coerce.date() accepts them).
function knowledgeRow(id = 'k_1') {
  return {
    id,
    name: 'Photosynthesis',
    domain: 'biology',
    parent_id: 'k_root',
    merged_from: [],
    archived_at: null,
    proposed_by_ai: false,
    approval_status: 'approved' as const,
    created_at: '2026-06-23T00:00:00.000Z',
    updated_at: '2026-06-23T00:00:00.000Z',
    version: 0,
  };
}

// A well-formed KnowledgeEdgeRowSnapshot (note: distinguished by from_knowledge_id;
// no `version` column on this table).
function edgeRow(id = 'edge_1') {
  return {
    id,
    from_knowledge_id: 'k_a',
    to_knowledge_id: 'k_b',
    relation_type: 'prerequisite',
    weight: 1,
    created_by: { actor_kind: 'system', actor_ref: 'seed' },
    reasoning: null,
    created_at: '2026-06-23T00:00:00.000Z',
    archived_at: null,
  };
}

function genesisEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'knowledge',
    subject_id: 'k_1',
    outcome: 'success',
    payload: { row: knowledgeRow('k_1') },
    ...over,
  };
}

describe('parseEvent — experimental:genesis routing + coherence', () => {
  it('ACCEPTS a well-formed genesis for a knowledge row', () => {
    const parsed: EventT = parseEvent(genesisEnvelope());
    // routed to the typed branch: subject_kind survives on parsed content
    expect((parsed as { action: string }).action).toBe('experimental:genesis');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('knowledge');
    expect((parsed as { subject_id: string }).subject_id).toBe('k_1');
  });

  it('ACCEPTS a well-formed genesis for a knowledge_edge row', () => {
    const parsed = parseEvent(
      genesisEnvelope({
        subject_kind: 'knowledge_edge',
        subject_id: 'edge_1',
        payload: { row: edgeRow('edge_1') },
      }),
    );
    expect((parsed as { subject_kind: string }).subject_kind).toBe('knowledge_edge');
    expect((parsed as { subject_id: string }).subject_id).toBe('edge_1');
  });

  it('REJECTS a bare `genesis` action (not experimental: prefixed)', () => {
    // `genesis` (no `experimental:` prefix) is not a KnownEvent action and not the
    // reserved experimental:genesis — it must not parse as a valid event.
    expect(() => parseEvent(genesisEnvelope({ action: 'genesis' }))).toThrow();
  });

  it('REJECTS a genesis with a MALFORMED payload.row (proves typed routing, not generic fallback)', () => {
    // Drop the required `name` from the knowledge row. If genesis fell through to
    // the generic ExperimentalEvent (payload = arbitrary record), this would PASS.
    // It must THROW — the typed GenesisExperimental branch is the one matching.
    const badRow = knowledgeRow('k_1') as Record<string, unknown>;
    badRow.name = undefined;
    expect(() => parseEvent(genesisEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS genesis where subject_kind=knowledge but payload.row is an EDGE row (superRefine)', () => {
    // subject_kind/row-shape mismatch must fail the coherence superRefine.
    expect(() =>
      parseEvent(
        genesisEnvelope({ subject_kind: 'knowledge', payload: { row: edgeRow('edge_1') } }),
      ),
    ).toThrow();
  });

  it('REJECTS genesis where subject_id !== payload.row.id (superRefine)', () => {
    // subject_id must name the same row the snapshot reproduces.
    expect(() =>
      parseEvent(
        genesisEnvelope({ subject_id: 'k_mismatch', payload: { row: knowledgeRow('k_1') } }),
      ),
    ).toThrow();
  });
});

describe('parseEvent — RateEvent.materialized_ids optionality', () => {
  function rateEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'evt_propose',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'evt_propose',
      ...over,
    };
  }

  it('ACCEPTS a rate event WITH materialized_ids', () => {
    const parsed = parseEvent(
      rateEnvelope({
        payload: { rating: 'accept', materialized_ids: { knowledge: ['k_new'] } },
      }),
    );
    expect((parsed as { action: string }).action).toBe('rate');
  });

  it('ACCEPTS a rate event WITHOUT materialized_ids (optional)', () => {
    const parsed = parseEvent(rateEnvelope({ payload: { rating: 'dismiss' } }));
    expect((parsed as { action: string }).action).toBe('rate');
  });
});
