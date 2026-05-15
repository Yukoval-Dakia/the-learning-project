import { knowledge, learning_item } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

const BASE_KNOWLEDGE = {
  name: 'test',
  domain: null,
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
  archived_at: null,
};

function baseLearningItem(over: Partial<typeof learning_item.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: 'li1',
    source: 'manual' as const,
    title: 'Test item',
    content: '',
    knowledge_ids: [] as string[],
    status: 'pending',
    created_at: now,
    updated_at: now,
    version: 0,
    ...over,
  };
}

describe('GET /api/learning-items', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when no items exist', async () => {
    const res = await GET(new Request('http://localhost/api/learning-items'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });

  it('returns items ordered by status priority (pending < in_progress < done)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values([
      baseLearningItem({
        id: 'li_done',
        status: 'done',
        updated_at: new Date(now.getTime() + 1),
      }),
      baseLearningItem({
        id: 'li_pending',
        status: 'pending',
        updated_at: new Date(now.getTime() + 3),
      }),
      baseLearningItem({
        id: 'li_inprogress',
        status: 'in_progress',
        updated_at: new Date(now.getTime() + 2),
      }),
    ]);

    const res = await GET(new Request('http://localhost/api/learning-items'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(3);
    const ids = body.rows.map((r) => r.id);
    expect(ids[0]).toBe('li_pending');
    expect(ids[1]).toBe('li_inprogress');
    expect(ids[2]).toBe('li_done');
  });

  it('excludes archived items', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values([
        baseLearningItem({ id: 'li_active' }),
        baseLearningItem({ id: 'li_archived', archived_at: now }),
      ]);

    const res = await GET(new Request('http://localhost/api/learning-items'));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('li_active');
  });

  it('excludes dismissed items', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values([
        baseLearningItem({ id: 'li_active' }),
        baseLearningItem({ id: 'li_dismissed', status: 'dismissed', dismissed_at: now }),
      ]);

    const res = await GET(new Request('http://localhost/api/learning-items'));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('li_active');
  });

  it('filters by ?status=pending — returns only pending items', async () => {
    const db = testDb();
    await db
      .insert(learning_item)
      .values([
        baseLearningItem({ id: 'li_pending', status: 'pending' }),
        baseLearningItem({ id: 'li_done', status: 'done' }),
      ]);

    const res = await GET(new Request('http://localhost/api/learning-items?status=pending'));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('li_pending');
  });

  it('filters by ?status=in_progress', async () => {
    const db = testDb();
    await db
      .insert(learning_item)
      .values([
        baseLearningItem({ id: 'li_pending', status: 'pending' }),
        baseLearningItem({ id: 'li_inprogress', status: 'in_progress' }),
      ]);

    const res = await GET(new Request('http://localhost/api/learning-items?status=in_progress'));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('li_inprogress');
  });

  it('returns 400 on invalid status filter', async () => {
    const res = await GET(new Request('http://localhost/api/learning-items?status=invalid'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('respects ?limit param (clamped to max 200)', async () => {
    const db = testDb();
    // Insert 3 items; limit=1 should return only 1
    await db
      .insert(learning_item)
      .values([
        baseLearningItem({ id: 'li1' }),
        baseLearningItem({ id: 'li2' }),
        baseLearningItem({ id: 'li3' }),
      ]);

    const res = await GET(new Request('http://localhost/api/learning-items?limit=1'));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('knowledge_ids returned as array (not raw JSON)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      ...BASE_KNOWLEDGE,
      created_at: now,
      updated_at: now,
    });
    await db.insert(learning_item).values(baseLearningItem({ id: 'li1', knowledge_ids: ['k1'] }));

    const res = await GET(new Request('http://localhost/api/learning-items'));
    const body = (await res.json()) as { rows: Array<{ knowledge_ids: unknown }> };
    expect(Array.isArray(body.rows[0].knowledge_ids)).toBe(true);
    expect(body.rows[0].knowledge_ids).toEqual(['k1']);
  });
});

describe('POST /api/learning-items', () => {
  beforeEach(async () => {
    await resetDb();
  });

  function postReq(body: unknown) {
    return new Request('http://localhost/api/learning-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('happy path: creates item with status=pending, version=0, completed_at=null', async () => {
    const res = await POST(postReq({ title: 'My item', content: 'Some content' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      title: string;
      status: string;
      version: number;
      completed_at: unknown;
    };
    expect(body.id).toMatch(/.+/);
    expect(body.title).toBe('My item');
    expect(body.status).toBe('pending');
    expect(body.version).toBe(0);
    expect(body.completed_at).toBeNull();
  });

  it('creates item with knowledge_ids when they exist', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      ...BASE_KNOWLEDGE,
      created_at: now,
      updated_at: now,
    });

    const res = await POST(postReq({ title: 'T', knowledge_ids: ['k1'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge_ids: string[] };
    expect(body.knowledge_ids).toEqual(['k1']);
  });

  it('400 on missing title', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 on title length > 200', async () => {
    const res = await POST(postReq({ title: 'X'.repeat(201) }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 on unknown knowledge_id; message contains the id', async () => {
    const res = await POST(postReq({ title: 'T', knowledge_ids: ['k_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/k_missing/);
  });

  it('400 on invalid JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/learning-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });
});
