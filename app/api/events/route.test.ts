import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET } from './route';

const ATTEMPT_BASE = {
  session_id: null,
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'attempt',
  subject_kind: 'question',
  outcome: 'failure',
  caused_by_event_id: null,
  task_run_id: null,
  cost_micro_usd: null,
} as const;

const JUDGE_BASE = {
  session_id: null,
  actor_kind: 'agent',
  actor_ref: 'attribution',
  action: 'judge',
  subject_kind: 'event',
  outcome: 'success',
  task_run_id: null,
  cost_micro_usd: null,
} as const;

async function seedAttempt(id: string, question_id: string, created_at: Date): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    ...ATTEMPT_BASE,
    id,
    subject_id: question_id,
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    created_at,
  });
}

async function seedJudge(id: string, attempt_event_id: string, created_at: Date): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    ...JUDGE_BASE,
    id,
    subject_id: attempt_event_id,
    caused_by_event_id: attempt_event_id,
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: 'a',
        confidence: 0.9,
      },
      referenced_knowledge_ids: [],
    },
    created_at,
  });
}

async function getEvents(qs = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/events${qs ? `?${qs}` : ''}`, { method: 'GET' }));
}

describe('GET /api/events', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns all events ordered desc by created_at', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    await seedAttempt('e1', 'q1', t0);
    await seedAttempt('e2', 'q2', new Date(t0.getTime() + 60_000));
    await seedAttempt('e3', 'q3', new Date(t0.getTime() + 120_000));

    const res = await getEvents();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ subject_id: string }> };
    expect(body.rows.map((r) => r.subject_id)).toEqual(['q3', 'q2', 'q1']);
  });

  it('filters by action', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    await seedAttempt('e1', 'q1', t0);
    await seedJudge('j1', 'e1', new Date(t0.getTime() + 60_000));

    const res = await getEvents('action=judge');
    const body = (await res.json()) as { rows: Array<{ action: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].action).toBe('judge');
  });

  it('filters by subject_kind', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    await seedAttempt('e1', 'q1', t0);
    await seedJudge('j1', 'e1', new Date(t0.getTime() + 60_000));

    const res = await getEvents('subject_kind=question');
    const body = (await res.json()) as { rows: Array<{ subject_kind: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].subject_kind).toBe('question');
  });

  it('filters by actor_kind + actor_ref combined', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    await seedAttempt('e1', 'q1', t0);
    await seedJudge('j1', 'e1', new Date(t0.getTime() + 60_000));

    const res = await getEvents('actor_kind=agent&actor_ref=attribution');
    const body = (await res.json()) as { rows: Array<{ actor_kind: string; actor_ref: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].actor_kind).toBe('agent');
    expect(body.rows[0].actor_ref).toBe('attribution');
  });

  it('filters by since', async () => {
    await seedAttempt('e_old', 'q_old', new Date('2026-05-09T00:00:00Z'));
    await seedAttempt('e_new', 'q_new', new Date('2026-05-11T00:00:00Z'));

    const res = await getEvents('since=2026-05-10T00:00:00Z');
    const body = (await res.json()) as { rows: Array<{ subject_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].subject_id).toBe('q_new');
  });

  it('honours limit', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await seedAttempt(`e${i}`, `q${i}`, new Date(t0.getTime() + i * 1000));
    }
    const res = await getEvents('limit=2');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('returns empty rows on no matches', async () => {
    const res = await getEvents('action=judge');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('400s on invalid since', async () => {
    const res = await getEvents('since=not-a-date');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400s on non-numeric limit', async () => {
    const res = await getEvents('limit=banana');
    expect(res.status).toBe(400);
  });
});
