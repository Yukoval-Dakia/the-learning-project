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

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAutoEnrollForSession } from '@/capabilities/ingestion/server/auto-enroll';
import {
  reassignFigure,
  updatePrompt,
} from '@/capabilities/ingestion/server/block-structured-edit';
import { revertAutoEnrolledBlock } from '@/capabilities/ingestion/server/revert-auto-enroll';
import { editArtifactBodyBlocks } from '@/capabilities/notes/server/body-blocks-edit';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import {
  artifact,
  knowledge,
  learning_record,
  learning_session,
  question_block,
} from '@/db/schema';
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
// imperative UPDATE + the additive canonical lifecycle event, then fold==row. The op='set_status'
// writers also get end-to-end fold==row parity (YUK-503 W3 test hardening), upgrading the earlier
// payload-only guard (writeEvent→parseEvent structural validity) to a real divergence check that would
// catch a ONE-SIDED edit between the imperative UPDATE and the lifecycle-event payload:
//   - runAutoEnrollForSession (op='set_status' status='auto_enrolled') — describe below;
//   - revertAutoEnrolledBlock  (op='set_status' status='draft', imported_* cleared) — describe below;
//   - the import POST (enroll → status='imported'; ignore sweep → status='ignored') — covered by the
//     sibling parity test in src/capabilities/ingestion/api/import.db.test.ts (kept there because the
//     import route needs R2/AI module mocks this projection-parity file must stay free of).
// The reducer's presence-based set_status branch is additionally covered by the pure foldQuestionBlock
// unit tests.
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

// W3-D set_status parity (YUK-503) — the two op='set_status' writers that are cleanly drivable without
// route-level module mocks: runAutoEnrollForSession (judge pipeline via stub fns) and
// revertAutoEnrolledBlock (pure DB). Each follows the SAME paradigm as the reassignFigure test above:
// seed the PRE-writer row → backfillQuestionBlockGenesis anchors it as the event-sourced BASE → run the
// REAL writer → the fold (genesis BASE + the set_status lifecycle event) must equal the live row. This
// is a divergence check: it would FAIL if a future edit changed the imperative UPDATE's
// status/imported_*/version without matching the lifecycle-event payload (or vice versa) — a one-sided
// drift the payload-only writeEvent→parseEvent barrier and the behavioural status assertions cannot see.

const SET_STATUS_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';

// MATCH the seeded KC so no real embedding model runs (mirrors revert-auto-enroll.db.test.ts).
const setStatusTagging = async () => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.95, reasoning: 'ok' }],
  overall_confidence: 0.95,
  reasoning: 'high',
});

const SET_STATUS_FAILURE_DRAFT: MistakeEnrollOutputT = {
  wrong_answer: 'failure',
  question_type: 'computation',
  difficulty: 3,
  cause: {
    primary_category: 'other',
    secondary_categories: [],
    analysis_md: 'drafted',
    confidence: 0.7,
  },
  overall_confidence: 0.66,
  reasoning: 'wrong',
};

describe('W3-D — question_block set_status parity through runAutoEnrollForSession (real writer)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a clean auto-enroll folds == row (status=auto_enrolled + imported_* + version bumped)', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
    const sessionId = 'sess_enroll';
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      status: 'extracted',
      source_document_id: 'doc_enroll',
      source_asset_ids: ['asset_1'],
      entrypoint: 'vision_paper',
      warnings: [],
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
    // ONE answered draft block (the PRE-writer state).
    await testDb()
      .insert(question_block)
      .values({
        id: 'qbe_1',
        ingestion_session_id: sessionId,
        source_document_id: null,
        source_asset_ids: ['asset_1'],
        page_spans: [],
        extracted_prompt_md: 'legacy prompt md',
        structured: {
          id: 'qbe_1',
          role: 'standalone',
          prompt_text: '下列句中「之」的用法',
          source: 'vlm_structure',
        },
        figures: [],
        layout_quality: 'structured',
        reference_md: '参考',
        wrong_answer_md: '学生错答',
        image_refs: ['asset_1'],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 1,
        status: 'draft',
        knowledge_hint: '之',
        merged_from_block_ids: [],
        imported_question_id: null,
        imported_attempt_event_id: null,
        created_at: T0,
        updated_at: T0,
        version: 0,
      });

    // Anchor the DRAFT (PRE-writer) state as the event-sourced BASE BEFORE auto-enroll runs.
    await backfillQuestionBlockGenesis(db, T0);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [SET_STATUS_FLAG]: 'true' },
      runTaggingFn: setStatusTagging,
      tagKnowledgeFn: async () => ({ kind: 'match' as const, knowledge_ids: ['k1'] }),
      runMistakeEnrollFn: vi.fn(async () => SET_STATUS_FAILURE_DRAFT),
    });
    expect(result.enrolled).toBe(1);

    const row = await liveBlockRow('qbe_1');
    expect(row?.status).toBe('auto_enrolled');
    expect(row?.imported_question_id).not.toBeNull();
    expect(row?.version).toBe(1);

    // The fold reproduces the live row byte-for-byte through the set_status lifecycle branch.
    const qlive = await liveBlockRow('qbe_1');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qbe_1'),
      qlive ? questionBlockLiveRowToSnapshot(qlive) : null,
    );
  });
});

describe('W3-D — question_block set_status parity through revertAutoEnrolledBlock (real writer)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a clean revert folds == row (status reset to draft + imported_* cleared + version bumped)', async () => {
    const db = testDb();
    const sessionId = 'sess_revert';
    const questionId = 'q_revert';
    const originEventId = 'evt_origin_revert';
    // PRE-state: an auto_enrolled block linked to a question + its origin (attempt) event.
    await testDb()
      .insert(question_block)
      .values({
        id: 'qbr_1',
        ingestion_session_id: sessionId,
        source_document_id: null,
        source_asset_ids: [],
        page_spans: [],
        extracted_prompt_md: 'legacy prompt md',
        structured: node('qbr_1', 'reverted prompt'),
        figures: [],
        layout_quality: 'structured',
        reference_md: null,
        wrong_answer_md: null,
        image_refs: [],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 1,
        status: 'auto_enrolled',
        knowledge_hint: null,
        merged_from_block_ids: [],
        imported_question_id: questionId,
        imported_attempt_event_id: originEventId,
        created_at: T0,
        updated_at: T0,
        version: 0,
      });
    // The active learning_record revert looks up (by question_id) + archives; origin_event_id is the
    // retract target. None of these columns carry an FK, so a minimal row suffices.
    await db.insert(learning_record).values({
      id: 'lr_revert',
      kind: 'mistake',
      source: 'ingestion',
      capture_mode: 'image',
      activity_kind: 'capture',
      question_id: questionId,
      origin_event_id: originEventId,
      created_at: T0,
      updated_at: T0,
    });

    // Anchor the auto_enrolled (PRE-revert) state as the event-sourced BASE.
    await backfillQuestionBlockGenesis(db, T0);

    const res = await revertAutoEnrolledBlock(db, { blockId: 'qbr_1', sessionId });
    expect(res.questionId).toBe(questionId);

    const row = await liveBlockRow('qbr_1');
    expect(row?.status).toBe('draft');
    expect(row?.imported_question_id).toBeNull();
    expect(row?.imported_attempt_event_id).toBeNull();
    expect(row?.version).toBe(1);

    // The fold reproduces the live row byte-for-byte: genesis(auto_enrolled, imported_* set) +
    // set_status(draft, imported_* explicitly cleared).
    const qlive = await liveBlockRow('qbr_1');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qbr_1'),
      qlive ? questionBlockLiveRowToSnapshot(qlive) : null,
    );
  });
});

// YUK-471 W3-D flip hardening — ON-path CONCURRENCY invariants (owner pre-flip insurance, P4-class).
// The runbook (2026-06-27-yuk471-w3d-flip-runbook.md §1 P4) classifies the ON-path lost-update window as
// NOT a flip blocker because the wired edit writers now take `SELECT … FOR UPDATE` (C3 fix). These tests
// pin that guarantee end-to-end with the per-entity flag ON, so a future refactor that drops the row lock
// regresses LOUDLY instead of silently corrupting prod after the flip.
//
// The two wired writers have DIFFERENT concurrency contracts (read the code, not the symmetry):
//   - artifact (editArtifactBodyBlocks): FOR UPDATE + OPTIMISTIC CAS (`row.version !== expectedArtifactVersion`
//     → 409, thrown BEFORE the fold-source event is emitted, so the loser's whole tx rolls back with no
//     orphan event). Two same-base edits → exactly ONE commits, the other 409s. Final version == 1.
//   - question_block (updatePrompt): FOR UPDATE, NO CAS (`version = currentVersion + 1` read under the lock).
//     Two edits → the lock SERIALIZES them, the 2nd reads the 1st's committed version → BOTH commit and
//     RETURN distinct versions {1,2} (last-write-wins on the tree).
//
// TEETH live in the EXACT count / returned-version assertions — NOT in fold==row. On the ON path the row is
// written AS a fold output (projectXGuarded folds the events → upserts), and the test re-folds the SAME
// events, so fold==row holds BY CONSTRUCTION even under a dropped lock; it's a consistency check (catches a
// snapshot-mapper / fold-determinism bug), not the lock guarantee. Drop the FOR UPDATE and: the artifact
// case yields TWO winners (both read v0, both pass the CAS → fulfilled count 2 ≠ 1); the question_block case
// has both writers return version 1 (both read v0 → {1,1} ≠ {1,2}). Those are the assertions that bite.

describe('W3-D — ON-path concurrency: artifact (FOR UPDATE + optimistic CAS)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PROJECTION_IS_WRITER_ARTIFACT = '0';
  });

  it('ON: two same-base concurrent edits → exactly one wins (loser 409s), version==1, winner body persisted, fold==row', async () => {
    const db = testDb();
    await insertNoteArtifact('art_cc', 'Original Title');
    await backfillArtifactGenesis(db, T0);
    process.env.PROJECTION_IS_WRITER_ARTIFACT = '1';

    // Both edits race off the SAME base version (0). FOR UPDATE serializes them; the loser then reads the
    // winner's bumped version and trips the optimistic CAS (409) BEFORE emitting any event.
    const settled = await Promise.allSettled([
      editArtifactBodyBlocks({
        db,
        artifactId: 'art_cc',
        expectedArtifactVersion: 0,
        bodyBlocks: doc('edit-A'),
      }),
      editArtifactBodyBlocks({
        db,
        artifactId: 'art_cc',
        expectedArtifactVersion: 0,
        bodyBlocks: doc('edit-B'),
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    // EXACTLY one of each. Two winners would mean the lost-update window is open (FOR UPDATE regressed).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /concurrently modified|conflict/i,
    );

    const winner = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof editArtifactBodyBlocks>>>
    ).value;
    expect(winner.artifact_version).toBe(1);

    const row = await liveArtifactRow('art_cc');
    // Single bump (0→1), not a double-bump: the loser never wrote.
    expect(row?.version).toBe(1);
    // The winner's body is persisted; the loser's `doc(...)` is absent (no torn / lost write).
    expect(row?.body_blocks).toEqual(winner.body_blocks);
    // fold reproduces the row: genesis(v0) + the SINGLE winning body_blocks_edit event(v1). The loser
    // threw at the CAS check (which precedes the event emit), so no orphan event pollutes the fold.
    const live = await liveArtifactRow('art_cc');
    expectFoldEqualsRow(
      await gatherAndFoldArtifact(db, 'art_cc'),
      live ? artifactLiveRowToSnapshot(live) : null,
    );
  });

  it('ON: sequential edits bump version monotonically 0→1→2 and the fold accumulates every edit', async () => {
    const db = testDb();
    await insertNoteArtifact('art_seq', 'Original Title');
    await backfillArtifactGenesis(db, T0);
    process.env.PROJECTION_IS_WRITER_ARTIFACT = '1';

    const first = await editArtifactBodyBlocks({
      db,
      artifactId: 'art_seq',
      expectedArtifactVersion: 0,
      bodyBlocks: doc('edit-1'),
    });
    expect(first.artifact_version).toBe(1);
    const second = await editArtifactBodyBlocks({
      db,
      artifactId: 'art_seq',
      expectedArtifactVersion: 1, // CAS now demands the post-first version
      bodyBlocks: doc('edit-2'),
    });
    expect(second.artifact_version).toBe(2);

    const row = await liveArtifactRow('art_seq');
    expect(row?.version).toBe(2);
    expect(row?.body_blocks).toEqual(doc('edit-2')); // latest edit wins
    // fold = genesis(v0) + edit-1(v1) + edit-2(v2); the ON-path re-fold replays every event, so the row
    // the 2nd projection wrote == fold(all three events).
    const live = await liveArtifactRow('art_seq');
    expectFoldEqualsRow(
      await gatherAndFoldArtifact(db, 'art_seq'),
      live ? artifactLiveRowToSnapshot(live) : null,
    );
  });
});

describe('W3-D — ON-path concurrency: question_block (FOR UPDATE serialize, no CAS)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PROJECTION_IS_WRITER_QUESTION_BLOCK = '0';
  });

  it('ON: two concurrent structured edits serialize on the row lock → both commit with distinct versions {1,2}, fold==row', async () => {
    const db = testDb();
    await insertDraftBlock('qb_cc');
    await backfillQuestionBlockGenesis(db, T0);
    process.env.PROJECTION_IS_WRITER_QUESTION_BLOCK = '1';

    // updatePrompt has NO optimistic CAS: SELECT … FOR UPDATE serializes the two tx, the 2nd reads the
    // 1st's COMMITTED version and bumps again. Both commit (status stays 'draft' across both —
    // persistStructured never mutates status). NOTE: this exercises a real lock only because the test pool
    // holds ≥2 connections (tests/helpers/db.ts `max: 4`); with `max: 1` the two tx would serialize at the
    // connection layer, the row lock would never be contended, and both assertions below would still pass
    // vacuously — keep the pool at ≥2.
    const settled = await Promise.allSettled([
      updatePrompt(db, {
        blockId: 'qb_cc',
        nodeId: 'qb_cc',
        promptText: 'prompt-A',
        actorRef: 'A',
      }),
      updatePrompt(db, {
        blockId: 'qb_cc',
        nodeId: 'qb_cc',
        promptText: 'prompt-B',
        actorRef: 'B',
      }),
    ]);

    // BOTH succeed and BOTH report status:'written' (no 'skipped:not_draft' — the lock serializes, it
    // does not reject).
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = settled.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof updatePrompt>>>).value,
    );
    expect(values.map((v) => v.status)).toEqual(['written', 'written']);

    // THE DETERMINISTIC LOST-UPDATE TOOTH: the two writers return DISTINCT, monotonic versions {1,2}. The
    // 2nd writer could only return 2 by reading the 1st's COMMITTED version 1 under the held lock — exactly
    // what FOR UPDATE guarantees. Drop the lock and both read v0 → both return 1 → {1,1} ≠ {1,2}. Sorted
    // because which writer is A vs B in the array is the nondeterministic race winner; this is INDEPENDENT
    // of the fold's event ordering (unlike the folded row.version, deliberately not asserted below).
    const returnedVersions = values.map((v) => v.version ?? -1).sort((a, b) => a - b);
    expect(returnedVersions).toEqual([1, 2]);

    const row = await liveBlockRow('qb_cc');
    // The row reflects ONE of the two serialized edits (the race winner is nondeterministic).
    expect(['prompt-A', 'prompt-B']).toContain(
      (row?.structured as StructuredQuestionT).prompt_text,
    );
    // We deliberately do NOT assert row.version === 2: the fold orders events by created_at (MILLISECOND
    // resolution) then id, so if the two serialized writers' single-clock `new Date()`s collide in the same
    // integer-ms the larger-id edit sorts last and the FOLDED row can resolve to version 1 — a pre-existing
    // property of the fold's tie-break, orthogonal to the lock guarantee this test pins (carried by
    // returnedVersions above). fold==row below is a CONSISTENCY check that holds by construction on the ON
    // path (the row IS a fold output), guarding the snapshot mapper / fold determinism — not the lock.
    const qlive = await liveBlockRow('qb_cc');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qb_cc'),
      qlive ? questionBlockLiveRowToSnapshot(qlive) : null,
    );
  });
});
