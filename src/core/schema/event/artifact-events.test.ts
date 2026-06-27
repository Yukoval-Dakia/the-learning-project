import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// artifact action-event parse-barrier tests (YUK-471 Wave 3, design §3 + §10 B5).
//
// parseEvent (Event.parse) routes the three artifact action events to their dedicated typed
// schemas (./artifact-events.ts), NOT the loose generic ExperimentalEvent fallback:
//   - experimental:body_blocks_edit   (#2 full-snapshot body edit)
//   - experimental:artifact_create    (#3 runtime creation BASE, carries full ArtifactRowSnapshot)
//   - experimental:artifact_lifecycle (#4 archive/unarchive + generation/verification status)
// The fold trusts these as ground truth (body_blocks LAST-WRITE-WINS, version monotonic), so a
// malformed payload silently falling through to the generic record would corrupt the projection.
// Honest-reject (§10 B5): wrong shape / missing required field / subject_kind mismatch /
// subject_id != row.id must THROW at the barrier.
//
// No DB / no IO — pure schema parsing.
// ====================================================================

// A well-formed ArtifactRowSnapshot (dates as ISO strings — z.coerce.date() accepts them).
function artifactRow(id = 'art_1', over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'note',
    title: 'Photosynthesis note',
    parent_artifact_id: null,
    knowledge_ids: ['k_a'],
    intent_source: 'learning_intent',
    source: 'note_generate',
    source_ref: 'evt_propose',
    body_blocks: { type: 'doc', content: [] },
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'not_required',
    verification_summary: null,
    generated_by: { by: 'ai', task_kind: 'note_generate' },
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
    version: 0,
    ...over,
  };
}

// ---------- #2 experimental:body_blocks_edit ----------

function bodyEditEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'user',
    actor_ref: 'artifact_block_tree_editor',
    action: 'experimental:body_blocks_edit',
    subject_kind: 'artifact',
    subject_id: 'art_1',
    outcome: 'success',
    payload: {
      previous_artifact_version: 0,
      next_artifact_version: 1,
      body_blocks: { type: 'doc', content: [{ type: 'paragraph' }] },
      previous_body_blocks: { type: 'doc', content: [] },
      history_after: [{ version: 1, at: '2026-06-26T00:00:00.000Z' }],
    },
    ...over,
  };
}

describe('parseEvent — experimental:body_blocks_edit routing + coherence', () => {
  it('ACCEPTS a well-formed body_blocks_edit (carries AFTER body + previous + history)', () => {
    const parsed: EventT = parseEvent(bodyEditEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:body_blocks_edit');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('artifact');
    expect((parsed as { subject_id: string }).subject_id).toBe('art_1');
  });

  it('ACCEPTS a cold first write (previous_body_blocks = null)', () => {
    const parsed = parseEvent(
      bodyEditEnvelope({
        payload: {
          previous_artifact_version: 0,
          next_artifact_version: 1,
          body_blocks: { type: 'doc', content: [] },
          previous_body_blocks: null,
          history_after: [],
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:body_blocks_edit');
  });

  it('REJECTS a body_blocks_edit MISSING the body_blocks snapshot (the F1/#2 core gap)', () => {
    expect(() =>
      parseEvent(
        bodyEditEnvelope({
          payload: {
            previous_artifact_version: 0,
            next_artifact_version: 1,
            previous_body_blocks: null,
            history_after: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a body_blocks_edit with a malformed body_blocks (wrong doc type literal)', () => {
    expect(() =>
      parseEvent(
        bodyEditEnvelope({
          payload: {
            previous_artifact_version: 0,
            next_artifact_version: 1,
            body_blocks: { type: 'not_doc', content: [] },
            previous_body_blocks: null,
            history_after: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a non-advancing version (next <= previous, superRefine)', () => {
    expect(() =>
      parseEvent(
        bodyEditEnvelope({
          payload: {
            previous_artifact_version: 3,
            next_artifact_version: 3,
            body_blocks: { type: 'doc', content: [] },
            previous_body_blocks: null,
            history_after: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS an unknown payload key (.strict())', () => {
    expect(() =>
      parseEvent(
        bodyEditEnvelope({
          payload: {
            previous_artifact_version: 0,
            next_artifact_version: 1,
            body_blocks: { type: 'doc', content: [] },
            previous_body_blocks: null,
            history_after: [],
            bogus_extra: 'nope',
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the body_blocks_edit action', () => {
    expect(() => parseEvent(bodyEditEnvelope({ subject_kind: 'question' }))).toThrow();
  });
});

// ---------- #3 experimental:artifact_create ----------

function createEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'agent',
    actor_ref: 'note_generate',
    action: 'experimental:artifact_create',
    subject_kind: 'artifact',
    subject_id: 'art_1',
    outcome: 'success',
    payload: { row: artifactRow('art_1') },
    ...over,
  };
}

describe('parseEvent — experimental:artifact_create routing + coherence', () => {
  it('ACCEPTS a well-formed create event (carries the full initial row snapshot)', () => {
    const parsed: EventT = parseEvent(createEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:artifact_create');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('artifact');
  });

  it('ACCEPTS a create with a NULL body_blocks (e.g. a tool_quiz artifact)', () => {
    const parsed = parseEvent(
      createEnvelope({
        payload: { row: artifactRow('art_1', { type: 'tool_quiz', body_blocks: null }) },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_create');
  });

  it('REJECTS a create whose payload.row is missing intent_source (the notNull column)', () => {
    const badRow = artifactRow('art_1') as Record<string, unknown>;
    badRow.intent_source = undefined;
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS a create where subject_id !== payload.row.id (superRefine)', () => {
    expect(() =>
      parseEvent(
        createEnvelope({ subject_id: 'art_other', payload: { row: artifactRow('art_1') } }),
      ),
    ).toThrow();
  });

  it('REJECTS a create with an EXTRA unknown field in the row (.strict(), critic B3)', () => {
    const badRow = artifactRow('art_1') as Record<string, unknown>;
    badRow.bogus_extra = 'nope';
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS a wrong subject_kind for the create action', () => {
    expect(() => parseEvent(createEnvelope({ subject_kind: 'goal' }))).toThrow();
  });
});

// ---------- #4 experimental:artifact_lifecycle ----------

function lifecycleEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:artifact_lifecycle',
    subject_kind: 'artifact',
    subject_id: 'art_1',
    outcome: 'success',
    payload: { op: 'archive', archived_at: '2026-06-26T00:00:00.000Z', next_version: 1 },
    ...over,
  };
}

describe('parseEvent — experimental:artifact_lifecycle routing + coherence', () => {
  it('ACCEPTS a well-formed archive', () => {
    const parsed: EventT = parseEvent(lifecycleEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('ACCEPTS an unarchive (archived_at = null)', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({ payload: { op: 'unarchive', archived_at: null, next_version: 2 } }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('ACCEPTS a set_generation_status carrying the new status', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({
        payload: { op: 'set_generation_status', generation_status: 'failed', next_version: 1 },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('ACCEPTS a set_verification_status carrying a verification_summary', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({
        payload: {
          op: 'set_verification_status',
          verification_status: 'needs_review',
          verification_summary: {
            verdict: 'needs_review',
            summary_md: 'Two factual issues.',
            issues: [],
            confidence: 0.6,
          },
          next_version: 1,
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('REJECTS an unknown op value', () => {
    expect(() =>
      parseEvent(lifecycleEnvelope({ payload: { op: 'delete', next_version: 1 } })),
    ).toThrow();
  });

  it('REJECTS set_generation_status with NO generation_status (op→field coupling, superRefine)', () => {
    expect(() =>
      parseEvent(lifecycleEnvelope({ payload: { op: 'set_generation_status', next_version: 1 } })),
    ).toThrow();
  });

  it('REJECTS set_verification_status with an EMPTY verification_status (superRefine)', () => {
    expect(() =>
      parseEvent(
        lifecycleEnvelope({
          payload: { op: 'set_verification_status', verification_status: '', next_version: 1 },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS archive with NO archived_at (op→field coupling, superRefine)', () => {
    expect(() =>
      parseEvent(lifecycleEnvelope({ payload: { op: 'archive', next_version: 1 } })),
    ).toThrow();
  });

  it('REJECTS unarchive carrying a non-null archived_at (op→field coupling, superRefine)', () => {
    expect(() =>
      parseEvent(
        lifecycleEnvelope({
          payload: { op: 'unarchive', archived_at: '2026-06-26T00:00:00.000Z', next_version: 2 },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a missing next_version', () => {
    expect(() =>
      parseEvent(lifecycleEnvelope({ payload: { op: 'archive', archived_at: null } })),
    ).toThrow();
  });

  it('REJECTS an unknown payload key (.strict())', () => {
    expect(() =>
      parseEvent(
        lifecycleEnvelope({ payload: { op: 'archive', next_version: 1, bogus_extra: 'nope' } }),
      ),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the lifecycle action', () => {
    expect(() => parseEvent(lifecycleEnvelope({ subject_kind: 'event' }))).toThrow();
  });

  // ---------- W3-C1γ — set_attrs op + provenance/history superset fields ----------

  it('ACCEPTS a set_attrs carrying the new attrs object', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({
        payload: {
          op: 'set_attrs',
          attrs: { suppressed_block_refs: [{ artifact_id: 'art_x' }] },
          next_version: 3,
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('REJECTS a set_attrs MISSING attrs (op→field coupling, superRefine)', () => {
    expect(() =>
      parseEvent(lifecycleEnvelope({ payload: { op: 'set_attrs', next_version: 3 } })),
    ).toThrow();
  });

  it('ACCEPTS a set_generation_status carrying verification_status + generated_by (note_generate)', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({
        actor_kind: 'agent',
        actor_ref: 'note_generate',
        payload: {
          op: 'set_generation_status',
          generation_status: 'ready',
          verification_status: 'queued',
          generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' },
          next_version: 1,
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });

  it('ACCEPTS a set_attrs carrying history_after (updateArtifactTool pushes a history entry)', () => {
    const parsed = parseEvent(
      lifecycleEnvelope({
        payload: {
          op: 'set_attrs',
          attrs: { format: 'html', html: '<p>v1</p>' },
          history_after: [{ version: 1, at: '2026-06-26T00:00:00.000Z' }],
          next_version: 1,
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:artifact_lifecycle');
  });
});

// ---------- #4b experimental:note_refine_undo (W3-C1γ self-sufficient body restore) ----------

function undoEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:note_refine_undo',
    subject_kind: 'artifact',
    subject_id: 'art_1',
    outcome: 'success',
    payload: {
      artifact_id: 'art_1',
      undone_event_id: 'apply_1',
      restored_from_artifact_version: 1,
      restored_to_artifact_version: 2,
      source_previous_artifact_version: 0,
      body_blocks: { type: 'doc', content: [] },
      next_artifact_version: 2,
      history_after: [],
    },
    ...over,
  };
}

describe('parseEvent — experimental:note_refine_undo routing + back-compat', () => {
  it('ACCEPTS a well-formed self-sufficient undo (carries restored body + version + history)', () => {
    const parsed: EventT = parseEvent(undoEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:note_refine_undo');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('artifact');
  });

  it('ACCEPTS a LEGACY loose undo (bookkeeping only, no fold fields) — read-path back-compat', () => {
    const parsed = parseEvent(
      undoEnvelope({
        payload: {
          artifact_id: 'art_1',
          undone_event_id: 'apply_1',
          restored_from_artifact_version: 1,
          restored_to_artifact_version: 2,
          source_previous_artifact_version: 0,
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:note_refine_undo');
  });

  it('REJECTS a body_blocks carried WITHOUT next_artifact_version (superRefine)', () => {
    expect(() =>
      parseEvent(
        undoEnvelope({
          payload: {
            artifact_id: 'art_1',
            undone_event_id: 'apply_1',
            restored_from_artifact_version: 1,
            restored_to_artifact_version: 2,
            source_previous_artifact_version: 0,
            body_blocks: { type: 'doc', content: [] },
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS an unknown payload key (.strict())', () => {
    expect(() =>
      parseEvent(
        undoEnvelope({
          payload: {
            artifact_id: 'art_1',
            undone_event_id: 'apply_1',
            restored_from_artifact_version: 1,
            restored_to_artifact_version: 2,
            bogus_extra: 'nope',
          },
        }),
      ),
    ).toThrow();
  });

  // W3-C3 flip-gate hardening — the self-sufficiency DISCRIMINATOR. A NEW undo that signals
  // self-sufficiency (carries next_artifact_version OR history_after) MUST carry the restored body, or
  // the reducer would fold an undefined body and silently drop the restore. Old loose undos (no marker)
  // stay exempt (the read-path back-compat test above).
  it('REJECTS a self-sufficient undo carrying next_artifact_version but MISSING body_blocks (W3-C3 barrier)', () => {
    expect(() =>
      parseEvent(
        undoEnvelope({
          payload: {
            artifact_id: 'art_1',
            undone_event_id: 'apply_1',
            restored_from_artifact_version: 1,
            restored_to_artifact_version: 2,
            source_previous_artifact_version: 0,
            next_artifact_version: 2, // self-sufficiency marker present …
            // … but body_blocks ABSENT → reject (a non-self-sufficient new undo).
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a self-sufficient undo carrying history_after but MISSING body_blocks (W3-C3 barrier)', () => {
    expect(() =>
      parseEvent(
        undoEnvelope({
          payload: {
            artifact_id: 'art_1',
            undone_event_id: 'apply_1',
            restored_from_artifact_version: 1,
            restored_to_artifact_version: 2,
            source_previous_artifact_version: 0,
            history_after: [], // self-sufficiency marker present, body_blocks ABSENT → reject.
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the undo action', () => {
    expect(() => parseEvent(undoEnvelope({ subject_kind: 'question' }))).toThrow();
  });
});

// ====================================================================
// artifact genesis parse-barrier tests (W3-A1 — genesis backfill seed routing).
//
// Adding `artifact` to GenesisExperimental's subject_kind enum + SNAPSHOT_BY_SUBJECT_KIND +
// DISCRIMINATING_COLUMNS lets the W3-C2 backfill seed pre-W3 artifact rows. Honest-reject: a wrong
// row shape under subject_kind='artifact' / a sibling row lacking the discriminating columns /
// subject_id != row.id must THROW (not fall through to the generic ExperimentalEvent).
// ====================================================================

function genesisEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'artifact',
    subject_id: 'art_1',
    outcome: 'success',
    payload: { row: artifactRow('art_1') },
    ...over,
  };
}

describe('parseEvent — experimental:genesis artifact routing + coherence (W3)', () => {
  it('ACCEPTS a well-formed genesis for an artifact row', () => {
    const parsed = parseEvent(genesisEnvelope());
    expect((parsed as { subject_kind: string }).subject_kind).toBe('artifact');
    expect((parsed as { subject_id: string }).subject_id).toBe('art_1');
  });

  it('REJECTS an artifact genesis whose payload.row is a GOAL-ish row (wrong shape, superRefine)', () => {
    const goalish = {
      id: 'art_1',
      title: 'A goal title',
      subject_id: 'subj_math',
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'goal_scope_proposal',
      source_ref: 'evt_x',
      created_at: '2026-06-26T00:00:00.000Z',
      updated_at: '2026-06-26T00:00:00.000Z',
      version: 0,
    };
    expect(() => parseEvent(genesisEnvelope({ payload: { row: goalish } }))).toThrow();
  });

  it('REJECTS an artifact genesis MISSING the discriminating column intent_source', () => {
    const badRow = artifactRow('art_1') as Record<string, unknown>;
    badRow.intent_source = undefined;
    expect(() => parseEvent(genesisEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS an artifact genesis where subject_id !== payload.row.id (superRefine)', () => {
    expect(() =>
      parseEvent(
        genesisEnvelope({ subject_id: 'art_mismatch', payload: { row: artifactRow('art_1') } }),
      ),
    ).toThrow();
  });
});
