import { completion_evidence, knowledge, learning_item } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { DELETE, PATCH } from './route';

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

function baseItem(id: string, over: Partial<typeof learning_item.$inferInsert> = {}) {
  const now = new Date();
  return {
    id,
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

function patchReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/learning-items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteReq(id: string, version?: number) {
  const url =
    version !== undefined
      ? `http://localhost/api/learning-items/${id}?version=${version}`
      : `http://localhost/api/learning-items/${id}`;
  return new Request(url, { method: 'DELETE' });
}

describe('PATCH /api/learning-items/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('updates content — version increments, no completion_evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, content: 'updated' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; version: number };
    expect(body.content).toBe('updated');
    expect(body.version).toBe(1);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('updates title', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, title: 'New title' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe('New title');
  });

  it('transition pending → in_progress — completed_at remains null, no evidence', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'in_progress' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('in_progress');
    expect(body.completed_at).toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('transition in_progress → pending — no evidence, completed_at null', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'in_progress', version: 1 }));

    const res = await PATCH(patchReq('li1', { version: 1, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('pending');
    expect(body.completed_at).toBeNull();
  });

  it('transition pending → done: sets completed_at, creates completion_evidence with path=self_declare', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'done' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('done');
    expect(body.completed_at).not.toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0].path).toBe('self_declare');
    const evidenceJson = evidenceRows[0].evidence_json as Record<string, unknown>;
    expect(typeof evidenceJson.declared_at).toBe('number');
  });

  it('transition pending → done with user_notes — evidence_json contains user_notes', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'done', user_notes: '学完了' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(1);
    const evidenceJson = evidenceRows[0].evidence_json as Record<string, unknown>;
    expect(evidenceJson.user_notes).toBe('学完了');
  });

  it('transition done → in_progress: clears completed_at, no new evidence', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values(baseItem('li1', { status: 'done', completed_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'in_progress' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('in_progress');
    expect(body.completed_at).toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('400 on invalid_transition done → pending', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'done' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_transition');
  });

  it('200 when status="archived" — sets archived_at and persists the status', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'archived' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
  });

  it('200 when archived → pending — clears archived_at (revive flow)', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'archived', archived_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('pending');
    expect(row.archived_at).toBeNull();
  });

  it('200 when done → resting — schema-supported transition', async () => {
    const db = testDb();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'done', completed_at: new Date() }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'resting' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('resting');
  });

  it('400 on user_notes without transitioning to done', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(
      patchReq('li1', { version: 0, status: 'in_progress', user_notes: 'some note' }),
      { params: Promise.resolve({ id: 'li1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/user_notes/);
  });

  it('400 on unknown knowledge_ids', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, knowledge_ids: ['k_missing'] }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/k_missing/);
  });

  it('400 on missing version field', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
  });

  it('404 when item not found', async () => {
    const res = await PATCH(patchReq('li_missing', { version: 0, content: 'x' }), {
      params: Promise.resolve({ id: 'li_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('archived items are still PATCHable — required for the revive flow', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'archived', archived_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
  });

  it('409 on version mismatch — no completion_evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { version: 5 }));

    const res = await PATCH(patchReq('li1', { version: 2, content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('409 on done transition version mismatch — no evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending', version: 5 }));

    const res = await PATCH(patchReq('li1', { version: 2, status: 'done' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });
});

describe('DELETE /api/learning-items/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('soft-archives item — sets archived_at, returns ok:true', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(deleteReq('li1', 0), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(rows[0].archived_at).not.toBeNull();
    expect(rows[0].archived_reason).toBe('user');
    // status NOT touched
    expect(rows[0].status).toBe('pending');
  });

  it('404 when item not found', async () => {
    const res = await DELETE(deleteReq('li_missing', 0), {
      params: Promise.resolve({ id: 'li_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('404 when item already archived', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values(baseItem('li1', { archived_at: now }));

    const res = await DELETE(deleteReq('li1', 0), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(404);
  });

  it('409 on version mismatch', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { version: 5 }));

    const res = await DELETE(deleteReq('li1', 2), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('400 when ?version is missing', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(deleteReq('li1'), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 when ?version is non-numeric', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(
      new Request('http://localhost/api/learning-items/li1?version=abc', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'li1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
