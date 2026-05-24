// YUK-58 — GET /api/questions/[id]/timeline DB integration test.

import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { GET } from './route';

async function seedAttempt(opts: {
  question_id: string;
  outcome?: 'failure' | 'success' | 'partial';
  duration_ms?: number;
  created_at?: Date;
}): Promise<string> {
  const id = newId();
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: opts.question_id,
      outcome: opts.outcome ?? 'failure',
      payload: {
        answer_md: 'answer',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
        ...(opts.duration_ms !== undefined ? { duration_ms: opts.duration_ms } : {}),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: opts.created_at ?? new Date(),
    });
  return id;
}

async function seedJudge(opts: {
  attempt_event_id: string;
  primary_category: string;
  confidence?: number;
}): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: newId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: opts.attempt_event_id,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: opts.primary_category,
          secondary_categories: [],
          analysis_md: 'analysis',
          confidence: opts.confidence ?? 0.8,
        },
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: opts.attempt_event_id,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
}

function mkReq(qid: string, query = ''): Request {
  return new Request(`http://localhost/api/questions/${qid}/timeline${query}`);
}

describe('GET /api/questions/[id]/timeline', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty events for unknown question id', async () => {
    const res = await GET(mkReq('q_unknown'), { params: Promise.resolve({ id: 'q_unknown' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      question_id: string;
      events: unknown[];
      computed_at_sec: number;
    };
    expect(body.question_id).toBe('q_unknown');
    expect(body.events).toEqual([]);
    expect(typeof body.computed_at_sec).toBe('number');
  });

  it('returns attempt + judge cause as numeric seconds', async () => {
    const qid = 'q_t1';
    const attemptId = await seedAttempt({ question_id: qid, duration_ms: 4_200 });
    await seedJudge({ attempt_event_id: attemptId, primary_category: 'careless_mistake' });

    const res = await GET(mkReq(qid), { params: Promise.resolve({ id: qid }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        kind: string;
        event_id: string;
        created_at_sec: number;
        duration_ms: number | null;
        cause?: { primary: string; confidence: number | null } | null;
      }>;
    };

    expect(body.events).toHaveLength(1);
    const entry = body.events[0];
    expect(entry.kind).toBe('attempt');
    expect(entry.event_id).toBe(attemptId);
    expect(typeof entry.created_at_sec).toBe('number');
    expect(entry.created_at_sec).toBeGreaterThan(0);
    expect(entry.duration_ms).toBe(4_200);
    expect(entry.cause?.primary).toBe('careless_mistake');
  });

  it('respects limit query param and clamps to MAX_LIMIT', async () => {
    const qid = 'q_lim';
    const base = new Date('2026-05-01T00:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await seedAttempt({ question_id: qid, created_at: new Date(base + i * 60_000) });
    }

    const res = await GET(mkReq(qid, '?limit=2'), { params: Promise.resolve({ id: qid }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(2);
  });

  it('rejects invalid limit', async () => {
    const res = await GET(mkReq('q1', '?limit=abc'), { params: Promise.resolve({ id: 'q1' }) });
    expect(res.status).toBe(400);
  });
});
