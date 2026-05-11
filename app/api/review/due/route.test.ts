import { mistake, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null as string | null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

const MISTAKE_BASE = {
  source: 'manual' as const,
  knowledge_ids: ['k1'],
  wrong_answer_image_refs: [] as string[],
  variants: [] as [],
  variants_generated_count: 0,
  variants_max: 3,
  status: 'active' as const,
  version: 0,
};

// Serialize FsrsState for JSONB — dates must be ISO strings.
function makeFsrsState(overrides: {
  due: string;
  stability?: number;
  difficulty?: number;
  reps?: number;
  lapses?: number;
  scheduled_days?: number;
  state?: string;
}) {
  return {
    due: overrides.due,
    stability: overrides.stability ?? 1.5,
    difficulty: overrides.difficulty ?? 5,
    elapsed_days: 0,
    scheduled_days: overrides.scheduled_days ?? 1,
    learning_steps: 0,
    reps: overrides.reps ?? 1,
    lapses: overrides.lapses ?? 0,
    state: overrides.state ?? 'review',
    last_review: null,
  };
}

async function getReview(params = '') {
  return GET(new Request(`http://localhost/api/review/due${params ? `?${params}` : ''}`));
}

describe('GET /api/review/due', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns never-reviewed mistakes first (null fsrs_state)', async () => {
    const db = testDb();
    const now = new Date();
    const past = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();
    const future = new Date(now.getTime() + 86400 * 1000).toISOString();

    await db.insert(question).values([
      { id: 'q1', prompt_md: 'P null', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q2', prompt_md: 'P due', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q3', prompt_md: 'P future', created_at: now, updated_at: now, ...QUESTION_BASE },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(mistake).values([
      {
        id: 'm_null',
        question_id: 'q1',
        fsrs_state: null,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
      {
        id: 'm_due',
        question_id: 'q2',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fsrs_state: makeFsrsState({ due: past }) as any,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
      {
        id: 'm_future',
        question_id: 'q3',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fsrs_state: makeFsrsState({ due: future }) as any,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; fsrs_state: unknown }> };

    // Only null + past-due should be returned (not future)
    expect(body.rows.map((r) => r.id)).toContain('m_null');
    expect(body.rows.map((r) => r.id)).toContain('m_due');
    expect(body.rows.map((r) => r.id)).not.toContain('m_future');

    // Null fsrs_state comes first
    expect(body.rows[0].id).toBe('m_null');
    expect(body.rows[0].fsrs_state).toBeNull();
  });

  it('excludes archived mistakes', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values([
      { id: 'q1', prompt_md: 'P1', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q2', prompt_md: 'P2', created_at: now, updated_at: now, ...QUESTION_BASE },
    ]);
    await db.insert(mistake).values([
      {
        id: 'm_archived',
        question_id: 'q1',
        fsrs_state: null,
        archived_at: now,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
      {
        id: 'm_active',
        question_id: 'q2',
        fsrs_state: null,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).not.toContain('m_archived');
    expect(body.rows.map((r) => r.id)).toContain('m_active');
  });

  it('excludes non-active status mistakes', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values([
      { id: 'q1', prompt_md: 'P1', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q2', prompt_md: 'P2', created_at: now, updated_at: now, ...QUESTION_BASE },
    ]);
    await db.insert(mistake).values([
      {
        ...MISTAKE_BASE,
        id: 'm_inactive',
        question_id: 'q1',
        fsrs_state: null,
        status: 'suspended',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'm_active',
        question_id: 'q2',
        fsrs_state: null,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).not.toContain('m_inactive');
    expect(body.rows.map((r) => r.id)).toContain('m_active');
  });

  it('respects limit=2 param', async () => {
    const db = testDb();
    const now = new Date();
    const qs = Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      prompt_md: `P${i}`,
      created_at: now,
      updated_at: now,
      ...QUESTION_BASE,
    }));
    const ms = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      question_id: `q${i}`,
      fsrs_state: null,
      created_at: new Date(now.getTime() + i),
      updated_at: now,
      ...MISTAKE_BASE,
    }));
    await db.insert(question).values(qs);
    await db.insert(mistake).values(ms);

    const res = await getReview('limit=2');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('clamps limit=0 to 1', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values([
      { id: 'q1', prompt_md: 'P1', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q2', prompt_md: 'P2', created_at: now, updated_at: now, ...QUESTION_BASE },
    ]);
    await db.insert(mistake).values([
      {
        id: 'm1',
        question_id: 'q1',
        fsrs_state: null,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
      {
        id: 'm2',
        question_id: 'q2',
        fsrs_state: null,
        created_at: new Date(now.getTime() + 1),
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    const res = await getReview('limit=0');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('clamps limit=abc to default 20', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(question)
      .values([{ id: 'q1', prompt_md: 'P1', created_at: now, updated_at: now, ...QUESTION_BASE }]);
    await db.insert(mistake).values([
      {
        id: 'm1',
        question_id: 'q1',
        fsrs_state: null,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    // With 1 item in DB, limit=abc (→20) still returns 1
    const res = await getReview('limit=abc');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('truncates prompt_md and reference_md to 1000 chars', async () => {
    const db = testDb();
    const now = new Date();
    const long = 'X'.repeat(1500);
    await db.insert(question).values({
      ...QUESTION_BASE,
      id: 'q1',
      prompt_md: long,
      reference_md: long,
      created_at: now,
      updated_at: now,
    });
    await db.insert(mistake).values({
      id: 'm1',
      question_id: 'q1',
      fsrs_state: null,
      created_at: now,
      updated_at: now,
      ...MISTAKE_BASE,
    });

    const res = await getReview();
    const body = (await res.json()) as {
      rows: Array<{ prompt_md: string; reference_md: string }>;
    };
    expect(body.rows[0].prompt_md).toHaveLength(1000);
    expect(body.rows[0].reference_md).toHaveLength(1000);
  });

  it('returns empty rows when no mistakes are due', async () => {
    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });

  it('ordered by due asc after null-first group', async () => {
    const db = testDb();
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 86400 * 1000).toISOString(); // 3 days ago
    const later = new Date(now.getTime() - 1 * 86400 * 1000).toISOString(); // 1 day ago

    await db.insert(question).values([
      { id: 'q1', prompt_md: 'P1', created_at: now, updated_at: now, ...QUESTION_BASE },
      { id: 'q2', prompt_md: 'P2', created_at: now, updated_at: now, ...QUESTION_BASE },
    ]);
    await db.insert(mistake).values([
      {
        id: 'm_later',
        question_id: 'q1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fsrs_state: makeFsrsState({ due: later }) as any,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
      {
        id: 'm_earlier',
        question_id: 'q2',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fsrs_state: makeFsrsState({ due: earlier }) as any,
        created_at: now,
        updated_at: now,
        ...MISTAKE_BASE,
      },
    ]);

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    // earlier due_at should come before later
    const ids = body.rows.map((r) => r.id);
    expect(ids.indexOf('m_earlier')).toBeLessThan(ids.indexOf('m_later'));
  });
});
