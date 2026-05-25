import { artifact, event, learning_item } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../../tests/helpers/db';
import { GET as getLearningItem } from '../../../../learning-items/[id]/route';
import { PATCH } from './route';

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
    kind: 'check',
    body_md: '自检',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: { question_ids: [] },
    version: 1,
  },
] as const;

async function seedLearningItemWithArtifact() {
  const db = testDb();
  const now = new Date('2026-05-25T00:00:00.000Z');
  await db.insert(artifact).values({
    id: 'a1',
    type: 'note_atomic',
    title: '原子笔记',
    knowledge_id: null,
    parent_artifact_id: null,
    child_artifact_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    outline_json: null,
    sections: NOTE_SECTIONS as never,
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
  await db.insert(learning_item).values({
    id: 'li1',
    source: 'learning_intent',
    source_ref: null,
    title: '学习项',
    content: '',
    knowledge_ids: [],
    primary_artifact_id: 'a1',
    parent_learning_item_id: null,
    child_learning_item_ids: [],
    status: 'pending',
    user_pinned: false,
    ai_score: null,
    due_at: null,
    completed_at: null,
    dismissed_at: null,
    archived_at: null,
    archived_reason: null,
    reviewed_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function patchReq(body: unknown) {
  return new Request('http://localhost/api/artifacts/a1/sections/s1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/artifacts/[id]/sections/[sectionId]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('saves a section edit and learning-item detail reload returns the persisted markdown', async () => {
    await seedLearningItemWithArtifact();

    const res = await PATCH(
      patchReq({
        artifact_version: 0,
        section_version: 1,
        body_md: '新定义\n\n- 第一条',
      }),
      { params: Promise.resolve({ id: 'a1', sectionId: 's1' }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact_id: string;
      artifact_version: number;
      section: { id: string; body_md: string; version: number };
      event_id: string;
    };
    expect(body).toMatchObject({
      artifact_id: 'a1',
      artifact_version: 1,
      section: { id: 's1', body_md: '新定义\n\n- 第一条', version: 2 },
    });

    const reload = await getLearningItem(new Request('http://localhost/api/learning-items/li1'), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(reload.status).toBe(200);
    const detail = (await reload.json()) as {
      primary_artifact: {
        version: number;
        sections: Array<{ id: string; body_md: string; version: number }>;
      };
    };
    expect(detail.primary_artifact.version).toBe(1);
    expect(detail.primary_artifact.sections[0]).toMatchObject({
      id: 's1',
      body_md: '新定义\n\n- 第一条',
      version: 2,
    });

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:artifact_section_edit'));
    expect(events).toHaveLength(1);
  });

  it('returns 409 on stale artifact version', async () => {
    await seedLearningItemWithArtifact();

    const res = await PATCH(
      patchReq({
        artifact_version: 9,
        section_version: 1,
        body_md: 'stale',
      }),
      { params: Promise.resolve({ id: 'a1', sectionId: 's1' }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');

    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    const sections = row.sections as Array<{ id: string; body_md: string }>;
    expect(sections[0].body_md).toBe('旧定义');
  });
});
