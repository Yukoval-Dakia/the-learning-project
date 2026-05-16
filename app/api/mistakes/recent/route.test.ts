// Phase 1c.1 Step 6.F — `/api/mistakes/recent` reads from event stream.
// Tests seed `event` rows directly (attempt + chained judge); the route projects
// to legacy mistake-shape JSON for back-compat.

import { event, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const QUESTION_BASE = {
  kind: 'short_answer',
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string, prompt_md: string, created_at = new Date()): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id,
    prompt_md,
    created_at,
    updated_at: created_at,
    ...QUESTION_BASE,
  });
}

async function seedAttempt(opts: {
  id: string;
  question_id: string;
  answer_md?: string;
  knowledge_ids?: string[];
  outcome?: 'success' | 'failure' | 'partial';
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.question_id,
    outcome: opts.outcome ?? 'failure',
    payload: {
      answer_md: opts.answer_md ?? 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: opts.knowledge_ids ?? ['k1'],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

async function seedJudge(opts: {
  id: string;
  attempt_event_id: string;
  primary_category?: string;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.primary_category ?? 'concept',
        secondary_categories: [],
        analysis_md: 'analysis',
        confidence: 0.85,
      },
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

describe('GET /api/mistakes/recent (event-stream projection)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns recent failure attempts with prompt + wrong answer + cause, truncated at 200', async () => {
    await seedQuestion('q1', 'P'.repeat(300));
    await seedAttempt({
      id: 'a1',
      question_id: 'q1',
      answer_md: 'W'.repeat(300),
      knowledge_ids: ['k1', 'k2'],
    });
    await seedJudge({ id: 'j1', attempt_event_id: 'a1', primary_category: 'concept' });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        question_id: string;
        prompt_md: string;
        wrong_answer_md: string;
        knowledge_ids: string[];
        cause: { primary_category: string; user_notes: string | null } | null;
        created_at: number;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    const r = body.rows[0];
    expect(r.id).toBe('a1'); // id is the attempt event id (event-stream-native)
    expect(r.question_id).toBe('q1');
    expect(r.prompt_md).toHaveLength(200);
    expect(r.wrong_answer_md).toHaveLength(200);
    expect(r.knowledge_ids).toEqual(['k1', 'k2']);
    expect(r.cause).toEqual({ primary_category: 'concept', user_notes: null });
    expect(typeof r.created_at).toBe('number');
  });

  it('returns cause = null when attempt has no chained judge', async () => {
    await seedQuestion('q1', 'p');
    await seedAttempt({ id: 'a1', question_id: 'q1' });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    const body = (await res.json()) as { rows: Array<{ cause: unknown }> };
    expect(body.rows[0].cause).toBeNull();
  });

  it('cause.user_notes is null for back-compat (Lane B dropped the field)', async () => {
    await seedQuestion('q1', 'p');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({ id: 'j1', attempt_event_id: 'a1' });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    const body = (await res.json()) as {
      rows: Array<{ cause: { user_notes: string | null } }>;
    };
    expect(body.rows[0].cause.user_notes).toBeNull();
  });

  it('respects limit query param', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    for (let i = 1; i <= 5; i++) {
      await seedQuestion(`q${i}`, `p${i}`, new Date(t0.getTime() + i * 1000));
      await seedAttempt({
        id: `a${i}`,
        question_id: `q${i}`,
        created_at: new Date(t0.getTime() + i * 1000),
      });
    }

    const res = await GET(new Request('http://localhost/api/mistakes/recent?limit=3'));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(3);
  });

  it('clamps limit > 100 to 100 (no error)', async () => {
    await seedQuestion('q1', 'p');
    await seedAttempt({ id: 'a1', question_id: 'q1' });

    const res = await GET(new Request('http://localhost/api/mistakes/recent?limit=999'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('excludes non-failure attempts (success / partial)', async () => {
    await seedQuestion('q1', 'p1');
    await seedQuestion('q2', 'p2');
    await seedQuestion('q3', 'p3');
    await seedAttempt({ id: 'a1', question_id: 'q1', outcome: 'failure' });
    await seedAttempt({ id: 'a2', question_id: 'q2', outcome: 'success' });
    await seedAttempt({ id: 'a3', question_id: 'q3', outcome: 'partial' });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    const body = (await res.json()) as { rows: Array<{ question_id: string }> };
    expect(body.rows.map((r) => r.question_id)).toEqual(['q1']);
  });

  it('returns empty rows when no failure attempts exist', async () => {
    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});
