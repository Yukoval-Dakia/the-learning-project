// YUK-95 P5 Lane-0 — single-owner write-through for the artifact_block_ref L2
// backlink index. These tests drive `syncBlockRefsForArtifact` (the generic
// cross_link recompute, scoped by ref_kind) + `listBacklinks` (inbound ref
// reader), and the regression that embedded_check rows survive a cross_link sync.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { NotePatchT } from '@/core/schema/note-patch';
import { artifact, artifact_block_ref, event } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listBacklinks, syncBlockRefsForArtifact } from './block-refs';
import { persistNoteRefineApply, undoNoteRefineApplyEvent } from './note-refine-apply';

function emptyDoc(): ArtifactBodyBlocksT {
  return { type: 'doc', content: [] };
}

function crossLinkBlock(opts: {
  id: string;
  artifact_id: string;
  block_id?: string;
  title?: string;
}): Record<string, unknown> {
  return {
    type: 'crossLinkBlock',
    attrs: {
      id: opts.id,
      artifact_id: opts.artifact_id,
      ...(opts.block_id ? { block_id: opts.block_id } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    },
  };
}

function semanticBlock(id: string, text: string): Record<string, unknown> {
  return {
    type: 'semanticBlock',
    attrs: { id, semantic_kind: 'definition' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function docWith(...nodes: Record<string, unknown>[]): ArtifactBodyBlocksT {
  return { type: 'doc', content: nodes };
}

async function seedArtifact(
  id: string,
  overrides: Partial<typeof artifact.$inferInsert> = {},
): Promise<void> {
  const db = testDb();
  const now = new Date('2026-05-29T00:00:00.000Z');
  await db.insert(artifact).values({
    id,
    type: 'note_atomic',
    title: `note ${id}`,
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: emptyDoc() as never,
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'verified',
    verification_summary: null,
    generated_by: null,
    verified_by: null,
    embedded_check_status: 'not_required',
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  });
}

async function selectRefs(fromArtifactId: string) {
  const db = testDb();
  return db
    .select()
    .from(artifact_block_ref)
    .where(eq(artifact_block_ref.from_artifact_id, fromArtifactId));
}

describe('syncBlockRefsForArtifact', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a cross_link ref row when body_blocks contains a crossLinkBlock', async () => {
    const db = testDb();
    await seedArtifact('from1');
    await seedArtifact('to1');

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'from1',
        docWith(crossLinkBlock({ id: 'cl1', artifact_id: 'to1', block_id: 'b9', title: 'T' })),
      );
    });

    const rows = await selectRefs('from1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_artifact_id: 'from1',
      from_block_id: 'cl1',
      to_artifact_id: 'to1',
      to_block_id: 'b9',
      ref_kind: 'cross_link',
    });
  });

  it('deletes the cross_link row when the crossLinkBlock is removed and re-saved', async () => {
    const db = testDb();
    await seedArtifact('from1');
    await seedArtifact('to1');

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'from1',
        docWith(crossLinkBlock({ id: 'cl1', artifact_id: 'to1' })),
      );
    });
    expect(await selectRefs('from1')).toHaveLength(1);

    // Re-save with the crossLinkBlock removed.
    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(tx, 'from1', docWith(semanticBlock('s1', 'plain body')));
    });
    expect(await selectRefs('from1')).toHaveLength(0);
  });

  it('skips self-refs and crossLinkBlocks missing artifact_id', async () => {
    const db = testDb();
    await seedArtifact('from1');
    await seedArtifact('to1');

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'from1',
        docWith(
          crossLinkBlock({ id: 'cl_self', artifact_id: 'from1' }), // self-ref → skip
          { type: 'crossLinkBlock', attrs: { id: 'cl_bad' } }, // no artifact_id → skip
          crossLinkBlock({ id: 'cl_ok', artifact_id: 'to1' }),
        ),
      );
    });

    const rows = await selectRefs('from1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_block_id: 'cl_ok', to_artifact_id: 'to1' });
  });

  it('dedupes identical desired cross_link rows (same from/from_block/to/to_block)', async () => {
    const db = testDb();
    await seedArtifact('from1');
    await seedArtifact('to1');

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'from1',
        docWith(
          crossLinkBlock({ id: 'cl1', artifact_id: 'to1', block_id: 'b1' }),
          crossLinkBlock({ id: 'cl1', artifact_id: 'to1', block_id: 'b1' }),
        ),
      );
    });

    expect(await selectRefs('from1')).toHaveLength(1);
  });

  it('REGRESSION: an embedded_check ref survives a subsequent cross_link sync', async () => {
    const db = testDb();
    await seedArtifact('from1');
    await seedArtifact('quizArtifact');
    await seedArtifact('to1');

    // Manually insert an embedded_check row (the embedded_check_generate writer's row).
    await db.insert(artifact_block_ref).values({
      from_artifact_id: 'from1',
      from_block_id: 'check_block',
      to_artifact_id: 'quizArtifact',
      to_block_id: null,
      ref_kind: 'embedded_check',
    });

    // Run a cross_link sync on a doc that has a DIFFERENT cross_link.
    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'from1',
        docWith(crossLinkBlock({ id: 'cl1', artifact_id: 'to1' })),
      );
    });

    const rows = await selectRefs('from1');
    const byKind = new Map(rows.map((r) => [r.ref_kind, r]));
    expect(rows).toHaveLength(2);
    expect(byKind.get('embedded_check')).toMatchObject({
      from_block_id: 'check_block',
      to_artifact_id: 'quizArtifact',
    });
    expect(byKind.get('cross_link')).toMatchObject({
      from_block_id: 'cl1',
      to_artifact_id: 'to1',
    });
  });
});

describe('listBacklinks', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns inbound refs with the source artifact title + type', async () => {
    const db = testDb();
    await seedArtifact('source1', { title: 'Source One', type: 'note_atomic' });
    await seedArtifact('target1', { title: 'Target' });

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'source1',
        docWith(crossLinkBlock({ id: 'cl1', artifact_id: 'target1', block_id: 'tb1' })),
      );
    });

    const backlinks = await listBacklinks(db, { toArtifactId: 'target1' });
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({
      from_artifact_id: 'source1',
      from_block_id: 'cl1',
      from_artifact_title: 'Source One',
      from_artifact_type: 'note_atomic',
      to_artifact_id: 'target1',
      to_block_id: 'tb1',
      ref_kind: 'cross_link',
    });
  });

  it('filters by toBlockId when provided', async () => {
    const db = testDb();
    await seedArtifact('source1');
    await seedArtifact('target1');

    await db.transaction(async (tx) => {
      await syncBlockRefsForArtifact(
        tx,
        'source1',
        docWith(
          crossLinkBlock({ id: 'clA', artifact_id: 'target1', block_id: 'blockA' }),
          crossLinkBlock({ id: 'clB', artifact_id: 'target1', block_id: 'blockB' }),
        ),
      );
    });

    const onlyA = await listBacklinks(db, { toArtifactId: 'target1', toBlockId: 'blockA' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]).toMatchObject({ from_block_id: 'clA', to_block_id: 'blockA' });
  });

  it('returns empty when nothing points at the artifact', async () => {
    const db = testDb();
    await seedArtifact('target1');
    expect(await listBacklinks(db, { toArtifactId: 'target1' })).toEqual([]);
  });
});

describe('persistNoteRefineApply → block-ref sync in the same tx', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('syncs a cross_link row when an AI patch appends a crossLinkBlock', async () => {
    const db = testDb();
    await seedArtifact('from1', {
      body_blocks: docWith(semanticBlock('s1', 'existing body')) as never,
    });
    await seedArtifact('to1');

    const patch: NotePatchT = {
      ops: [
        {
          kind: 'append_block',
          block: crossLinkBlock({ id: 'cl_new', artifact_id: 'to1', block_id: 'tb1' }) as never,
        },
      ],
    };

    const result = await persistNoteRefineApply({ db, artifactId: 'from1', patch });
    expect(result.status).toBe('applied');

    const rows = await selectRefs('from1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_artifact_id: 'from1',
      from_block_id: 'cl_new',
      to_artifact_id: 'to1',
      to_block_id: 'tb1',
      ref_kind: 'cross_link',
    });
  });
});

describe('undoNoteRefineApplyEvent — optimistic lock on restore', () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  // Helper: apply a patch (→ writes the apply event we later undo) and return
  // both its event id and the post-apply body so we can assert non-mutation.
  async function seedApplied() {
    const db = testDb();
    await seedArtifact('note1', {
      body_blocks: docWith(semanticBlock('s1', 'original body')) as never,
    });
    const apply = await persistNoteRefineApply({
      db,
      artifactId: 'note1',
      patch: {
        ops: [{ kind: 'append_block', block: semanticBlock('s2', 'ai-added body') as never }],
      },
    });
    expect(apply.status).toBe('applied');
    expect(apply.artifact_version).toBe(1);
    if (!apply.event_id) throw new Error('apply event id missing');
    return { db, applyEventId: apply.event_id };
  }

  it('undoes cleanly when no concurrent writer touched the artifact', async () => {
    const { db, applyEventId } = await seedApplied();

    const result = await undoNoteRefineApplyEvent(db, { applyEventId });
    expect(result.status).toBe('undone');

    // Body restored to the pre-apply doc; version bumped to 2 (1 apply + 1 undo).
    const [row] = await db
      .select({ version: artifact.version, body_blocks: artifact.body_blocks })
      .from(artifact)
      .where(eq(artifact.id, 'note1'));
    expect(row?.version).toBe(2);
    expect(row?.body_blocks).toEqual(docWith(semanticBlock('s1', 'original body')));
  });

  it('returns version_conflict (NOT undone) when the artifact is bumped between undo load and restore — note unmutated, undo event NOT written, retry still possible', async () => {
    const { db, applyEventId } = await seedApplied();

    // Reproduce the race deterministically. The production undo loads the
    // artifact's current version inside its tx (call it V), then runs the restore
    // UPDATE guarded by `WHERE version = V`. In the real race a concurrent writer
    // (e.g. hub_auto_sync) bumps the version after undo's load but before its
    // UPDATE, so `WHERE version = V` matches 0 rows.
    //
    // To stage that without fighting drizzle's lazy query builder, we (a) bump
    // the LIVE row to version 2 up-front, then (b) make undo's in-tx artifact
    // load return the STALE snapshot (version 1) by stubbing `tx.select` to yield
    // it for the load query. Undo then locks its restore on V=1 while the live
    // row is at V=2 → the optimistic-lock UPDATE matches 0 rows, identical to the
    // production race outcome.
    const concurrentBody = docWith(semanticBlock('s3', 'concurrent edit')) as never;
    await db
      .update(artifact)
      .set({ version: 2, body_blocks: concurrentBody })
      .where(eq(artifact.id, 'note1'));

    const staleRow = { id: 'note1', version: 1, archived_at: null };
    const realTransaction = db.transaction.bind(db);
    const txSpy = vi
      .spyOn(db, 'transaction')
      .mockImplementation((cb: Parameters<typeof db.transaction>[0]) =>
        realTransaction((tx) => {
          const realSelect = tx.select.bind(tx);
          let served = false;
          // @ts-expect-error — shim over drizzle's overloaded select
          tx.select = (...args: unknown[]) => {
            if (!served) {
              served = true;
              // Undo's first SELECT is the artifact version load. Return the
              // stale snapshot via a thenable chain shaped like the real builder.
              const thenable = {
                from: () => thenable,
                where: () => thenable,
                limit: () => Promise.resolve([staleRow]),
              };
              return thenable as never;
            }
            // @ts-expect-error — pass through drizzle's overload args
            return realSelect(...args);
          };
          return cb(tx);
        }),
      );

    const result = await undoNoteRefineApplyEvent(db, { applyEventId });
    txSpy.mockRestore();

    // 1. Undo reports the conflict, NOT a false success.
    expect(result.status).toBe('skipped:version_conflict');
    expect(result.event_id).toBeUndefined();

    // 2. The note was NOT mutated by undo: it still holds the concurrent writer's
    //    body at the concurrent version (undo's restore matched 0 rows).
    const [row] = await db
      .select({ version: artifact.version, body_blocks: artifact.body_blocks })
      .from(artifact)
      .where(eq(artifact.id, 'note1'));
    expect(row?.version).toBe(2);
    expect(row?.body_blocks).toEqual(docWith(semanticBlock('s3', 'concurrent edit')));

    // 3. No undo event was written → the already_undone guard does NOT block a
    //    retry. Re-running undo (now against the settled live version) succeeds.
    const retry = await undoNoteRefineApplyEvent(db, { applyEventId });
    expect(retry.status).toBe('undone');
    const [restored] = await db
      .select({ body_blocks: artifact.body_blocks })
      .from(artifact)
      .where(eq(artifact.id, 'note1'));
    expect(restored?.body_blocks).toEqual(docWith(semanticBlock('s1', 'original body')));
  });

  it('scopes the already-undone check to this apply event (unrelated undo events do not block)', async () => {
    const { db, applyEventId } = await seedApplied();

    // An unrelated undo event for a DIFFERENT apply event must not trip the
    // already-undone guard for THIS apply event.
    await db.insert(event).values({
      id: 'unrelated_undo',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:note_refine_undo',
      subject_kind: 'artifact',
      subject_id: 'some_other_artifact',
      outcome: 'success',
      payload: { undone_event_id: 'some_other_apply_event' },
      caused_by_event_id: 'some_other_apply_event',
      created_at: new Date(),
    });

    const result = await undoNoteRefineApplyEvent(db, { applyEventId });
    expect(result.status).toBe('undone');
  });
});

// silence unused import lint if `and` ends up unreferenced after edits
void and;
