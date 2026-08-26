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

async function seedNote(id: string, knowledgeId: string, bodyText?: string): Promise<void> {
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
      ...(bodyText
        ? {
            body_blocks: {
              type: 'doc' as const,
              content: [{ type: 'text', text: bodyText }],
            },
          }
        : {}),
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

  it('matches notes by title or body text via the query param', async () => {
    await seedKnowledge('k_yuwen', 'yuwen');
    await seedKnowledge('k_math', 'math');
    await seedNote('note_title_hit', 'k_yuwen');
    await seedNote('note_body_hit', 'k_yuwen', '正文关键词：同位角相等');
    await seedNote('note_plain', 'k_math');

    const byTitle = await GET(new Request('http://localhost/api/notes?query=title_hit'));
    expect(byTitle.status).toBe(200);
    expect(NoteListResponseSchema.parse(await byTitle.json()).rows.map((row) => row.id)).toEqual([
      'note_title_hit',
    ]);

    // 标题不含关键词、正文包含 → 命中（body_blocks 序列化文本匹配）。
    const byBody = await GET(new Request('http://localhost/api/notes?query=同位角'));
    expect(byBody.status).toBe(200);
    expect(NoteListResponseSchema.parse(await byBody.json()).rows.map((row) => row.id)).toEqual([
      'note_body_hit',
    ]);
  });

  it('composes the query with the subject filter', async () => {
    await seedKnowledge('k_yuwen', 'yuwen');
    await seedKnowledge('k_math', 'math');
    await seedNote('note_body_hit', 'k_yuwen', '正文关键词：同位角相等');

    const res = await GET(new Request('http://localhost/api/notes?query=同位角&subject=math'));
    expect(res.status).toBe(200);
    expect(NoteListResponseSchema.parse(await res.json()).rows).toEqual([]);
  });
});
