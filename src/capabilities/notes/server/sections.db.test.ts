import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bodyBlocksToNoteSections,
  noteSectionsToBodyBlocks,
} from '@/capabilities/notes/server/body-blocks';
import { artifact, event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { editArtifactSection } from './sections';

const NOTE_SECTIONS = [
  {
    id: 's1',
    kind: 'definition',
    body_md: '旧定义',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
  {
    id: 's2',
    kind: 'example',
    body_md: '旧例子',
    source_tier: 'textbook',
    user_verified: true,
    embedded_check: null,
    version: 3,
  },
] as const;

async function seedArtifact(overrides: Partial<typeof artifact.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date('2026-05-25T00:00:00.000Z');
  await db.insert(artifact).values({
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
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  });
}

describe('editArtifactSection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects stale artifact version without changing sections or writing an event', async () => {
    await seedArtifact({ version: 4 });

    await expect(
      editArtifactSection({
        db: testDb(),
        artifactId: 'a1',
        sectionId: 's1',
        expectedArtifactVersion: 3,
        expectedSectionVersion: 1,
        nextBodyMd: '不应写入',
        actorRef: 'test-user',
        eventId: 'evt_section_edit_stale',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });

    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    const sections = bodyBlocksToNoteSections(row.body_blocks);
    expect(row.version).toBe(4);
    expect(sections[0]).toMatchObject({ id: 's1', body_md: '旧定义', version: 1 });

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, 'evt_section_edit_stale'));
    expect(events).toHaveLength(0);
  });
});
