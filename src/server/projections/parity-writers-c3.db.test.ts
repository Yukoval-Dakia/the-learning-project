// Canonical editor, lifecycle and concurrency contracts for Artifact/QuestionBlock.
// Public writers must preserve event/live equality and reject unprepared legacy data.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { updatePrompt } from '@/capabilities/ingestion/server/block-structured-edit';
import { editArtifactBodyBlocks } from '@/capabilities/notes/server/body-blocks-edit';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
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
