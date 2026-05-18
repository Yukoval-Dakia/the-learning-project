import { knowledge, learning_record } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

async function seedKnowledge(id = 'k1') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'math',
    parent_id: null,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function postRecord(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function listRecords(qs = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/records${qs ? `?${qs}` : ''}`));
}

describe('POST /api/records', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates an open question record with a capture event', async () => {
    await seedKnowledge('k1');

    const res = await postRecord({
      kind: 'open_question',
      content_md: '为什么这里要取中点？',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      knowledge_ids: ['k1'],
      payload: { question_md: '为什么这里要取中点？' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      origin_event_id: string;
      knowledge_ids: string[];
    };
    expect(body.kind).toBe('open_question');
    expect(body.origin_event_id).toBeTruthy();
    expect(body.knowledge_ids).toEqual(['k1']);

    const rows = await testDb().select().from(learning_record);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin_event_id).toBe(body.origin_event_id);
  });

  it('returns 400 on unknown knowledge ids', async () => {
    const res = await postRecord({
      kind: 'insight',
      content_md: '截面先找共面点',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: ['missing'],
      payload: {},
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/records', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lists active records with filters', async () => {
    await postRecord({
      kind: 'insight',
      content_md: '截面先找共面点',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });
    await postRecord({
      kind: 'open_question',
      content_md: '为什么这里能作平行线？',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      knowledge_ids: [],
      payload: {},
    });

    const res = await listRecords('kind=insight');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ kind: string; content_md: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].kind).toBe('insight');
    expect(body.rows[0].content_md).toBe('截面先找共面点');
  });

  it('applies knowledge_id before limit', async () => {
    await seedKnowledge('k1');
    await seedKnowledge('k2');
    await postRecord({
      kind: 'insight',
      content_md: 'k2 record',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: ['k2'],
      payload: {},
    });
    await postRecord({
      kind: 'insight',
      content_md: 'newer k1 record',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: ['k1'],
      payload: {},
    });

    const res = await listRecords('knowledge_id=k2&limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ content_md: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].content_md).toBe('k2 record');
  });

  it('returns 400 on invalid limit', async () => {
    const res = await listRecords('limit=abc');
    expect(res.status).toBe(400);
  });
});
