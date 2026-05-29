// YUK-95 P5 Lane-0 — single-owner write-through for the artifact_block_ref L2
// backlink index. These tests drive `syncBlockRefsForArtifact` (the generic
// cross_link recompute, scoped by ref_kind) + `listBacklinks` (inbound ref
// reader), and the regression that embedded_check rows survive a cross_link sync.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { NotePatchT } from '@/core/schema/note-patch';
import { artifact, artifact_block_ref } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listBacklinks, syncBlockRefsForArtifact } from './block-refs';
import { persistNoteRefineApply } from './note-refine-apply';

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

// silence unused import lint if `and` ends up unreferenced after edits
void and;
