import { artifact, event } from '@/db/schema';
import { bodyBlocksToNoteSections, noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
    embedded_check_status: 'not_required',
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

  it('updates one section, appends artifact history, bumps versions, and writes edit event', async () => {
    await seedArtifact();
    const now = new Date('2026-05-25T10:00:00.000Z');

    const result = await editArtifactSection({
      db: testDb(),
      artifactId: 'a1',
      sectionId: 's1',
      expectedArtifactVersion: 0,
      expectedSectionVersion: 1,
      nextBodyMd: '新定义 **重点**',
      actorRef: 'test-user',
      eventId: 'evt_section_edit_1',
      now,
    });

    expect(result.artifact_version).toBe(1);
    expect(result.section).toMatchObject({
      id: 's1',
      body_md: '新定义 **重点**',
      version: 2,
    });
    expect(result.event_id).toBe('evt_section_edit_1');

    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(row.version).toBe(1);
    const sections = bodyBlocksToNoteSections(row.body_blocks);
    expect(sections[0]).toMatchObject({ id: 's1', body_md: '新定义 **重点**', version: 2 });
    expect(sections[1]).toMatchObject({ id: 's2', body_md: '旧例子', version: 3 });

    const history = row.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      action: 'block_edit',
      block_id: 's1',
      block_index: 0,
      previous_body_md: '旧定义',
      next_body_md: '新定义 **重点**',
      previous_version: 1,
      next_version: 2,
      event_id: 'evt_section_edit_1',
    });

    const events = await testDb().select().from(event).where(eq(event.id, 'evt_section_edit_1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_kind: 'user',
      actor_ref: 'test-user',
      action: 'experimental:artifact_section_edit',
      subject_kind: 'artifact',
      subject_id: 'a1',
      outcome: 'success',
    });
    expect(events[0].payload).toMatchObject({
      artifact_id: 'a1',
      block_id: 's1',
      block_index: 0,
      previous_body_md: '旧定义',
      next_body_md: '新定义 **重点**',
      previous_version: 1,
      next_version: 2,
    });
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

  it('rejects missing sections with not_found', async () => {
    await seedArtifact({ body_blocks: null });

    await expect(
      editArtifactSection({
        db: testDb(),
        artifactId: 'a1',
        sectionId: 's1',
        expectedArtifactVersion: 0,
        expectedSectionVersion: 1,
        nextBodyMd: 'next',
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('rejects malformed body_blocks with validation_error instead of section not_found', async () => {
    await seedArtifact({
      body_blocks: { type: 'doc', content: [{ text: 'missing type' }] } as never,
    });

    await expect(
      editArtifactSection({
        db: testDb(),
        artifactId: 'a1',
        sectionId: 's1',
        expectedArtifactVersion: 0,
        expectedSectionVersion: 1,
        nextBodyMd: 'next',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 500 });
  });
});
