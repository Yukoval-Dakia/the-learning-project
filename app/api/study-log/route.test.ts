// Phase 1c.2 — /api/study-log GET + POST.

import { knowledge, study_log } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

async function seedKnowledge(ids: string[]) {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

async function postLog(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/study-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function listLogs(qs = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/study-log${qs ? `?${qs}` : ''}`));
}

describe('POST /api/study-log', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a highlight entry', async () => {
    const res = await postLog({ kind: 'highlight', content_md: 'A nice line.' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; kind: string };
    expect(body.kind).toBe('highlight');

    const db = testDb();
    const rows = await db.select().from(study_log);
    expect(rows).toHaveLength(1);
  });

  it('accepts knowledge_ids when nodes exist', async () => {
    await seedKnowledge(['k1', 'k2']);
    const res = await postLog({
      kind: 'insight',
      content_md: 'Got it.',
      knowledge_ids: ['k1', 'k2'],
    });
    expect(res.status).toBe(200);
  });

  it('400 on unknown knowledge_id', async () => {
    const res = await postLog({
      kind: 'question',
      content_md: 'Wait what?',
      knowledge_ids: ['k_missing'],
    });
    expect(res.status).toBe(400);
  });

  it('400 on invalid kind', async () => {
    const res = await postLog({ kind: 'random', content_md: 'x' });
    expect(res.status).toBe(400);
  });

  it('400 on empty content_md', async () => {
    const res = await postLog({ kind: 'reflection', content_md: '' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/study-log', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when none exist', async () => {
    const res = await listLogs();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('orders by created_at desc', async () => {
    const db = testDb();
    const t0 = new Date('2026-05-17T00:00:00Z');
    for (let i = 0; i < 3; i++) {
      await db.insert(study_log).values({
        id: `sl${i}`,
        kind: 'observation',
        content_md: `entry ${i}`,
        knowledge_ids: [],
        question_id: null,
        mistake_id: null,
        artifact_id: null,
        learning_item_id: null,
        created_at: new Date(t0.getTime() + i * 60_000),
        updated_at: new Date(t0.getTime() + i * 60_000),
        version: 0,
      });
    }
    const res = await listLogs();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['sl2', 'sl1', 'sl0']);
  });

  it('filters by kind', async () => {
    const db = testDb();
    const now = new Date();
    for (const k of ['highlight', 'insight', 'question']) {
      await db.insert(study_log).values({
        id: `sl_${k}`,
        kind: k,
        content_md: k,
        knowledge_ids: [],
        question_id: null,
        mistake_id: null,
        artifact_id: null,
        learning_item_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
    const res = await listLogs('kind=insight');
    const body = (await res.json()) as { rows: Array<{ kind: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].kind).toBe('insight');
  });

  it('filters by knowledge_id (post-fetch through jsonb array)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(study_log).values({
      id: 'sl1',
      kind: 'highlight',
      content_md: 'with k1',
      knowledge_ids: ['k1', 'k2'],
      question_id: null,
      mistake_id: null,
      artifact_id: null,
      learning_item_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(study_log).values({
      id: 'sl2',
      kind: 'highlight',
      content_md: 'no k1',
      knowledge_ids: ['k3'],
      question_id: null,
      mistake_id: null,
      artifact_id: null,
      learning_item_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const res = await listLogs('knowledge_id=k1');
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['sl1']);
  });
});
