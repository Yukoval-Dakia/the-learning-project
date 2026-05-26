import { knowledge, question, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { buildAuthedRequest } from '../../../../../tests/helpers/request';
import { POST } from './route';

async function seed() {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k_xuci',
    name: '虚词',
    domain: 'wenyan',
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: 'q1',
    kind: 'short_answer',
    prompt_md: 'prompt q1',
    reference_md: 'ref',
    source: 'manual',
    knowledge_ids: ['k_xuci'],
    created_at: now,
    updated_at: now,
  });
  await writeEvent(db, {
    id: 'att_1',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: now,
  });
}

describe('POST /api/_/tools/[name]', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.INTERNAL_TOKEN = 'test-token';
  });

  it('runs query_mistakes end-to-end and writes a tool_call_log row', async () => {
    await seed();

    const res = await POST(
      buildAuthedRequest('http://localhost/api/_/tools/query_mistakes', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ name: 'query_mistakes' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tool_name).toBe('query_mistakes');
    expect(body.effect).toBe('read');
    expect(body.task_run_id).toBeTruthy();
    expect(body.summary).toContain('mistakes');
    expect(body.output.total).toBe(1);
    expect(body.output.mistakes[0].question_id).toBe('q1');

    const db = testDb();
    const rows = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, body.task_run_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('query_mistakes');
    expect(rows[0].effect).toBe('read');
    expect(rows[0].error_reason).toBeNull();
  });

  it('returns 404 for unknown tool name', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/_/tools/no_such_tool', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ name: 'no_such_tool' }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tool_not_found');
  });

  it('returns 400 on invalid input shape', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/_/tools/query_mistakes', {
        method: 'POST',
        body: JSON.stringify({ input: { filter: { limit: 9999 } } }),
      }),
      { params: Promise.resolve({ name: 'query_mistakes' }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
