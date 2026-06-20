// YUK-203 P1/P5 alignment — GET /api/notes/[id] route test.
//
// Verifies the canonical NoteReader backend route returns the aggregated note
// payload and keeps archived/non-note artifacts out of the reader surface.

import { artifact, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './note-page-route';

const A_BASE = {
  intent_source: 'test',
  source: 'test',
  verification_status: 'not_required',
};

async function getNote(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/notes/${id}`), { id });
}

describe('GET /api/notes/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 404 for unknown, archived, or non-note artifacts', async () => {
    const db = testDb();
    const now = new Date();

    expect((await getNote('missing')).status).toBe(404);

    await db.insert(artifact).values({
      id: 'archived-note',
      type: 'note_atomic',
      title: 'archived',
      knowledge_ids: [],
      generation_status: 'ready',
      archived_at: now,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
    expect((await getNote('archived-note')).status).toBe(404);

    await db.insert(artifact).values({
      id: 'quiz-artifact',
      type: 'tool_quiz',
      title: 'quiz',
      knowledge_ids: [],
      generation_status: 'ready',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
    expect((await getNote('quiz-artifact')).status).toBe(404);
  });

  it('returns the aggregated note reader payload', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_zhi',
      name: '之 · 用法',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(artifact).values({
      id: 'note_zhi',
      type: 'note_atomic',
      title: '「之」的四类核心用法',
      knowledge_ids: ['k_zhi'],
      body_blocks: {
        type: 'doc',
        content: [
          {
            type: 'semanticBlock',
            attrs: {
              id: 'b1',
              semantic_kind: 'definition',
              source_tier: 'user_verified',
              user_verified: true,
              version: 0,
              source_markdown: '结构助词、代词、动词、主谓取独。',
            },
            content: [],
          },
        ],
      } as never,
      generation_status: 'ready',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });

    const res = await getNote('note_zhi');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      labels: Array<{ id: string; name: string }>;
      sections: Array<{ id: string; kind: string }>;
      subject_profile: { id: string; displayName: string };
    };
    expect(body.id).toBe('note_zhi');
    expect(body.labels).toEqual([{ id: 'k_zhi', name: '之 · 用法' }]);
    expect(body.sections).toEqual([expect.objectContaining({ id: 'b1', kind: 'definition' })]);
    expect(body.subject_profile).toMatchObject({ id: 'wenyan', displayName: '文言文' });
  });
});
