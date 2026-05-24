// Phase 1c.1 Step 9.B — `/api/review/due` rewritten over `material_fsrs_state`.
//
// Pre-Step-9 fixtures seeded `mistake` rows w/ fsrs_state jsonb. Post-Step-9
// fixtures seed `question` + (optionally) `material_fsrs_state` rows. Cards
// with no FSRS state row but at least one failure attempt also surface (never-
// reviewed slice).

import { event, material_fsrs_state, question } from '@/db/schema';
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

async function seedQuestion(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `P ${id}`,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

async function seedFailureAttempt(question_id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(event).values({
    id: `evt_attempt_${question_id}`,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: question_id,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

async function seedJudge(question_id: string, primary_category = 'concept') {
  const db = testDb();
  const now = new Date();
  const attemptId = `evt_attempt_${question_id}`;
  await db.insert(event).values({
    id: `evt_judge_${question_id}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category,
        secondary_categories: [],
        analysis_md: 'agent analysis',
        confidence: 0.8,
      },
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

async function seedUserCause(question_id: string, primary_category = 'memory') {
  const db = testDb();
  const now = new Date();
  const attemptId = `evt_attempt_${question_id}`;
  await db.insert(event).values({
    id: `evt_user_cause_${question_id}`,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: null,
    payload: {
      primary_category,
      user_notes: 'manual correction',
    },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

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

async function seedFsrsState(opts: {
  question_id: string;
  due_at: Date;
  // jsonb column; tests build the FSRS state inline via mkFsrsState. unknown
  // keeps the helper agnostic without dragging the full FsrsStateSchemaT here.
  state: unknown;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `f_${opts.question_id}`,
    subject_kind: 'question',
    subject_id: opts.question_id,
    state: opts.state as never,
    due_at: opts.due_at,
    last_review_event_id: null,
    updated_at: now,
  });
}

async function getReview(params = '') {
  return GET(new Request(`http://localhost/api/review/due${params ? `?${params}` : ''}`));
}

describe('GET /api/review/due', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns never-reviewed questions (no FSRS state row) first, then due cards', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();
    const futureIso = new Date(now.getTime() + 86400 * 1000).toISOString();

    await seedQuestion('q_null');
    await seedQuestion('q_due');
    await seedQuestion('q_future');

    // q_null: failure attempt, no fsrs state
    await seedFailureAttempt('q_null');
    // q_due: already-reviewed but overdue
    await seedFailureAttempt('q_due');
    await seedFsrsState({
      question_id: 'q_due',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
    });
    // q_future: reviewed, not yet due
    await seedFsrsState({
      question_id: 'q_future',
      due_at: new Date(futureIso),
      state: makeFsrsState({ due: futureIso }),
    });

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        question_id: string;
        fsrs_state: unknown;
        activity_ref: unknown;
        last_failure_event: { id: string; correction_state: { state: string } } | null;
      }>;
    };

    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain('q_null');
    expect(ids).toContain('q_due');
    expect(ids).not.toContain('q_future');
    // Null-state comes first
    expect(body.rows[0].id).toBe('q_null');
    expect(body.rows[0].activity_ref).toEqual({
      kind: 'question',
      id: body.rows[0].question_id,
    });
    expect((body.rows[0].activity_ref as { id: string }).id).toBe(body.rows[0].question_id);
    expect(body.rows[0].fsrs_state).toBeNull();
    expect(body.rows.find((row) => row.id === 'q_due')?.last_failure_event).toEqual({
      id: 'evt_attempt_q_due',
      correction_state: expect.objectContaining({ state: 'active' }),
    });
  });

  it('returns empty rows when no cards are due', async () => {
    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });

  it('uses user cause before agent judge cause in due-card projection', async () => {
    await seedQuestion('q_user_cause');
    await seedFailureAttempt('q_user_cause');
    await seedJudge('q_user_cause', 'concept');
    await seedUserCause('q_user_cause', 'memory');

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ cause: string | null }> };

    expect(body.rows[0].cause).toBe('memory');
  });

  it('does NOT include questions that have no attempt events and no FSRS state', async () => {
    // Question alone is not due — only enters via either failure-attempt event
    // (never-reviewed slice) or material_fsrs_state row.
    await seedQuestion('q_alone');
    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).not.toContain('q_alone');
  });

  it('respects limit=2 param across both slices', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 86400 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      await seedQuestion(`q${i}`);
      await seedFsrsState({
        question_id: `q${i}`,
        due_at: new Date(pastIso),
        state: makeFsrsState({ due: pastIso }),
      });
    }
    const res = await getReview('limit=2');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('clamps limit=0 to 1', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 86400 * 1000).toISOString();
    await seedQuestion('q1');
    await seedFsrsState({
      question_id: 'q1',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
    });
    await seedQuestion('q2');
    await seedFsrsState({
      question_id: 'q2',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
    });

    const res = await getReview('limit=0');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('clamps limit=abc to default 20', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 86400 * 1000).toISOString();
    await seedQuestion('q1');
    await seedFsrsState({
      question_id: 'q1',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
    });
    const res = await getReview('limit=abc');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('truncates prompt_md and reference_md to 1000 chars', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 86400 * 1000).toISOString();
    const long = 'X'.repeat(1500);
    await seedQuestion('q_long', { prompt_md: long, reference_md: long });
    await seedFsrsState({
      question_id: 'q_long',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
    });
    const res = await getReview();
    const body = (await res.json()) as {
      rows: Array<{ prompt_md: string; reference_md: string }>;
    };
    expect(body.rows[0].prompt_md).toHaveLength(1000);
    expect(body.rows[0].reference_md).toHaveLength(1000);
  });

  it('ordered by due_at asc within the already-reviewed slice', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 86400 * 1000);
    const later = new Date(now.getTime() - 1 * 86400 * 1000);

    await seedQuestion('q_later');
    await seedFsrsState({
      question_id: 'q_later',
      due_at: later,
      state: makeFsrsState({ due: later.toISOString() }),
    });
    await seedQuestion('q_earlier');
    await seedFsrsState({
      question_id: 'q_earlier',
      due_at: earlier,
      state: makeFsrsState({ due: earlier.toISOString() }),
    });

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids.indexOf('q_earlier')).toBeLessThan(ids.indexOf('q_later'));
  });
});
