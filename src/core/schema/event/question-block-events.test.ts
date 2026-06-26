import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// question_block action-event parse-barrier tests (YUK-471 Wave 3, design §3 #5/#6 + §10 B5).
//
// parseEvent (Event.parse) routes the two question_block action events to their dedicated typed
// schemas (./question-block-events.ts), NOT the loose generic ExperimentalEvent fallback:
//   - experimental:edit_question_block_structured (#5 — full AFTER snapshot per affected block; a
//     merge's 1+N job_events collapse to ONE canonical event with absorbed rows as merged_source,
//     NO merged_into)
//   - experimental:question_block_create          (#6 — OCR/rescue/docx/import creation BASE,
//     carries the full QuestionBlockRowSnapshot)
// The fold trusts these as ground truth (structured LAST-WRITE-WINS, version monotonic), so a
// malformed payload silently falling through to the generic record would corrupt the projection.
// Honest-reject (§10 B5): wrong shape / missing required field / subject_kind mismatch /
// subject_id != anchor / .strict() extra key (esp. a merged_into) must THROW at the barrier.
//
// No DB / no IO — pure schema parsing.
// ====================================================================

// A minimal well-formed StructuredQuestion (standalone leaf — valid with no sub_questions).
function structured(id = 'q1', over: Record<string, unknown> = {}) {
  return { id, role: 'standalone', prompt_text: 'What is 2 + 2?', ...over };
}

// A well-formed QuestionBlockRowSnapshot (dates as ISO strings — z.coerce.date() accepts them).
function questionBlockRow(id = 'blk_1', over: Record<string, unknown> = {}) {
  return {
    id,
    ingestion_session_id: 'sess_1',
    source_document_id: 'doc_1',
    source_asset_ids: ['asset_1'],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    structured: structured('q1'),
    figures: [],
    layout_quality: 'structured',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
    version: 0,
    ...over,
  };
}

// ---------- #5 experimental:edit_question_block_structured ----------

function primaryBlock(over: Record<string, unknown> = {}) {
  return {
    block_id: 'blk_1',
    role: 'primary',
    structured: structured('q1'),
    figures: [],
    version: 1,
    status: 'draft',
    ...over,
  };
}

function editEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'agent',
    actor_ref: 'question_block_structured_editor',
    action: 'experimental:edit_question_block_structured',
    subject_kind: 'question_block',
    subject_id: 'blk_1',
    outcome: 'success',
    payload: { op: 'update_prompt', affected_blocks: [primaryBlock()] },
    ...over,
  };
}

describe('parseEvent — experimental:edit_question_block_structured routing + coherence', () => {
  it('ACCEPTS a well-formed single-block edit (one primary, after-tree carried)', () => {
    const parsed: EventT = parseEvent(editEnvelope());
    expect((parsed as { action: string }).action).toBe(
      'experimental:edit_question_block_structured',
    );
    expect((parsed as { subject_kind: string }).subject_kind).toBe('question_block');
    expect((parsed as { subject_id: string }).subject_id).toBe('blk_1');
  });

  it('ACCEPTS a merge_questions multi-row after (primary + merged_source, NO merged_into)', () => {
    const parsed = parseEvent(
      editEnvelope({
        payload: {
          op: 'merge_questions',
          affected_blocks: [
            primaryBlock({ block_id: 'blk_1', version: 2 }),
            {
              block_id: 'blk_2',
              role: 'merged_source',
              structured: null,
              version: 1,
              status: 'ignored',
            },
          ],
        },
      }),
    );
    expect((parsed as { action: string }).action).toBe(
      'experimental:edit_question_block_structured',
    );
  });

  it('REJECTS reassign_figure (not a structured-edit op — separate figure.reassigned surface)', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          payload: { op: 'reassign_figure', affected_blocks: [primaryBlock()] },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS an empty affected_blocks (.min(1))', () => {
    expect(() =>
      parseEvent(editEnvelope({ payload: { op: 'update_prompt', affected_blocks: [] } })),
    ).toThrow();
  });

  it('REJECTS NO primary (a lone merged_source — no SoT anchor, superRefine)', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          subject_id: 'blk_2',
          payload: {
            op: 'update_prompt',
            affected_blocks: [
              {
                block_id: 'blk_2',
                role: 'merged_source',
                structured: null,
                version: 1,
                status: 'ignored',
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS TWO primaries (ambiguous after-tree, superRefine)', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          payload: {
            op: 'merge_questions',
            affected_blocks: [
              primaryBlock({ block_id: 'blk_1' }),
              primaryBlock({ block_id: 'blk_2' }),
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS subject_id != primary.block_id (SoT anchor mismatch, superRefine)', () => {
    expect(() => parseEvent(editEnvelope({ subject_id: 'blk_other' }))).toThrow();
  });

  it('REJECTS a null primary structured (the after-tree is required, superRefine)', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          payload: { op: 'update_prompt', affected_blocks: [primaryBlock({ structured: null })] },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a merged_into_block_id stray key in an affected_block (.strict(), A2)', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          payload: {
            op: 'merge_questions',
            affected_blocks: [
              primaryBlock({ block_id: 'blk_1' }),
              {
                block_id: 'blk_2',
                role: 'merged_source',
                structured: null,
                version: 1,
                status: 'ignored',
                merged_into_block_id: 'blk_1', // ★ no physical column — must be rejected
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS an unknown payload key (.strict())', () => {
    expect(() =>
      parseEvent(
        editEnvelope({
          payload: { op: 'update_prompt', affected_blocks: [primaryBlock()], bogus_extra: 'nope' },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS an unknown op value', () => {
    expect(() =>
      parseEvent(editEnvelope({ payload: { op: 'delete', affected_blocks: [primaryBlock()] } })),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the edit action', () => {
    expect(() => parseEvent(editEnvelope({ subject_kind: 'question' }))).toThrow();
  });
});

// ---------- #6 experimental:question_block_create ----------

function createEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'agent',
    actor_ref: 'ingestion',
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: 'blk_1',
    outcome: 'success',
    payload: { row: questionBlockRow('blk_1'), origin: 'ocr' },
    ...over,
  };
}

describe('parseEvent — experimental:question_block_create routing + coherence', () => {
  it('ACCEPTS a well-formed OCR create (carries the full initial row snapshot)', () => {
    const parsed: EventT = parseEvent(createEnvelope());
    expect((parsed as { action: string }).action).toBe('experimental:question_block_create');
    expect((parsed as { subject_kind: string }).subject_kind).toBe('question_block');
  });

  it('ACCEPTS a rescue create (origin=rescue — fold last-write-wins overwrite)', () => {
    const parsed = parseEvent(
      createEnvelope({ payload: { row: questionBlockRow('blk_1'), origin: 'rescue' } }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:question_block_create');
  });

  it('ACCEPTS a create with a NULL structured (an unstructured/raw block)', () => {
    const parsed = parseEvent(
      createEnvelope({
        payload: { row: questionBlockRow('blk_1', { structured: null }), origin: 'docx' },
      }),
    );
    expect((parsed as { action: string }).action).toBe('experimental:question_block_create');
  });

  it('REJECTS a create whose payload.row is missing ingestion_session_id (the notNull column)', () => {
    const badRow = questionBlockRow('blk_1') as Record<string, unknown>;
    badRow.ingestion_session_id = undefined;
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow, origin: 'ocr' } }))).toThrow();
  });

  it('REJECTS a create where subject_id !== payload.row.id (superRefine)', () => {
    expect(() =>
      parseEvent(
        createEnvelope({
          subject_id: 'blk_other',
          payload: { row: questionBlockRow('blk_1'), origin: 'ocr' },
        }),
      ),
    ).toThrow();
  });

  it('REJECTS a create with an EXTRA unknown field in the row (.strict(), critic B3)', () => {
    const badRow = questionBlockRow('blk_1') as Record<string, unknown>;
    badRow.bogus_extra = 'nope';
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow, origin: 'ocr' } }))).toThrow();
  });

  it('REJECTS a create that carries the LEGACY extracted_prompt_md column (.strict() omit)', () => {
    const badRow = questionBlockRow('blk_1') as Record<string, unknown>;
    badRow.extracted_prompt_md = 'legacy markdown'; // excluded from the snapshot — must be rejected
    expect(() => parseEvent(createEnvelope({ payload: { row: badRow, origin: 'ocr' } }))).toThrow();
  });

  it('REJECTS a create MISSING origin', () => {
    expect(() =>
      parseEvent(createEnvelope({ payload: { row: questionBlockRow('blk_1') } })),
    ).toThrow();
  });

  it('REJECTS a create with an invalid origin', () => {
    expect(() =>
      parseEvent(
        createEnvelope({ payload: { row: questionBlockRow('blk_1'), origin: 'telepathy' } }),
      ),
    ).toThrow();
  });

  it('REJECTS a wrong subject_kind for the create action', () => {
    expect(() => parseEvent(createEnvelope({ subject_kind: 'artifact' }))).toThrow();
  });
});

// ====================================================================
// question_block genesis parse-barrier tests (W3-A2 — genesis backfill seed routing).
//
// Adding `question_block` to GenesisExperimental's subject_kind enum + SNAPSHOT_BY_SUBJECT_KIND +
// DISCRIMINATING_COLUMNS lets the W3-C2 backfill seed pre-W3 question_block rows. Honest-reject: a
// wrong row shape under subject_kind='question_block' / a sibling row lacking the discriminating
// columns / subject_id != row.id must THROW (not fall through to the generic ExperimentalEvent).
// ====================================================================

function genesisEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'question_block',
    subject_id: 'blk_1',
    outcome: 'success',
    payload: { row: questionBlockRow('blk_1') },
    ...over,
  };
}

describe('parseEvent — experimental:genesis question_block routing + coherence (W3)', () => {
  it('ACCEPTS a well-formed genesis for a question_block row', () => {
    const parsed = parseEvent(genesisEnvelope());
    expect((parsed as { subject_kind: string }).subject_kind).toBe('question_block');
    expect((parsed as { subject_id: string }).subject_id).toBe('blk_1');
  });

  it('REJECTS a question_block genesis whose payload.row is an ARTIFACT row (wrong shape, superRefine)', () => {
    const artifactish = {
      id: 'blk_1',
      type: 'note',
      title: 'A note',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'note_generate',
      source_ref: null,
      body_blocks: { type: 'doc', content: [] },
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'not_required',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: '2026-06-26T00:00:00.000Z',
      updated_at: '2026-06-26T00:00:00.000Z',
      version: 0,
    };
    expect(() => parseEvent(genesisEnvelope({ payload: { row: artifactish } }))).toThrow();
  });

  it('REJECTS a question_block genesis MISSING the discriminating column ingestion_session_id', () => {
    const badRow = questionBlockRow('blk_1') as Record<string, unknown>;
    badRow.ingestion_session_id = undefined;
    expect(() => parseEvent(genesisEnvelope({ payload: { row: badRow } }))).toThrow();
  });

  it('REJECTS a question_block genesis where subject_id !== payload.row.id (superRefine)', () => {
    expect(() =>
      parseEvent(
        genesisEnvelope({
          subject_id: 'blk_mismatch',
          payload: { row: questionBlockRow('blk_1') },
        }),
      ),
    ).toThrow();
  });
});
