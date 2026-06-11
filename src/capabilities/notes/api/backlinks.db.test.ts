import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { artifact, artifact_block_ref, learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './backlinks';

const NOW = new Date('2026-05-29T00:00:00.000Z');

// One crossLinkBlock (id=`blockId`) pointing at `toArtifactId`. The crossLinkBlock
// is the REAL atom shape the writer emits (cross-link-picker.ts /
// hub_auto_sync_nightly) — `{ type, attrs }`, NO `content`. It sits beside a
// paragraph inside an enclosing semanticBlock; the backlink snippet
// (extractCrossLinkSnippet) sources from that enclosing block's text (FIX 2).
function sourceDoc(blockId: string, toArtifactId: string, text: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'semanticBlock',
        attrs: { id: `${blockId}_sec`, semantic_kind: 'definition' },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text }] },
          {
            type: 'crossLinkBlock',
            attrs: { id: blockId, artifact_id: toArtifactId, title: '目标' },
          },
        ],
      },
    ],
  };
}

async function seedArtifact(opts: {
  id: string;
  title: string;
  type?: string;
  generation_status?: string;
  archived_at?: Date | null;
  body_blocks?: unknown;
}): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id: opts.id,
      type: opts.type ?? 'note_atomic',
      title: opts.title,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: (opts.body_blocks ?? { type: 'doc', content: [] }) as never,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: opts.generation_status ?? 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      embedded_check_status: 'not_required',
      history: [],
      archived_at: opts.archived_at ?? null,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

// Seed a learning_item owning `primary_artifact_id`, so the backlink resolver can
// map from_artifact_id → owning learning_item.id (the link target). (YUK-160)
async function seedLearningItem(opts: {
  id: string;
  primaryArtifactId: string;
  archived_at?: Date | null;
}): Promise<void> {
  await testDb()
    .insert(learning_item)
    .values({
      id: opts.id,
      source: 'manual',
      title: `LI ${opts.id}`,
      primary_artifact_id: opts.primaryArtifactId,
      archived_at: opts.archived_at ?? null,
      created_at: NOW,
      updated_at: NOW,
    });
}

async function seedRef(opts: {
  from: string;
  fromBlock: string;
  to: string;
  refKind?: string;
}): Promise<void> {
  await testDb()
    .insert(artifact_block_ref)
    .values({
      from_artifact_id: opts.from,
      from_block_id: opts.fromBlock,
      to_artifact_id: opts.to,
      to_block_id: null,
      ref_kind: opts.refKind ?? 'cross_link',
    });
}

// Seed a user retract correction event on (artifactId, blockId) via the single
// writeEvent owner — no note-refine side effects (unlike mark_wrong).
async function seedRetract(artifactId: string, blockId?: string): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'artifact',
    subject_id: artifactId,
    outcome: 'success',
    payload: {
      correction_kind: 'retract',
      ...(blockId ? { block_id: blockId } : {}),
      reason_md: 'retracted for test',
    },
    created_at: NOW,
  });
}

function backlinksReq(toId: string): Request {
  return new Request(`http://localhost/api/artifacts/${toId}/backlinks`);
}

interface PanelRow {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
  snippet: string | null;
}

async function readRows(res: Response): Promise<PanelRow[]> {
  const body = (await res.json()) as { artifact_id: string; rows: PanelRow[] };
  return body.rows;
}

describe('GET /api/artifacts/[id]/backlinks', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns inbound cross_link refs joined to source title/type with a snippet', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      type: 'note_hub',
      body_blocks: sourceDoc('cl1', 'target', '这里引用了目标笔记的定义'),
    });
    await seedRef({ from: 'src', fromBlock: 'cl1', to: 'target' });

    const res = await GET(backlinksReq('target'), { id: 'target' });
    expect(res.status).toBe(200);

    const rows = await readRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_artifact_id: 'src',
      from_title: '来源笔记',
      from_type: 'note_hub',
      from_block_id: 'cl1',
      snippet: '这里引用了目标笔记的定义',
    });
  });

  it('excludes backlinks whose source artifact is archived or not ready', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'archived_src',
      title: '归档来源',
      archived_at: NOW,
      body_blocks: sourceDoc('cl_a', 'target', 'archived'),
    });
    await seedArtifact({
      id: 'pending_src',
      title: '待生成来源',
      generation_status: 'pending',
      body_blocks: sourceDoc('cl_p', 'target', 'pending'),
    });
    await seedArtifact({
      id: 'ready_src',
      title: '正常来源',
      body_blocks: sourceDoc('cl_r', 'target', 'ready snippet'),
    });
    await seedRef({ from: 'archived_src', fromBlock: 'cl_a', to: 'target' });
    await seedRef({ from: 'pending_src', fromBlock: 'cl_p', to: 'target' });
    await seedRef({ from: 'ready_src', fromBlock: 'cl_r', to: 'target' });

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows.map((r) => r.from_artifact_id)).toEqual(['ready_src']);
  });

  it('excludes a backlink whose source block was retracted (XC-5)', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('cl_keep', 'target', 'kept'),
    });
    // Second cross-link block on the same source, which we'll retract.
    await seedRef({ from: 'src', fromBlock: 'cl_keep', to: 'target' });
    await seedRef({ from: 'src', fromBlock: 'cl_gone', to: 'target' });
    await seedRetract('src', 'cl_gone');

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows.map((r) => r.from_block_id)).toEqual(['cl_keep']);
  });

  it('drops all backlinks from a source whose whole artifact is retracted', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('cl1', 'target', 'x'),
    });
    await seedRef({ from: 'src', fromBlock: 'cl1', to: 'target' });
    await seedRetract('src'); // whole-artifact retract (no block_id)

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toEqual([]);
  });

  it('ignores non-cross_link ref_kind rows (e.g. embedded_check)', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('q1', 'target', 'quiz ref'),
    });
    await seedRef({ from: 'src', fromBlock: 'q1', to: 'target', refKind: 'embedded_check' });

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toEqual([]);
  });

  it('returns empty rows when there are no inbound refs', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toEqual([]);
  });

  it('resolves from_learning_item_id from the source artifact owning learning_item (YUK-160)', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('cl1', 'target', 'x'),
    });
    await seedRef({ from: 'src', fromBlock: 'cl1', to: 'target' });
    // Owning learning_item whose primary_artifact_id is the SOURCE artifact id.
    await seedLearningItem({ id: 'li_src', primaryArtifactId: 'src' });

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toHaveLength(1);
    // The link target must be the learning_item id, NOT the artifact id (which 404s).
    expect(rows[0].from_learning_item_id).toBe('li_src');
    expect(rows[0].from_artifact_id).toBe('src');
  });

  it('returns null from_learning_item_id when the source has no owning learning_item', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('cl1', 'target', 'x'),
    });
    await seedRef({ from: 'src', fromBlock: 'cl1', to: 'target' });
    // No learning_item points at `src`.

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_learning_item_id).toBeNull();
  });

  it('returns null from_learning_item_id when the owning learning_item is archived', async () => {
    await seedArtifact({ id: 'target', title: '目标笔记' });
    await seedArtifact({
      id: 'src',
      title: '来源笔记',
      body_blocks: sourceDoc('cl1', 'target', 'x'),
    });
    await seedRef({ from: 'src', fromBlock: 'cl1', to: 'target' });
    await seedLearningItem({ id: 'li_src', primaryArtifactId: 'src', archived_at: NOW });

    const rows = await readRows(
      await GET(backlinksReq('target'), { id: 'target' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_learning_item_id).toBeNull();
  });

  it('returns 404 when the target artifact does not exist (mirrors the correct route)', async () => {
    const res = await GET(backlinksReq('does_not_exist'), { id: 'does_not_exist' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('not_found');
  });
});
