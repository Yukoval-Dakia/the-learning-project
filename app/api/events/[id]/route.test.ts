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

async function seedCorrection(id: string, target_event_id: string): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: target_event_id,
    outcome: 'success',
    payload: {
      correction_kind: 'retract',
      reason_md: 'wrong event',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    },
    caused_by_event_id: target_event_id,
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
      event: {
        action: string;
        subject_id: string;
        correction_status: {
          state: string;
          correction_event_id: string | null;
          replacement_event_id: string | null;
        };
      };
      correction_status: {
        state: string;
        correction_event_id: string | null;
        replacement_event_id: string | null;
      };
      chain: {
        caused_by: unknown;
        caused_events: Array<{ action: string }>;
        corrections: unknown[];
      };
    };
    expect(body.event.action).toBe('attempt');
    expect(body.event.subject_id).toBe('q1');
    expect(body.event.correction_status).toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
    expect(body.correction_status).toEqual(body.event.correction_status);
    expect(body.chain.caused_by).toBeNull();
    expect(body.chain.caused_events).toHaveLength(1);
    expect(body.chain.caused_events[0].action).toBe('judge');
    expect(Array.isArray(body.chain.corrections)).toBe(true);
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

  it('returns correction status and correction events for a corrected focal event', async () => {
    await seedAttempt('a1', 'q1');
    await seedCorrection('c1', 'a1');

    const res = await getOne('a1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      correction_status: { state: string; correction_event_id: string | null };
      chain: {
        caused_events: Array<{ id: string; action: string }>;
        corrections: Array<{ id: string; action: string }>;
      };
    };
    expect(body.correction_status).toEqual({
      state: 'retracted',
      correction_event_id: 'c1',
      replacement_event_id: null,
    });
    expect(body.chain.corrections).toHaveLength(1);
    expect(body.chain.corrections[0].id).toBe('c1');
    expect(body.chain.corrections[0].action).toBe('correct');
    expect(body.chain.caused_events.map((e) => e.id)).not.toContain('c1');
  });

  it('returns 404 when the event id is unknown', async () => {
    const res = await getOne('no_such_id');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
