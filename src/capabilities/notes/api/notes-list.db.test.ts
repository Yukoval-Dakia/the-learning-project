import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { NoteListResponseSchema } from './contracts';
import { GET } from './notes-list';

const KNOWLEDGE_BASE = {
  parent_id: null,
  archived_at: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(id: string, domain: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain,
      ...KNOWLEDGE_BASE,
      created_at: now,
      updated_at: now,
    });
}

async function seedNote(id: string, knowledgeId: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note_atomic',
      title: id,
      knowledge_ids: [knowledgeId],
      generation_status: 'ready',
      verification_status: 'not_required',
      intent_source: 'test',
      source: 'test',
      archived_at: null,
      created_at: now,
      updated_at: now,
    });
}

describe('GET /api/notes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('filters note rows by the derived subject query', async () => {
    await seedKnowledge('k_yuwen', 'yuwen');
    await seedKnowledge('k_math', 'math');
    await seedNote('note_yuwen', 'k_yuwen');
    await seedNote('note_math', 'k_math');

    const res = await GET(new Request('http://localhost/api/notes?subject=math'));
    expect(res.status).toBe(200);
    const body = NoteListResponseSchema.parse(await res.json());
    expect(body.rows.map((row) => row.id)).toEqual(['note_math']);
  });
});
