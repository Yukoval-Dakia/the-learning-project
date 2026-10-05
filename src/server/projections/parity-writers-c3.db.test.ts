// Canonical editor, lifecycle and concurrency contracts for Artifact/QuestionBlock.
// Public writers must preserve event/live equality and reject unprepared legacy data.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { captureIngestionOriginal } from '@/capabilities/ingestion/server/assessment-capture';
import { runAutoEnrollForSession } from '@/capabilities/ingestion/server/auto-enroll';
import {
  reassignFigure,
  updatePrompt,
} from '@/capabilities/ingestion/server/block-structured-edit';
import { revertAutoEnrolledBlock } from '@/capabilities/ingestion/server/revert-auto-enroll';
import { editArtifactBodyBlocks } from '@/capabilities/notes/server/body-blocks-edit';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import {
  artifact,
  assessment_submission,
  evaluation,
  knowledge,
  learning_record,
  learning_session,
  question_block,
  source_asset,
} from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
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

  it('canonical edit updates body/version and matches its fold', async () => {
    const db = testDb();
    await insertNoteArtifact('art_1', 'Original Title');
    await backfillArtifactGenesis(db, T0); // anchor → event-sourced → the assert runs

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

  it('rejects an unprepared legacy note without publishing an edit', async () => {
    const db = testDb();
    await insertNoteArtifact('art_2', 'Original Title');

    await expect(
      editArtifactBodyBlocks({
        db,
        artifactId: 'art_2',
        expectedArtifactVersion: 0,
        bodyBlocks: doc('edited'),
      }),
    ).rejects.toThrow(/requires complete history/i);
  });

  it('ON: projectArtifactGuarded becomes the row writer — re-folds EVERY column, overwriting the tamper', async () => {
    const db = testDb();
    await insertNoteArtifact('art_3', 'Original Title');
    await backfillArtifactGenesis(db, T0);
    await db.update(artifact).set({ title: 'TAMPERED' }).where(eq(artifact.id, 'art_3'));

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

  it('canonical structured edit updates prompt/version and matches its fold', async () => {
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

  it('rejects an unprepared legacy question block without publishing an edit', async () => {
    const db = testDb();
    await insertDraftBlock('qb_2');

    await expect(
      updatePrompt(db, {
        blockId: 'qb_2',
        nodeId: 'qb_2',
        promptText: 'edited prompt',
        actorRef: 'tester',
      }),
    ).rejects.toThrow(/requires complete history/i);
  });

  it('ON: projectQuestionBlockGuarded becomes the row writer — re-folds EVERY column, overwriting the tamper', async () => {
    const db = testDb();
    await insertDraftBlock('qb_3');
    await backfillQuestionBlockGenesis(db, T0);
    await db
      .update(question_block)
      .set({ reference_md: 'TAMPERED' })
      .where(eq(question_block.id, 'qb_3'));

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

async function seedNativeSetStatusBlock(sessionId: string, blockId: string) {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'yuwen',
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(source_asset).values({
    id: 'asset_1',
    kind: 'image',
    storage_key: 'offline/parity-page',
    mime_type: 'image/png',
    byte_size: 4096,
    sha256: 'a'.repeat(64),
    created_at: T0,
  });
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: 'doc_enroll',
    source_asset_ids: ['asset_1'],
    entrypoint: 'vision_paper',
    created_at: T0,
    updated_at: T0,
  });
  const [block] = await db
    .insert(question_block)
    .values({
      id: blockId,
      ingestion_session_id: sessionId,
      source_asset_ids: ['asset_1'],
      extracted_prompt_md: '阅读「学而时习之」。\n指出「之」所指的内容，保留原图以便复核上下文。',
      structured: {
        id: blockId,
        role: 'standalone',
        source: 'vlm_structure',
        prompt_text: '阅读「学而时习之」。\n指出「之」所指的内容，保留原图以便复核上下文。',
      },
      reference_md: '所学的内容',
      wrong_answer_md: '前往某地，是动词。',
      image_refs: ['asset_1'],
      layout_quality: 'structured',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: '之',
      created_at: T0,
      updated_at: T0,
      version: 0,
    })
    .returning();
  if (!block) throw new Error('native parity block missing');
  await backfillQuestionBlockGenesis(db, T0);
  const captured = await captureIngestionOriginal(db, {
    block,
    knowledgeIds: ['k1'],
    difficulty: 3,
    confidence: 1,
    canEnroll: true,
    pageRefs: ['asset_1'],
    now: T0,
  });
  if (!captured) throw new Error('native parity original missing');
  const publication = await publishQuestionGroupFromRow(db, {
    rootId: captured.questionId,
    actorRef: 'test:local-parity-reference',
    now: T0,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  expect(publication.status).toBe('admission_updated');
  return { db, captured };
}

async function enrollSetStatusBlock(sessionId: string) {
  return runAutoEnrollForSession({
    db: testDb(),
    sessionId,
    subjectId: 'yuwen',
    env: { [SET_STATUS_FLAG]: 'true' },
    runTaggingFn: setStatusTagging,
    tagKnowledgeFn: async () => ({ kind: 'match' as const, knowledge_ids: ['k1'] }),
  });
}

describe('W3-D — question_block set_status parity through runAutoEnrollForSession (real writer)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a clean auto-enroll folds == row (status=auto_enrolled + imported_* + version bumped)', async () => {
    const sessionId = 'sess_enroll';
    const { db, captured } = await seedNativeSetStatusBlock(sessionId, 'qbe_1');
    const result = await enrollSetStatusBlock(sessionId);
    expect(result.enrolled).toBe(1);

    const row = await liveBlockRow('qbe_1');
    expect(row?.status).toBe('auto_enrolled');
    expect(row?.imported_question_id).not.toBeNull();
    expect(row?.version).toBe(1);

    expect(row?.imported_question_id).toBe(captured.questionId);
    const [original] = await db.select().from(assessment_submission);
    const [judgment] = await db.select().from(evaluation);
    expect(judgment.submission_id).toBe(original.submission_id);
    const [record] = await db.select().from(learning_record);
    expect(record.attempt_event_id).toBe(row?.imported_attempt_event_id);

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
    const sessionId = 'sess_revert';
    const { db, captured } = await seedNativeSetStatusBlock(sessionId, 'qbr_1');
    const enrollment = await enrollSetStatusBlock(sessionId);
    expect(enrollment.enrolled).toBe(1);
    const before = await liveBlockRow('qbr_1');
    expect(before?.status).toBe('auto_enrolled');
    expectFoldEqualsRow(
      await gatherAndFoldQuestionBlock(db, 'qbr_1'),
      before ? questionBlockLiveRowToSnapshot(before) : null,
    );

    const res = await revertAutoEnrolledBlock(db, { blockId: 'qbr_1', sessionId });
    expect(res.questionId).toBe(captured.questionId);

    const row = await liveBlockRow('qbr_1');
    expect(row?.status).toBe('draft');
    expect(row?.imported_question_id).toBeNull();
    expect(row?.imported_attempt_event_id).toBeNull();
    expect(row?.version).toBe((before?.version ?? 0) + 1);

    const [record] = await db.select().from(learning_record);
    expect(record.archived_at).not.toBeNull();
    expect(res.retractedEventId).toBe(before?.imported_attempt_event_id);

    // Genesis plus both native lifecycle transitions reproduce the live row.
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

  it('ON: two same-base concurrent edits → exactly one wins (loser 409s), version==1, winner body persisted, fold==row', async () => {
    const db = testDb();
    await insertNoteArtifact('art_cc', 'Original Title');
    await backfillArtifactGenesis(db, T0);

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

  it('ON: two concurrent structured edits serialize on the row lock → both commit with distinct versions {1,2}, fold==row', async () => {
    const db = testDb();
    await insertDraftBlock('qb_cc');
    await backfillQuestionBlockGenesis(db, T0);

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
