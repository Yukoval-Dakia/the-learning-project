// YUK-471 W3-C3 — DB tests: fold==row parity through the REAL artifact + question_block writers
// (testcontainer), with the per-entity SoT-flip flag both OFF (the imperative write stays the SoT +
// the in-tx parity assert verifies fold==row) and ON (projectXGuarded becomes the row writer).
//
// The wired seams:
//   - artifact:        editArtifactBodyBlocks (body-blocks-edit.ts) — the highest-traffic mutation.
//   - question_block:  updatePrompt → persistStructured (block-structured-edit.ts) — the single-block
//                      structured edit funnel (covers update_prompt / add_option / set_question_type /
//                      split_stem).
//
// TEETH:
//   - OFF + clean → no throw (the assert passed) and fold==row.
//   - OFF + a tampered fold-truth column the edit does NOT touch → the in-tx assert THROWS (drift
//     caught during the double-write phase — the W3-C3 "real teeth").
//   - ON  + the same tamper → projectXGuarded re-folds EVERY column and overwrites the tamper (proving
//     the projection is the SOLE row writer at flip), no throw, fold==row.
//
// Hermetic: resetDb() in beforeEach; the per-entity env flags are restored in afterEach.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  reassignFigure,
  updatePrompt,
} from '@/capabilities/ingestion/server/block-structured-edit';
import { editArtifactBodyBlocks } from '@/capabilities/notes/server/body-blocks-edit';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { artifact, question_block } from '@/db/schema';
import {
  backfillArtifactGenesis,
  backfillQuestionBlockGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldArtifact, gatherAndFoldQuestionBlock } from './gather';
import { artifactLiveRowToSnapshot, questionBlockLiveRowToSnapshot } from './parity';
import { diffSnapshots } from './snapshot-diff';

const T0 = new Date('2026-06-01T00:00:00.000Z');

// fold==row using the SAME structural equality as the in-tx parity assert + the audit (diffSnapshots
// normalizes jsonb-nested dates), NOT vitest's strict toEqual (which would false-fail on the
// fold's coerced Date history[].at vs the raw row's ISO-string form).
function expectFoldEqualsRow(
  fold: Record<string, unknown> | null,
  liveSnapshot: Record<string, unknown> | null,
): void {
  expect(diffSnapshots(liveSnapshot, fold)).toEqual([]);
}

function node(id: string, prompt: string): StructuredQuestionT {
  return { id, role: 'standalone', prompt_text: prompt };
}

function doc(text: string): ArtifactBodyBlocksT {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text }] }],
  } as ArtifactBodyBlocksT;
}

async function insertNoteArtifact(id: string, title: string): Promise<void> {
  await testDb().insert(artifact).values({
    id,
    type: 'note_atomic',
    title,
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'manual',
    source: 'manual',
    source_ref: null,
    body_blocks: null,
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
    created_at: T0,
    updated_at: T0,
    version: 0,
  });
}

async function insertDraftBlock(id: string): Promise<void> {
  await testDb()
    .insert(question_block)
    .values({
      id,
      ingestion_session_id: 'sess_1',
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      extracted_prompt_md: 'legacy prompt md', // legacy column — must NOT enter the fold (design §5.2)
      structured: node(id, 'original'),
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
    });
}

async function liveArtifactRow(id: string) {
  return (await testDb().select().from(artifact).where(eq(artifact.id, id)).limit(1))[0];
}
async function liveBlockRow(id: string) {
  return (
    await testDb().select().from(question_block).where(eq(question_block.id, id)).limit(1)
  )[0];
}

describe('W3-C3 — artifact parity through editArtifactBodyBlocks (real writer)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PROJECTION_IS_WRITER_ARTIFACT = '0'; // restore OFF (projectionIsWriter checks === '1')
  });

  it('OFF (default): a clean edit asserts fold==row in-tx (no throw) and the body is updated', async () => {
    const db = testDb();
    await insertNoteArtifact('art_1', 'Original Title');
    await backfillArtifactGenesis(db, T0); // anchor → event-sourced → the assert runs

    // editArtifactBodyBlocks runs the OFF-path imperative UPDATE + assertArtifactParity IN-TX. A
    // fold!=row mismatch would THROW here; reaching the result means the assert passed.
    const res = await editArtifactBodyBlocks({
      db,
      artifactId: 'art_1',
      expectedArtifactVersion: 0,
      bodyBlocks: doc('edited'),
    });
    expect(res.artifact_version).toBe(1);

    const row = await liveArtifactRow('art_1');
    expect(row?.body_blocks).toEqual(doc('edited'));
    expect(row?.version).toBe(1);
    // fold reproduces the live row byte-for-byte.
    const live1 = await liveArtifactRow('art_1');
    expectFoldEqualsRow(
      await gatherAndFoldArtifact(db, 'art_1'),
      live1 ? artifactLiveRowToSnapshot(live1) : null,
    );
  });

  it('OFF: a fold-truth column tampered out-of-band (title) makes the in-tx assert THROW (drift caught)', async () => {
    const db = testDb();
    await insertNoteArtifact('art_2', 'Original Title');
    await backfillArtifactGenesis(db, T0);
    // Corrupt a column the edit does NOT touch — the fold (from genesis) still says 'Original Title'.
    await db.update(artifact).set({ title: 'TAMPERED' }).where(eq(artifact.id, 'art_2'));

    await expect(
      editArtifactBodyBlocks({
        db,
        artifactId: 'art_2',
        expectedArtifactVersion: 0,
        bodyBlocks: doc('edited'),
      }),
    ).rejects.toThrow(/projection-parity/i);
  });

  it('ON: projectArtifactGuarded becomes the row writer — re-folds EVERY column, overwriting the tamper', async () => {
    const db = testDb();
    await insertNoteArtifact('art_3', 'Original Title');
    await backfillArtifactGenesis(db, T0);
    await db.update(artifact).set({ title: 'TAMPERED' }).where(eq(artifact.id, 'art_3'));

    process.env.PROJECTION_IS_WRITER_ARTIFACT = '1';
    const res = await editArtifactBodyBlocks({
      db,
      artifactId: 'art_3',
      expectedArtifactVersion: 0,
      bodyBlocks: doc('edited'),
    });
    expect(res.artifact_version).toBe(1);

    const row = await liveArtifactRow('art_3');
    // The projection re-wrote the WHOLE row from fold truth, so the out-of-band title corruption is gone.
    expect(row?.title).toBe('Original Title');
    expect(row?.body_blocks).toEqual(doc('edited'));
    const live3 = await liveArtifactRow('art_3');
    expectFoldEqualsRow(
      await gatherAndFoldArtifact(db, 'art_3'),
      live3 ? artifactLiveRowToSnapshot(live3) : null,
    );
  });
});

describe('W3-C3 — question_block parity through updatePrompt (real writer)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PROJECTION_IS_WRITER_QUESTION_BLOCK = '0'; // restore OFF (projectionIsWriter checks === '1')
  });

  it('OFF (default): a clean structured edit asserts fold==row in-tx (no throw) and the prompt is updated', async () => {
    const db = testDb();
    await insertDraftBlock('qb_1');
    await backfillQuestionBlockGenesis(db, T0); // anchor → event-sourced → the assert runs

    const res = await updatePrompt(db, {
      blockId: 'qb_1',
      nodeId: 'qb_1',
      promptText: 'edited prompt',
      actorRef: 'tester',
    });
    expect(res.status).toBe('written');
    expect(res.version).toBe(1);

    const row = await liveBlockRow('qb_1');
    expect((row?.structured as StructuredQuestionT).prompt_text).toBe('edited prompt');
    expect(row?.version).toBe(1);
    // The fold OMITS extracted_prompt_md (design §5.2), so compare against the stripped snapshot.
    const qlive1 = await liveBlockRow('qb_1');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qb_1'),
      qlive1 ? questionBlockLiveRowToSnapshot(qlive1) : null,
    );
  });

  it('OFF: a fold-truth column tampered out-of-band (reference_md) makes the in-tx assert THROW (drift caught)', async () => {
    const db = testDb();
    await insertDraftBlock('qb_2');
    await backfillQuestionBlockGenesis(db, T0);
    await db
      .update(question_block)
      .set({ reference_md: 'TAMPERED' })
      .where(eq(question_block.id, 'qb_2'));

    await expect(
      updatePrompt(db, {
        blockId: 'qb_2',
        nodeId: 'qb_2',
        promptText: 'edited prompt',
        actorRef: 'tester',
      }),
    ).rejects.toThrow(/projection-parity/i);
  });

  it('ON: projectQuestionBlockGuarded becomes the row writer — re-folds EVERY column, overwriting the tamper', async () => {
    const db = testDb();
    await insertDraftBlock('qb_3');
    await backfillQuestionBlockGenesis(db, T0);
    await db
      .update(question_block)
      .set({ reference_md: 'TAMPERED' })
      .where(eq(question_block.id, 'qb_3'));

    process.env.PROJECTION_IS_WRITER_QUESTION_BLOCK = '1';
    const res = await updatePrompt(db, {
      blockId: 'qb_3',
      nodeId: 'qb_3',
      promptText: 'edited prompt',
      actorRef: 'tester',
    });
    expect(res.status).toBe('written');

    const row = await liveBlockRow('qb_3');
    // The projection re-wrote the WHOLE row from fold truth → the reference_md corruption is gone.
    expect(row?.reference_md).toBeNull();
    expect((row?.structured as StructuredQuestionT).prompt_text).toBe('edited prompt');
    const qlive3 = await liveBlockRow('qb_3');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qb_3'),
      qlive3 ? questionBlockLiveRowToSnapshot(qlive3) : null,
    );
  });
});

// W3-D — the question_block_lifecycle cutover (the 5 formerly-eventless fold-truth mutators). Here we
// exercise the figure-reassignment writer (reassignFigure → op='reassign_figures') end-to-end: the
// imperative UPDATE + the additive canonical lifecycle event, then fold==row. (The set_status writers —
// auto-enroll / import / revert — are exercised by their own DB tests, which validate the lifecycle
// payload in-tx via writeEvent→parseEvent; the reducer's presence-based set_status branch is covered by
// the pure foldQuestionBlock unit tests.)
const FIG_TREE: StructuredQuestionT = {
  id: 'stem',
  role: 'stem',
  prompt_text: '',
  sub_questions: [
    { id: 's1', role: 'sub', prompt_text: 'a' },
    { id: 's2', role: 'sub', prompt_text: 'b' },
  ],
};
const FIG: FigureRefT = {
  asset_id: 'fig-1',
  role: 'diagram',
  source_page_index: 0,
  source_bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
  attached_to_index: 's1',
  attach_confidence: 'high',
};

async function insertBlockWithFigure(id: string): Promise<void> {
  await testDb()
    .insert(question_block)
    .values({
      id,
      ingestion_session_id: 'sess_fig',
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      extracted_prompt_md: 'legacy prompt md',
      structured: FIG_TREE,
      figures: [FIG],
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
    });
}

describe('W3-D — question_block parity through reassignFigure (real writer, op=reassign_figures)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a clean figure re-point folds == row (figures re-pointed + version bumped, single-clock)', async () => {
    const db = testDb();
    await insertBlockWithFigure('qbf_1');
    await backfillQuestionBlockGenesis(db, T0); // anchor → the lifecycle event re-projects atop it

    const res = await reassignFigure(db, {
      blockId: 'qbf_1',
      assetId: 'fig-1',
      attachedToIndex: 's2',
      actorRef: 'tester',
    });
    expect(res.status).toBe('written');
    expect(res.version).toBe(1);

    const row = await liveBlockRow('qbf_1');
    expect(row?.figures[0].attached_to_index).toBe('s2');
    expect(row?.figures[0].attach_confidence).toBe('manual');
    expect(row?.version).toBe(1);

    // The fold reproduces the live row byte-for-byte through the new question_block_lifecycle branch
    // (incl. the figure's last_reassigned_at, which the single-clock writer set to the event time).
    const qlive = await liveBlockRow('qbf_1');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qbf_1'),
      qlive ? questionBlockLiveRowToSnapshot(qlive) : null,
    );
  });
});
