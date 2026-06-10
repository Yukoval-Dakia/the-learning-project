// Phase 1c.1 Step 9.B — `/api/review/due` rewritten over `material_fsrs_state`.
//
// Pre-Step-9 fixtures seeded `mistake` rows w/ fsrs_state jsonb. Post-Step-9
// fixtures seed `question` + (optionally) `material_fsrs_state` rows. Cards
// with no FSRS state row but at least one failure attempt also surface (never-
// reviewed slice).

import { event, material_fsrs_state, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './due';

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

async function seedFailureAttempt(
  question_id: string,
  opts: { id?: string; created_at?: Date } = {},
) {
  const db = testDb();
  const now = opts.created_at ?? new Date();
  await db.insert(event).values({
    id: opts.id ?? `evt_attempt_${question_id}`,
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

async function seedJudge(
  question_id: string,
  primary_category = 'concept',
  opts: { attemptId?: string } = {},
) {
  const db = testDb();
  const now = new Date();
  const attemptId = opts.attemptId ?? `evt_attempt_${question_id}`;
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

async function retractAttempt(attemptId: string, createdAt: Date) {
  await testDb()
    .insert(event)
    .values({
      id: `correct_${attemptId}`,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'covered by correction',
        affected_refs: [{ kind: 'question', id: attemptId }],
      },
      caused_by_event_id: attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: createdAt,
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
  subject_kind?: string;
  last_review_event_id?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `f_${opts.question_id}`,
    subject_kind: opts.subject_kind ?? 'question',
    subject_id: opts.question_id,
    state: opts.state as never,
    due_at: opts.due_at,
    last_review_event_id: opts.last_review_event_id ?? null,
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

  it('surfaces a due knowledge FSRS state by choosing a linked question', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();

    await seedQuestion('q_for_k_due', { knowledge_ids: ['k_due'] });
    await seedFsrsState({
      question_id: 'k_due',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
      subject_kind: 'knowledge',
    });

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        question_id: string;
        fsrs_subject_kind?: string;
        fsrs_subject_id?: string;
        fsrs_state: unknown;
      }>;
    };

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: 'q_for_k_due',
      question_id: 'q_for_k_due',
      fsrs_subject_kind: 'knowledge',
      fsrs_subject_id: 'k_due',
    });
    expect(body.rows[0].fsrs_state).not.toBeNull();
  });

  // YUK-282 / ADR-0030 — by-kind variant-rotation probe (end-to-end through the
  // route). An application-kind (short_answer) knowledge point whose last review
  // was the family ROOT rotates to the next member of the root_question_id family
  // (the variant), not an unrelated question. The fine-grained selection paths are
  // covered in src/server/review/variant-rotation.test.ts; this guards the wire.
  it('rotates within the variant family for an application-kind due knowledge state', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();

    // Real variant family: root (depth 0) + variant (depth 1, root_question_id=root).
    await seedQuestion('q_root', { knowledge_ids: ['k_rotate'] });
    await seedQuestion('q_variant', {
      knowledge_ids: ['k_rotate'],
      variant_depth: 1,
      root_question_id: 'q_root',
    });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_review_k_rotate',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q_root',
        outcome: 'success',
        payload: {
          fsrs_rating: 'good',
          fsrs_state_after: makeFsrsState({ due: pastIso }),
          referenced_knowledge_ids: ['k_rotate'],
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(now.getTime() - 86400 * 1000),
      });
    await seedFsrsState({
      question_id: 'k_rotate',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
      subject_kind: 'knowledge',
      last_review_event_id: 'evt_review_k_rotate',
    });

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ question_id: string }> };

    expect(body.rows.map((row) => row.question_id)).toEqual(['q_variant']);
  });

  // ADR-0030 §2 — a recall-kind (fill_blank) knowledge point repeats the SAME
  // question (no rotation), even when another fill_blank for the same knowledge
  // exists. This is the recall/application divergence at the wire level.
  it('repeats the same question for a recall-kind due knowledge state', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();

    await seedQuestion('q_recall_last', { kind: 'fill_blank', knowledge_ids: ['k_recall'] });
    await seedQuestion('q_recall_other', { kind: 'fill_blank', knowledge_ids: ['k_recall'] });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_review_k_recall',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q_recall_last',
        outcome: 'success',
        payload: {
          fsrs_rating: 'good',
          fsrs_state_after: makeFsrsState({ due: pastIso }),
          referenced_knowledge_ids: ['k_recall'],
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(now.getTime() - 86400 * 1000),
      });
    await seedFsrsState({
      question_id: 'k_recall',
      due_at: new Date(pastIso),
      state: makeFsrsState({ due: pastIso }),
      subject_kind: 'knowledge',
      last_review_event_id: 'evt_review_k_recall',
    });

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ question_id: string }> };

    expect(body.rows.map((row) => row.question_id)).toEqual(['q_recall_last']);
  });

  // Codex (PR #295) — never-reviewed slice must honor knowledge-level
  // projections. Under ADR-0028 a labeled question's FSRS lives on its
  // knowledge node and the question-level row is deleted. A just-reviewed
  // knowledge point (future due) whose source question still has a failure
  // attempt must NOT reappear as a fresh `fsrs_state: null` never-reviewed card.
  it('excludes a never-reviewed candidate whose knowledge point already has a (future) projection', async () => {
    const now = new Date();
    const futureIso = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();

    // q_reviewed_k is labeled with k_reviewed; it has a failure attempt but the
    // knowledge node was already reviewed and is due in the future.
    await seedQuestion('q_reviewed_k', { knowledge_ids: ['k_reviewed'] });
    await seedFailureAttempt('q_reviewed_k', { id: 'evt_attempt_q_reviewed_k' });
    await seedFsrsState({
      question_id: 'k_reviewed',
      due_at: new Date(futureIso),
      state: makeFsrsState({ due: futureIso }),
      subject_kind: 'knowledge',
    });

    const res = await getReview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; fsrs_state: unknown }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).not.toContain('q_reviewed_k');
  });

  // Positive control: a labeled never-reviewed question whose knowledge point
  // has NO projection still surfaces in the never-reviewed slice.
  it('still surfaces a labeled never-reviewed question when its knowledge point has no projection', async () => {
    await seedQuestion('q_fresh_k', { knowledge_ids: ['k_fresh'] });
    await seedFailureAttempt('q_fresh_k', { id: 'evt_attempt_q_fresh_k' });

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string; fsrs_state: unknown }> };
    const fresh = body.rows.find((r) => r.id === 'q_fresh_k');
    expect(fresh).toBeDefined();
    expect(fresh?.fsrs_state).toBeNull();
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

  it('excludes an unverified quiz draft (draft_status=draft) even when it has a failure attempt', async () => {
    // Gate-B invariant (QuizGen Option B): an unverified draft must never enter
    // the review pool. Seed a draft WITH a failure attempt — the implicit
    // "drafts have no attempt" assumption is bypassed, so only the explicit
    // draft_status filter keeps it out. An active sibling with an attempt is the
    // positive control: 'active' must still surface.
    await seedQuestion('q_draft', { draft_status: 'draft' });
    await seedFailureAttempt('q_draft');
    await seedQuestion('q_active', { draft_status: 'active' });
    await seedFailureAttempt('q_active');

    const res = await getReview();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).not.toContain('q_draft');
    expect(ids).toContain('q_active');
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

  it('does not let one question consume the failure-attempt limit before another subject appears', async () => {
    const base = Date.now();
    await seedQuestion('q_hot');
    await seedQuestion('q_cold');
    for (let index = 0; index < 6; index += 1) {
      await seedFailureAttempt('q_hot', {
        id: `evt_attempt_q_hot_${index}`,
        created_at: new Date(base + index * 1_000),
      });
    }
    await seedFailureAttempt('q_cold', {
      id: 'evt_attempt_q_cold',
      created_at: new Date(base - 1_000),
    });

    const res = await getReview('limit=2');
    const body = (await res.json()) as { rows: Array<{ id: string }> };

    expect(body.rows.map((row) => row.id)).toEqual(['q_hot', 'q_cold']);
  });

  // YUK-76 codex round-3 P1 — failure-lookup global limit misalignment.
  //
  // Before round-3 the route called `getFailureAttempts({ limit: qids*cap*3 })`,
  // treating `limit` as if it were a per-question cap. But `limit` is the
  // global active-rows cap. Seed a hot question dense enough that the first
  // SQL window is filled entirely by its events, and a quiet question whose
  // only failure is older. The quiet question should still surface in the
  // never-reviewed slice.
  it('does not drop quiet question when hot question saturates the failure window', async () => {
    const base = Date.now();
    await seedQuestion('q_hot');
    await seedQuestion('q_quiet');
    // q_hot has 50 failures (>> cap=4, >> SQL ×3 buffer for limit=2 → 24).
    for (let index = 0; index < 50; index += 1) {
      await seedFailureAttempt('q_hot', {
        id: `evt_attempt_q_hot_dense_${index}`,
        created_at: new Date(base + (100 + index) * 1_000),
      });
    }
    // q_quiet has 1 older failure. Under the old global-limit semantics this
    // would be lost behind q_hot's window saturation.
    await seedFailureAttempt('q_quiet', {
      id: 'evt_attempt_q_quiet',
      created_at: new Date(base),
    });

    const res = await getReview('limit=2');
    const body = (await res.json()) as { rows: Array<{ id: string }> };

    const ids = body.rows.map((row) => row.id);
    expect(ids).toContain('q_hot');
    expect(ids).toContain('q_quiet');
  });

  it('filters corrected attempts before applying the per-question failure cap', async () => {
    const base = Date.now();
    await seedQuestion('q_corrected_cap');
    await seedFailureAttempt('q_corrected_cap', {
      id: 'evt_attempt_q_corrected_cap_active',
      created_at: new Date(base),
    });
    await seedJudge('q_corrected_cap', 'memory', {
      attemptId: 'evt_attempt_q_corrected_cap_active',
    });
    for (let index = 0; index < 4; index += 1) {
      const attemptId = `evt_attempt_q_corrected_cap_retracted_${index}`;
      const createdAt = new Date(base + (index + 1) * 1_000);
      await seedFailureAttempt('q_corrected_cap', {
        id: attemptId,
        created_at: createdAt,
      });
      await retractAttempt(attemptId, new Date(createdAt.getTime() + 1));
    }

    const res = await getReview('limit=1');
    const body = (await res.json()) as {
      rows: Array<{ id: string; cause: string | null; last_failure_event: { id: string } | null }>;
    };

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: 'q_corrected_cap',
      cause: 'memory',
      last_failure_event: { id: 'evt_attempt_q_corrected_cap_active' },
    });
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
