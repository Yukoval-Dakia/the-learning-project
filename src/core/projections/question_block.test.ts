import { describe, expect, it } from 'vitest';
import type { QuestionBlockRowSnapshotT } from '../schema/event/genesis';
import type { FigureRefT, StructuredQuestionT } from '../schema/structured_question';
import type { FoldEvent } from './fold-event';
import { foldQuestionBlock } from './question_block';

// ====================================================================
// foldQuestionBlock — pure question_block reducer unit tests (YUK-471 Wave 3, W3-B2).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent. The reducer safeParses
// internally; passing plain objects matching the schema shapes exercises that path and keeps the
// test pure. These are the GOLDEN fold==row assertions — the fold==row invariant core.
//
// BASE = experimental:question_block_create (runtime, OCR/rescue/docx/import — rescue overwrites
// last-write-wins) OR experimental:genesis (backfill, FIRST BASE WINS), both carrying the FULL
// QuestionBlockRowSnapshot (fork #2). edit_question_block_structured is the HARD multi-row merge
// aggregation: ONE event keyed on the PRIMARY carries the primary + N merged_source entries, and
// the fold finds blockId's ROLE in affected_blocks. updated_at = the EVENT's created_at (single-
// clock); version = the affected_block snapshot's declared version (verbatim, never computed).
// ====================================================================

let seq = 0;
function nextId(prefix = 'evt'): string {
  seq += 1;
  return `${prefix}_${seq.toString().padStart(4, '0')}`;
}

const T0 = new Date('2026-06-26T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// A minimal valid StructuredQuestion node (standalone leaf).
function node(id: string, prompt: string): StructuredQuestionT {
  return { id, role: 'standalone', prompt_text: prompt };
}

// A minimal valid FigureRef (BBox passes x+width<=1 / y+height<=1).
function figure(assetId: string, attachedTo: string): FigureRefT {
  return {
    asset_id: assetId,
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    attached_to_index: attachedTo,
    attach_confidence: 'high',
  };
}

function qbSnapshot(over: Partial<QuestionBlockRowSnapshotT> = {}): QuestionBlockRowSnapshotT {
  return {
    id: 'qb_1',
    ingestion_session_id: 'sess_1',
    source_document_id: null,
    source_asset_ids: [],
    page_spans: [],
    structured: node('qb_1', 'original prompt'),
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
    created_at: T0,
    updated_at: T0,
    version: 0,
    ...over,
  };
}

// experimental:question_block_create — runtime-creation BASE (origin ocr/rescue/docx/import).
// subject_id MUST equal row.id (schema superRefine). rescue = a SECOND create for the same id.
function create(opts: {
  id?: string;
  created_at: Date;
  row: QuestionBlockRowSnapshotT;
  origin?: 'ocr' | 'rescue' | 'docx' | 'import';
}): FoldEvent {
  return {
    id: opts.id ?? nextId('create'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'ingestion-extract',
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row, origin: opts.origin ?? 'ocr' },
  };
}

// experimental:genesis — the backfill BASE seed. subject_id === row.id.
function genesis(opts: {
  id?: string;
  created_at: Date;
  row: QuestionBlockRowSnapshotT;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'question_block',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

type AffectedBlock = {
  block_id: string;
  role: 'primary' | 'merged_source';
  structured: StructuredQuestionT | null;
  figures?: FigureRefT[] | null;
  version: number;
  status: string;
};

// experimental:edit_question_block_structured — single canonical, keyed on the PRIMARY block.
function editEvent(opts: {
  id?: string;
  created_at: Date;
  primaryBlockId: string;
  op: 'update_prompt' | 'add_option' | 'set_question_type' | 'split_stem' | 'merge_questions';
  affected: AffectedBlock[];
}): FoldEvent {
  return {
    id: opts.id ?? nextId('edit'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'question_block_structured_editor',
    action: 'experimental:edit_question_block_structured',
    subject_kind: 'question_block',
    subject_id: opts.primaryBlockId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {
      op: opts.op,
      affected_blocks: opts.affected.map((b) => ({
        block_id: b.block_id,
        role: b.role,
        structured: b.structured,
        ...(b.figures !== undefined ? { figures: b.figures } : {}),
        version: b.version,
        status: b.status,
      })),
    },
  };
}

// Single-block (non-merge) edit: ONE primary entry (the superRefine forbids merged_sources here).
function singleEdit(opts: {
  id?: string;
  created_at: Date;
  blockId: string;
  op?: 'update_prompt' | 'add_option' | 'set_question_type' | 'split_stem';
  structured: StructuredQuestionT;
  figures?: FigureRefT[] | null;
  version: number;
  status?: string;
}): FoldEvent {
  return editEvent({
    id: opts.id,
    created_at: opts.created_at,
    primaryBlockId: opts.blockId,
    op: opts.op ?? 'update_prompt',
    affected: [
      {
        block_id: opts.blockId,
        role: 'primary',
        structured: opts.structured,
        figures: opts.figures,
        version: opts.version,
        status: opts.status ?? 'draft',
      },
    ],
  });
}

describe('foldQuestionBlock — base seed (create / genesis / rescue)', () => {
  it('projects a create-only block verbatim from payload.row', () => {
    const snap = qbSnapshot();
    const row = foldQuestionBlock('qb_1', [create({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('seeds the full row from genesis verbatim (incl version + status + figures)', () => {
    const snap = qbSnapshot({
      version: 7,
      status: 'ignored',
      figures: [figure('asset_a', 'qb_1')],
      crop_refs: ['asset_a'],
      merged_from_block_ids: ['qb_old'],
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const row = foldQuestionBlock('qb_1', [genesis({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('returns null when no event seeds/creates the block (no-anchor)', () => {
    expect(foldQuestionBlock('qb_unknown', [])).toBeNull();
  });

  it('returns null when only an edit exists with no base (un-anchored edit is a no-op)', () => {
    const edit = singleEdit({
      created_at: at(1000),
      blockId: 'qb_1',
      structured: node('qb_1', 'edited'),
      version: 1,
    });
    expect(foldQuestionBlock('qb_1', [edit])).toBeNull();
  });

  it('rescue overwrites the whole row last-write-wins (origin=rescue, second create)', () => {
    const ocr = qbSnapshot({
      structured: node('qb_1', 'ocr garbled'),
      version: 0,
      status: 'draft',
    });
    const rescued = qbSnapshot({
      structured: node('qb_1', 'rescued clean'),
      figures: [figure('asset_r', 'qb_1')],
      crop_refs: ['asset_r'],
      version: 1,
    });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: ocr, origin: 'ocr' }),
      create({ created_at: at(1000), row: rescued, origin: 'rescue' }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'rescued clean'));
    expect(row?.figures).toEqual([figure('asset_r', 'qb_1')]);
    expect(row?.crop_refs).toEqual(['asset_r']);
    expect(row?.version).toBe(1);
  });

  it('rescue overwrites a genesis-backfilled row too (genesis seed → runtime rescue)', () => {
    const seeded = qbSnapshot({ structured: node('qb_1', 'pre-W3'), version: 3 });
    const rescued = qbSnapshot({ structured: node('qb_1', 'rescued'), version: 4 });
    const row = foldQuestionBlock('qb_1', [
      genesis({ created_at: at(0), row: seeded }),
      create({ created_at: at(1000), row: rescued, origin: 'rescue' }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'rescued'));
    expect(row?.version).toBe(4);
  });

  it('FIRST BASE WINS for genesis: a duplicate genesis seed is ignored', () => {
    const first = qbSnapshot({ structured: node('qb_1', 'first'), version: 0 });
    const second = qbSnapshot({ structured: node('qb_1', 'second'), version: 9 });
    const row = foldQuestionBlock('qb_1', [
      genesis({ created_at: at(0), row: first }),
      genesis({ created_at: at(1000), row: second }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'first'));
    expect(row?.version).toBe(0);
  });
});

describe('foldQuestionBlock — single-block edit (structured / version / figures)', () => {
  it('replaces structured + version, stamps updated_at from the event, keeps other columns', () => {
    const snap = qbSnapshot({ structured: node('qb_1', 'v0'), version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: snap }),
      singleEdit({
        created_at: at(2000),
        blockId: 'qb_1',
        op: 'update_prompt',
        structured: node('qb_1', 'v1 edited'),
        version: 1,
      }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'v1 edited'));
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
    // untouched columns preserved from the base.
    expect(row?.ingestion_session_id).toBe('sess_1');
    expect(row?.status).toBe('draft');
    expect(row?.merged_from_block_ids).toEqual([]);
  });

  it('figures fall back to the current row value when the edit snapshot omits them (§5.2)', () => {
    const snap = qbSnapshot({ figures: [figure('asset_keep', 'qb_1')], version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: snap }),
      // update_prompt does not re-point figures → snapshot omits `figures`.
      singleEdit({
        created_at: at(1000),
        blockId: 'qb_1',
        structured: node('qb_1', 'edited'),
        version: 1,
      }),
    ]);
    expect(row?.figures).toEqual([figure('asset_keep', 'qb_1')]); // unchanged (fallback)
  });

  it('figures are replaced when the edit snapshot carries them (e.g. splitStem re-point)', () => {
    const snap = qbSnapshot({ figures: [figure('asset_old', 'qb_1')], version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: snap }),
      singleEdit({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'split_stem',
        structured: node('qb_1', 'split'),
        figures: [figure('asset_new', 'qb_1')],
        version: 1,
      }),
    ]);
    expect(row?.figures).toEqual([figure('asset_new', 'qb_1')]);
  });

  it('applies two sequential edits → last-write-wins structured + final version', () => {
    const snap = qbSnapshot({ structured: node('qb_1', 'v0'), version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: snap }),
      singleEdit({
        created_at: at(1000),
        blockId: 'qb_1',
        structured: node('qb_1', 'v1'),
        version: 1,
      }),
      singleEdit({
        created_at: at(2000),
        blockId: 'qb_1',
        op: 'add_option',
        structured: node('qb_1', 'v2'),
        version: 2,
      }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'v2'));
    expect(row?.version).toBe(2);
  });
});

describe('foldQuestionBlock — merge multi-row aggregation (THE HARD PART, C4)', () => {
  // One edit event keyed on the PRIMARY (qb_1) absorbs qb_2 + qb_3. Folding qb_1 (the primary) and
  // folding qb_2 / qb_3 (the absorbed sources) read DIFFERENT branches off the SAME event.
  const mergedTree = node('qb_1', 'merged stem');

  function mergeEventFixture(createdAt: ReturnType<typeof at>): FoldEvent {
    return editEvent({
      created_at: createdAt,
      primaryBlockId: 'qb_1',
      op: 'merge_questions',
      affected: [
        {
          block_id: 'qb_1',
          role: 'primary',
          structured: mergedTree,
          figures: [figure('fig_primary', 'qb_1'), figure('fig_from_qb2', 'qb_2')],
          version: 1,
          status: 'draft',
        },
        // merged_source carries a (different) before-value structured — the reducer MUST ignore it.
        {
          block_id: 'qb_2',
          role: 'merged_source',
          structured: node('qb_2', 'qb2 before'),
          version: 5,
          status: 'ignored',
        },
        {
          block_id: 'qb_3',
          role: 'merged_source',
          structured: node('qb_3', 'qb3 before'),
          version: 2,
          status: 'ignored',
        },
      ],
    });
  }

  it('folds the PRIMARY → merged tree, merged figures, version bump, merged_from_block_ids appended', () => {
    const primarySnap = qbSnapshot({
      id: 'qb_1',
      structured: node('qb_1', 'primary before'),
      figures: [figure('fig_primary', 'qb_1')],
      version: 0,
      merged_from_block_ids: [],
    });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: primarySnap }),
      mergeEventFixture(at(3000)),
    ]);
    expect(row?.structured).toEqual(mergedTree);
    expect(row?.figures).toEqual([figure('fig_primary', 'qb_1'), figure('fig_from_qb2', 'qb_2')]);
    expect(row?.version).toBe(1);
    expect(row?.merged_from_block_ids).toEqual(['qb_2', 'qb_3']); // absorbed ids appended in order
    expect(row?.updated_at.getTime()).toBe(at(3000).getTime());
    expect(row?.status).toBe('draft'); // the primary stays draft
  });

  it('folds an ABSORBED merged_source → status=ignored, version UNCHANGED, structured KEPT (before-value)', () => {
    // qb_2 is created independently (version 5), then absorbed by the merge keyed on qb_1.
    const qb2Snap = qbSnapshot({
      id: 'qb_2',
      structured: node('qb_2', 'qb2 original'),
      version: 5,
      status: 'draft',
    });
    const row = foldQuestionBlock('qb_2', [
      create({ created_at: at(0), row: qb2Snap }),
      mergeEventFixture(at(3000)), // keyed on qb_1, NOT qb_2 — qb_2 is a merged_source
    ]);
    expect(row?.status).toBe('ignored');
    // The live merge writer does NOT bump the absorbed block's version → unchanged (verbatim).
    expect(row?.version).toBe(5);
    // The reducer does NOT overwrite the absorbed block's structured (it ignores the merged_source
    // entry's structured before-value) — it stays at qb_2's own seeded tree.
    expect(row?.structured).toEqual(node('qb_2', 'qb2 original'));
    expect(row?.updated_at.getTime()).toBe(at(3000).getTime());
    // never writes a merged_into column (no physical column; A2).
    expect(row).not.toHaveProperty('merged_into');
    expect(row).not.toHaveProperty('merged_into_block_id');
  });

  it('the SAME merge event folds qb_1 / qb_2 / qb_3 into three coherent rows', () => {
    const ev = mergeEventFixture(at(3000));
    const p = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'p'), version: 0 });
    const a = qbSnapshot({
      id: 'qb_2',
      structured: node('qb_2', 'a'),
      version: 5,
      status: 'draft',
    });
    const b = qbSnapshot({
      id: 'qb_3',
      structured: node('qb_3', 'b'),
      version: 2,
      status: 'draft',
    });
    const primary = foldQuestionBlock('qb_1', [create({ created_at: at(0), row: p }), ev]);
    const absorbed2 = foldQuestionBlock('qb_2', [create({ created_at: at(0), row: a }), ev]);
    const absorbed3 = foldQuestionBlock('qb_3', [create({ created_at: at(0), row: b }), ev]);
    expect(primary?.status).toBe('draft');
    expect(primary?.merged_from_block_ids).toEqual(['qb_2', 'qb_3']);
    expect(absorbed2?.status).toBe('ignored');
    expect(absorbed2?.version).toBe(5);
    expect(absorbed3?.status).toBe('ignored');
    expect(absorbed3?.version).toBe(2);
  });

  it('appends absorbed ids onto pre-existing merged_from_block_ids (sequential merges)', () => {
    const primarySnap = qbSnapshot({ id: 'qb_1', version: 0, merged_from_block_ids: ['qb_prev'] });
    const ev = editEvent({
      created_at: at(1000),
      primaryBlockId: 'qb_1',
      op: 'merge_questions',
      affected: [
        {
          block_id: 'qb_1',
          role: 'primary',
          structured: node('qb_1', 'm'),
          version: 1,
          status: 'draft',
        },
        {
          block_id: 'qb_4',
          role: 'merged_source',
          structured: null,
          version: 0,
          status: 'ignored',
        },
      ],
    });
    const row = foldQuestionBlock('qb_1', [create({ created_at: at(0), row: primarySnap }), ev]);
    expect(row?.merged_from_block_ids).toEqual(['qb_prev', 'qb_4']);
  });
});

describe('foldQuestionBlock — interleaving, ordering, dedup, isolation', () => {
  it('interleaves edit → merge → edit in chronological order', () => {
    const snap = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'v0'), version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: snap }),
      singleEdit({
        created_at: at(1000),
        blockId: 'qb_1',
        structured: node('qb_1', 'v1'),
        version: 1,
      }),
      editEvent({
        created_at: at(2000),
        primaryBlockId: 'qb_1',
        op: 'merge_questions',
        affected: [
          {
            block_id: 'qb_1',
            role: 'primary',
            structured: node('qb_1', 'merged'),
            version: 2,
            status: 'draft',
          },
          {
            block_id: 'qb_2',
            role: 'merged_source',
            structured: null,
            version: 0,
            status: 'ignored',
          },
        ],
      }),
      singleEdit({
        created_at: at(3000),
        blockId: 'qb_1',
        structured: node('qb_1', 'v3'),
        version: 3,
      }),
    ]);
    expect(row?.structured).toEqual(node('qb_1', 'v3'));
    expect(row?.version).toBe(3);
    expect(row?.merged_from_block_ids).toEqual(['qb_2']); // merge effect survives the later edit
    expect(row?.updated_at.getTime()).toBe(at(3000).getTime());
  });

  it('is order-independent: shuffled input folds identically (sort by created_at,id)', () => {
    const snap = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'v0'), version: 0 });
    const c = create({ created_at: at(0), row: snap });
    const e1 = singleEdit({
      created_at: at(1000),
      blockId: 'qb_1',
      structured: node('qb_1', 'v1'),
      version: 1,
    });
    const e2 = singleEdit({
      created_at: at(2000),
      blockId: 'qb_1',
      structured: node('qb_1', 'v2'),
      version: 2,
    });
    const inOrder = foldQuestionBlock('qb_1', [c, e1, e2]);
    const shuffled = foldQuestionBlock('qb_1', [e2, c, e1]);
    expect(shuffled).toEqual(inOrder);
    expect(inOrder?.version).toBe(2);
    expect(inOrder?.structured).toEqual(node('qb_1', 'v2'));
  });

  it('tiebreaks events at the SAME created_at by id (stable application order)', () => {
    const snap = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'v0'), version: 0 });
    const c = create({ id: 'aaa_create', created_at: T0, row: snap });
    const eMid = singleEdit({
      id: 'mmm_edit',
      created_at: at(1000),
      blockId: 'qb_1',
      structured: node('qb_1', 'mid'),
      version: 1,
    });
    const eLate = singleEdit({
      id: 'zzz_edit',
      created_at: at(1000),
      blockId: 'qb_1',
      structured: node('qb_1', 'late'),
      version: 2,
    });
    const row = foldQuestionBlock('qb_1', [eLate, c, eMid]);
    expect(row?.structured).toEqual(node('qb_1', 'late')); // zzz_edit applied last
    expect(row?.version).toBe(2);
  });

  it('is pure / deterministic: same input twice → deep-equal output (no Date/newId)', () => {
    const snap = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'A'), version: 0 });
    const events = [
      create({ id: 'c1', created_at: at(0), row: snap }),
      singleEdit({
        id: 'e1',
        created_at: at(1000),
        blockId: 'qb_1',
        structured: node('qb_1', 'A2'),
        version: 1,
      }),
    ];
    const first = foldQuestionBlock('qb_1', events);
    const second = foldQuestionBlock('qb_1', events);
    expect(first).toEqual(second);
  });

  it('ignores events for other block ids (superset input)', () => {
    const s1 = qbSnapshot({ id: 'qb_1', structured: node('qb_1', 'One') });
    const s2 = qbSnapshot({ id: 'qb_2', structured: node('qb_2', 'Two') });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: s1 }),
      create({ created_at: at(0), row: s2 }),
      singleEdit({
        created_at: at(1000),
        blockId: 'qb_2',
        structured: node('qb_2', 'other edit'),
        version: 1,
      }),
    ]);
    expect(row?.id).toBe('qb_1');
    expect(row?.structured).toEqual(node('qb_1', 'One')); // qb_2's edit did not touch qb_1
    expect(row?.version).toBe(0);
  });

  it('does not double-apply a merge to a block that is neither primary nor merged_source', () => {
    // The merge is keyed on qb_1 and absorbs qb_2; qb_9 is unrelated. Folding qb_9 must skip it.
    const s9 = qbSnapshot({ id: 'qb_9', structured: node('qb_9', 'nine'), version: 0 });
    const ev = editEvent({
      created_at: at(1000),
      primaryBlockId: 'qb_1',
      op: 'merge_questions',
      affected: [
        {
          block_id: 'qb_1',
          role: 'primary',
          structured: node('qb_1', 'm'),
          version: 1,
          status: 'draft',
        },
        {
          block_id: 'qb_2',
          role: 'merged_source',
          structured: null,
          version: 0,
          status: 'ignored',
        },
      ],
    });
    const row = foldQuestionBlock('qb_9', [create({ created_at: at(0), row: s9 }), ev]);
    expect(row).toEqual(s9); // untouched
  });
});

// Deterministic in-place permutation (no RNG → reproducible). seedShift varies the permutation.
function permute<T>(arr: T[], seedShift: number): T[] {
  const out = [...arr];
  for (let i = 0; i < out.length; i += 1) {
    const j = (i * 7 + seedShift) % out.length;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ====================================================================
// W3-C3 (F7) — interleave convergence + version monotonicity.
//
// foldQuestionBlock sorts by (created_at asc, id asc), so a SHUFFLED / out-of-order delivery MUST
// converge to the SAME row as the in-order fold — the SoT flip rests on this determinism. The qb edit
// event has NO version-monotonicity superRefine (unlike artifact's body_blocks_edit): the fold does
// LAST-WRITE-WINS by created_at, so the final version/structured reflect the created_at-LATEST edit
// even when an EARLIER-versioned edit is delivered last.
// ====================================================================
describe('foldQuestionBlock — W3-C3 interleave convergence + version monotonicity (F7)', () => {
  const base = qbSnapshot({ id: 'qb_i', version: 0, structured: node('qb_i', 'v0') });
  const chain: FoldEvent[] = [
    create({ created_at: at(0), row: base }),
    singleEdit({
      created_at: at(1000),
      blockId: 'qb_i',
      structured: node('qb_i', 'v1'),
      version: 1,
    }),
    singleEdit({
      created_at: at(2000),
      blockId: 'qb_i',
      structured: node('qb_i', 'v2'),
      version: 2,
    }),
    singleEdit({
      created_at: at(3000),
      blockId: 'qb_i',
      structured: node('qb_i', 'v3'),
      version: 3,
    }),
  ];

  it('fold(shuffled) == fold(ordered) — order-independent convergence', () => {
    const ordered = foldQuestionBlock('qb_i', chain);
    for (let s = 0; s < 5; s += 1) {
      expect(foldQuestionBlock('qb_i', permute(chain, s))).toEqual(ordered);
    }
  });

  it('final version + structured reflect the created_at-LATEST edit regardless of input order', () => {
    const row = foldQuestionBlock('qb_i', permute(chain, 3));
    expect(row?.version).toBe(3);
    expect(row?.structured).toEqual(node('qb_i', 'v3'));
  });

  it('an out-of-order EARLIER edit (lower created_at) never overrides a later one (last-write-wins by clock, not delivery order)', () => {
    // Deliver v3 FIRST in the array, v1 LAST: the fold still sorts by created_at, so v3 (at 3000) wins.
    const reordered = [chain[0], chain[3], chain[2], chain[1]];
    const row = foldQuestionBlock('qb_i', reordered);
    expect(row?.version).toBe(3);
    expect(row?.structured).toEqual(node('qb_i', 'v3'));
  });
});

// experimental:question_block_lifecycle — the 5 formerly-eventless fold-truth mutators (W3-D).
// PRESENCE-BASED: only the carried columns apply. subject_id === blockId (no merged_source aggregation).
function lifecycle(opts: {
  id?: string;
  created_at: Date;
  blockId: string;
  op: 'reassign_figures' | 'set_status';
  figures?: FigureRefT[];
  status?: string;
  imported_question_id?: string | null;
  imported_attempt_event_id?: string | null;
  next_version: number;
}): FoldEvent {
  const payload: Record<string, unknown> = { op: opts.op, next_version: opts.next_version };
  if (opts.figures !== undefined) payload.figures = opts.figures;
  if (opts.status !== undefined) payload.status = opts.status;
  if (opts.imported_question_id !== undefined) {
    payload.imported_question_id = opts.imported_question_id;
  }
  if (opts.imported_attempt_event_id !== undefined) {
    payload.imported_attempt_event_id = opts.imported_attempt_event_id;
  }
  return {
    id: opts.id ?? nextId('lifecycle'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'test_lifecycle_writer',
    action: 'experimental:question_block_lifecycle',
    subject_kind: 'question_block',
    subject_id: opts.blockId,
    outcome: 'success',
    caused_by_event_id: null,
    payload,
  };
}

describe('foldQuestionBlock — question_block_lifecycle (W3-D eventless-writer cutover)', () => {
  it('reassign_figures replaces the figures array wholesale + bumps version + stamps updated_at (reassignFigure)', () => {
    const base = qbSnapshot({ figures: [figure('asset_a', 'qb_1')], version: 0 });
    const repointed = [figure('asset_a', 'sub_2')];
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'reassign_figures',
        figures: repointed,
        next_version: 1,
      }),
    ]);
    expect(row?.figures).toEqual(repointed);
    expect(row?.version).toBe(1);
    expect(row?.updated_at).toEqual(at(1000));
    // status / imports untouched by a reassign.
    expect(row?.status).toBe('draft');
    expect(row?.imported_question_id).toBeNull();
  });

  it('set_status auto_enrolled carries status + BOTH imports (runAutoEnrollForSession)', () => {
    const base = qbSnapshot({ status: 'draft', version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'auto_enrolled',
        imported_question_id: 'q_99',
        imported_attempt_event_id: 'evt_attempt_1',
        next_version: 1,
      }),
    ]);
    expect(row?.status).toBe('auto_enrolled');
    expect(row?.imported_question_id).toBe('q_99');
    expect(row?.imported_attempt_event_id).toBe('evt_attempt_1');
    expect(row?.version).toBe(1);
    expect(row?.updated_at).toEqual(at(1000));
  });

  it('set_status imported with a NULL attempt event (unanswered capture) folds the explicit null', () => {
    const base = qbSnapshot({ status: 'draft' });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'imported',
        imported_question_id: 'q_5',
        imported_attempt_event_id: null,
        next_version: 1,
      }),
    ]);
    expect(row?.status).toBe('imported');
    expect(row?.imported_question_id).toBe('q_5');
    expect(row?.imported_attempt_event_id).toBeNull();
  });

  it('set_status ignored OMITS imports → the fold PRESERVES prior imports (import ignore sweep)', () => {
    // An already-enrolled block carries imports; the ignore sweep only flips status — it must NOT clear them.
    const base = qbSnapshot({
      status: 'auto_enrolled',
      imported_question_id: 'q_keep',
      imported_attempt_event_id: 'evt_keep',
      version: 1,
    });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'ignored',
        next_version: 2,
      }),
    ]);
    expect(row?.status).toBe('ignored');
    // OMITTED imports ⇒ unchanged (presence-based).
    expect(row?.imported_question_id).toBe('q_keep');
    expect(row?.imported_attempt_event_id).toBe('evt_keep');
    expect(row?.version).toBe(2);
  });

  it('set_status draft with EXPLICIT null imports clears them (revertAutoEnrolledBlock)', () => {
    const base = qbSnapshot({
      status: 'auto_enrolled',
      imported_question_id: 'q_revert',
      imported_attempt_event_id: 'evt_revert',
      version: 1,
    });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'draft',
        imported_question_id: null,
        imported_attempt_event_id: null,
        next_version: 2,
      }),
    ]);
    expect(row?.status).toBe('draft');
    expect(row?.imported_question_id).toBeNull();
    expect(row?.imported_attempt_event_id).toBeNull();
    expect(row?.version).toBe(2);
  });

  it('enroll → revert round-trip folds back to a clean draft (last-write-wins by clock)', () => {
    const base = qbSnapshot({ status: 'draft', version: 0 });
    const row = foldQuestionBlock('qb_1', [
      create({ created_at: at(0), row: base }),
      lifecycle({
        created_at: at(1000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'auto_enrolled',
        imported_question_id: 'q_1',
        imported_attempt_event_id: 'evt_1',
        next_version: 1,
      }),
      lifecycle({
        created_at: at(2000),
        blockId: 'qb_1',
        op: 'set_status',
        status: 'draft',
        imported_question_id: null,
        imported_attempt_event_id: null,
        next_version: 2,
      }),
    ]);
    expect(row?.status).toBe('draft');
    expect(row?.imported_question_id).toBeNull();
    expect(row?.version).toBe(2);
  });

  it('a lifecycle event with no base (un-anchored) is a no-op (mirrors the un-anchored edit)', () => {
    const orphan = lifecycle({
      created_at: at(1000),
      blockId: 'qb_1',
      op: 'set_status',
      status: 'ignored',
      next_version: 1,
    });
    expect(foldQuestionBlock('qb_1', [orphan])).toBeNull();
  });
});
