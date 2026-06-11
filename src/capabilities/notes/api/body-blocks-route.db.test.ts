import { artifact, event } from '@/db/schema';
import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH } from './body-blocks-route';

const NOTE_SECTIONS = [
  {
    id: 'b1',
    kind: 'definition',
    body_md: '旧定义',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 0,
  },
] as const;

async function seedArtifact() {
  const now = new Date('2026-05-28T00:00:00.000Z');
  await testDb()
    .insert(artifact)
    .values({
      id: 'a1',
      type: 'note_atomic',
      title: '原子笔记',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: noteSectionsToBodyBlocks(NOTE_SECTIONS as never) as never,
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
    });
}

function patchReq(body: unknown) {
  return new Request('http://localhost/api/artifacts/a1/body-blocks', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/artifacts/[id]/body-blocks', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('saves a body_blocks document and writes an edit event', async () => {
    await seedArtifact();
    const next = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'definition', source_tier: 'llm_only', version: 1 },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '新定义' }] }],
        },
      ],
    };

    const res = await PATCH(
      patchReq({
        artifact_version: 0,
        body_blocks: next,
      }),
      { id: 'a1' },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_version: number; body_blocks: unknown };
    expect(body.artifact_version).toBe(1);
    expect(body.body_blocks).toMatchObject(next);

    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(row.version).toBe(1);
    expect(row.body_blocks).toMatchObject(next);

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:artifact_body_blocks_edit'));
    expect(events).toHaveLength(1);
  });

  it('returns 409 on stale artifact version', async () => {
    await seedArtifact();

    const res = await PATCH(
      patchReq({
        artifact_version: 99,
        body_blocks: { type: 'doc', content: [] },
      }),
      { id: 'a1' },
    );

    expect(res.status).toBe(409);
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(row.version).toBe(0);
  });
});
