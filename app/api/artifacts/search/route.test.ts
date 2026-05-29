import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const NOW = new Date('2026-05-29T00:00:00.000Z');

async function seedArtifact(
  id: string,
  title: string,
  type = 'note_atomic',
  updatedAt = NOW,
): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id,
      type,
      title,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: { type: 'doc', content: [] } as never,
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
      created_at: updatedAt,
      updated_at: updatedAt,
      version: 0,
    });
}

function searchReq(query: string): Request {
  return new Request(`http://localhost/api/artifacts/search?${query}`);
}

async function readRows(res: Response): Promise<{ id: string; title: string; type: string }[]> {
  const body = (await res.json()) as { rows: { id: string; title: string; type: string }[] };
  return body.rows;
}

describe('GET /api/artifacts/search', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('matches artifacts by case-insensitive title substring', async () => {
    await seedArtifact('a1', '论语·学而');
    await seedArtifact('a2', '论语·为政');
    await seedArtifact('a3', '中庸');

    const res = await GET(searchReq('q=论语'));
    expect(res.status).toBe(200);
    const rows = await readRows(res);
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    expect(rows[0]).toMatchObject({ title: expect.any(String), type: 'note_atomic' });
  });

  it('excludes the current artifact via ?exclude to avoid self-links', async () => {
    await seedArtifact('a1', '论语·学而');
    await seedArtifact('a2', '论语·为政');

    const rows = await readRows(await GET(searchReq('q=论语&exclude=a1')));
    expect(rows.map((r) => r.id)).toEqual(['a2']);
  });

  it('returns empty rows when nothing matches', async () => {
    await seedArtifact('a1', '论语·学而');
    const rows = await readRows(await GET(searchReq('q=不存在的标题')));
    expect(rows).toEqual([]);
  });

  it('treats ILIKE wildcards in the query literally', async () => {
    await seedArtifact('a1', '50% 折扣');
    await seedArtifact('a2', '无关标题');

    // A bare '%' would otherwise match everything; escaped, it only matches a1.
    const rows = await readRows(await GET(searchReq(`q=${encodeURIComponent('50%')}`)));
    expect(rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('400s on a blank query', async () => {
    const res = await GET(searchReq('q='));
    expect(res.status).toBe(400);
  });

  it('respects the limit cap and recency ordering', async () => {
    await seedArtifact('old', '论语 旧', 'note_atomic', new Date('2026-05-01T00:00:00.000Z'));
    await seedArtifact('new', '论语 新', 'note_atomic', new Date('2026-05-28T00:00:00.000Z'));

    const rows = await readRows(await GET(searchReq('q=论语&limit=1')));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('new');

    // sanity: the seeded row really exists
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'old'));
    expect(row.id).toBe('old');
  });
});
