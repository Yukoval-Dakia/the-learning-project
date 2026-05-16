import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

async function seedAttempt(id: string, question_id: string): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: question_id,
    outcome: 'failure',
    payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function seedJudge(id: string, attempt_event_id: string): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attempt_event_id,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: 'a',
        confidence: 0.9,
      },
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function getOne(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/events/${id}`, { method: 'GET' }), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/events/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the focal attempt event + its judge as caused_events', async () => {
    await seedAttempt('a1', 'q1');
    await seedJudge('j1', 'a1');

    const res = await getOne('a1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event: { action: string; subject_id: string };
      chain: { caused_by: unknown; caused_events: Array<{ action: string }> };
    };
    expect(body.event.action).toBe('attempt');
    expect(body.event.subject_id).toBe('q1');
    expect(body.chain.caused_by).toBeNull();
    expect(body.chain.caused_events).toHaveLength(1);
    expect(body.chain.caused_events[0].action).toBe('judge');
  });

  it('returns focal judge event + caused_by populated with the attempt', async () => {
    await seedAttempt('a1', 'q1');
    await seedJudge('j1', 'a1');

    const res = await getOne('j1');
    const body = (await res.json()) as {
      event: { action: string };
      chain: { caused_by: { action: string } | null; caused_events: unknown[] };
    };
    expect(body.event.action).toBe('judge');
    expect(body.chain.caused_by).not.toBeNull();
    expect(body.chain.caused_by?.action).toBe('attempt');
    expect(body.chain.caused_events).toEqual([]);
  });

  it('returns 404 when the event id is unknown', async () => {
    const res = await getOne('no_such_id');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
