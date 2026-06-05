// Phase 1c.1 Step 9.A — `/api/review/submit` over event stream.
//
// Pre-Step-9 tests seeded `mistake` + `review_event`. Post-Step-9 the legacy
// tables are gone; seed question rows + (optionally) material_fsrs_state.
//
// YUK-56 (2026-05-24) — auto-rating via JudgeInvoker (CC-3). Tests cover:
//   - exact / keyword / semantic judges → coarse_outcome → suggested_rating
//   - auto_rate=true uses suggestion; manual rating wins when auto_rate=false
//   - unsupported route → 422 in auto_rate mode
//   - no answer (response_md null/empty) → no judge invoked, no payload.judge
//   - CC-1 invariant: rating-only override does NOT write experimental:user_cause

import { event, material_fsrs_state, question } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
// YUK-215 — spy on the judge invoker to assert handwriting-photo refs are
// threaded through (student_image_refs).
import * as invokerModule from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
// YUK-101 (iter2 fix F12) — shared seeders from tests/helpers/event-seed.
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import { POST } from './route';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(),
}));

// D6 (U4 L-stamp): mock the profile resolver so a single test can inject a
// '2.0.0' profile. importOriginal keeps the default behaviour (real registry
// profiles) for every other test in this file; only the D6 e2e test overrides
// the return with mockResolvedValueOnce.
vi.mock('@/server/knowledge/subject-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/knowledge/subject-profile')>();
  return {
    ...actual,
    resolveSubjectProfileForKnowledgeIds: vi.fn(actual.resolveSubjectProfileForKnowledgeIds),
  };
});

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `Prompt for ${id}`,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

async function seedFsrsState(question_id: string, state: unknown, due_at: Date) {
  const db = testDb();
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `f_${question_id}`,
    subject_kind: 'question',
    subject_id: question_id,
    state: state as never,
    due_at,
    last_review_event_id: null,
    updated_at: now,
  });
}

function submitReq(body: unknown) {
  return new Request('http://localhost/api/review/submit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/submit', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(runTask).mockReset();
  });

  it('first review (no prior fsrs_state) → writes review event + upserts material_fsrs_state', async () => {
    await seedQuestion('q1');

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'good', latency_ms: 5000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { reps: number; scheduled_days: number };
      review_event: {
        id: string;
        rating: string;
        latency_ms: number | null;
        correction_state: { state: string; terminal_state: string };
      };
    };

    expect(typeof body.next_due_at).toBe('number');
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(body.new_state.reps).toBeGreaterThanOrEqual(1);
    expect(body.review_event.rating).toBe('good');
    expect(body.review_event.latency_ms).toBe(5000);
    expect(body.review_event.correction_state).toEqual(
      expect.objectContaining({ state: 'active', terminal_state: 'active' }),
    );

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
    expect((events[0].payload as Record<string, unknown>).fsrs_rating).toBe('good');
    // 2026-05-17 wire `latency_ms` lands as `duration_ms` in event.payload
    expect((events[0].payload as Record<string, unknown>).duration_ms).toBe(5000);

    const fsrs = await db
      .select()
      .from(material_fsrs_state)
      // CodeRabbit (PR #295) — pin subject_kind so a future same-id question/
      // legacy row can't falsely satisfy the assertion.
      .where(
        and(
          eq(material_fsrs_state.subject_id, 'k1'),
          eq(material_fsrs_state.subject_kind, 'knowledge'),
        ),
      );
    expect(fsrs).toHaveLength(1);
    expect(fsrs[0].subject_kind).toBe('knowledge');
    expect(fsrs[0].last_review_event_id).toBe(events[0].id);
  });

  it('writes FSRS projection per knowledge id, not per reviewed question', async () => {
    await seedQuestion('q_knowledge_card', { knowledge_ids: ['k_fsrs'] });

    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q_knowledge_card' },
        rating: 'good',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: {
        fsrs_subject_kind?: string;
        fsrs_subject_ids?: string[];
        question_id: string;
      };
    };

    expect(body.review_event.question_id).toBe('q_knowledge_card');
    expect(body.review_event.fsrs_subject_kind).toBe('knowledge');
    expect(body.review_event.fsrs_subject_ids).toEqual(['k_fsrs']);

    const rows = await testDb().select().from(material_fsrs_state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_kind: 'knowledge',
      subject_id: 'k_fsrs',
    });
  });

  // Codex / CodeRabbit (PR #295) — referenced_knowledge_ids that exceed the
  // question's own labels must NOT steer FSRS scheduling onto unrelated
  // knowledge points. The FSRS projection is keyed only by requested ∩
  // q.knowledge_ids; the event payload still records the original requested
  // ids (judge evidence may legitimately cite knowledge beyond the tags).
  it('superset referenced_knowledge_ids only schedules the question tags (intersection)', async () => {
    await seedQuestion('q_superset', { knowledge_ids: ['k_tagged'] });

    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q_superset' },
        rating: 'good',
        // 'k_orphan' is NOT a label of q_superset — must not get a projection.
        referenced_knowledge_ids: ['k_tagged', 'k_orphan'],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: { fsrs_subject_kind?: string; fsrs_subject_ids?: string[] };
    };
    // Scheduling scoped to the intersection only.
    expect(body.review_event.fsrs_subject_kind).toBe('knowledge');
    expect(body.review_event.fsrs_subject_ids).toEqual(['k_tagged']);

    const db = testDb();
    const rows = await db.select().from(material_fsrs_state);
    // Exactly one projection row, for the tagged knowledge — no orphan row.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_kind: 'knowledge', subject_id: 'k_tagged' });

    // Event payload preserves the original requested ids (audit trail).
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_superset')));
    expect((events[0].payload as Record<string, unknown>).referenced_knowledge_ids).toEqual([
      'k_tagged',
      'k_orphan',
    ]);
  });

  it('empty intersection with a labeled question falls back to the question tags', async () => {
    await seedQuestion('q_disjoint', { knowledge_ids: ['k_real'] });

    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q_disjoint' },
        rating: 'good',
        // None of the requested ids tag the question → fall back to q tags.
        referenced_knowledge_ids: ['k_bogus'],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: { fsrs_subject_kind?: string; fsrs_subject_ids?: string[] };
    };
    expect(body.review_event.fsrs_subject_kind).toBe('knowledge');
    expect(body.review_event.fsrs_subject_ids).toEqual(['k_real']);

    const rows = await testDb().select().from(material_fsrs_state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_kind: 'knowledge', subject_id: 'k_real' });
  });

  it('second review (existing fsrs_state with ISO string dates) → Plan F1 coercion works', async () => {
    await seedQuestion('q1');
    const dueIso = '2026-05-09T12:00:00.000Z';
    const dueDate = new Date(dueIso);
    await seedFsrsState(
      'q1',
      {
        due: dueIso,
        stability: 1.5,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: '2026-05-08T12:00:00.000Z',
      },
      dueDate,
    );

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'again' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { scheduled_days: number; stability: number; lapses: number };
    };
    expect(Number.isFinite(body.next_due_at)).toBe(true);
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(Number.isFinite(body.new_state.scheduled_days)).toBe(true);
    expect(Number.isFinite(body.new_state.stability)).toBe(true);
    expect(body.new_state.lapses).toBeGreaterThanOrEqual(1);

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure'); // again → failure invariant
  });

  it('accepts activity_ref as the primary review identity', async () => {
    await seedQuestion('q1');

    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q1' },
        rating: 'good',
        latency_ms: 5000,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: {
        activity_ref: { kind: string; id: string };
        question_id: string;
        rating: string;
      };
    };

    expect(body.review_event.activity_ref).toEqual({ kind: 'question', id: 'q1' });
    expect(body.review_event.question_id).toBe('q1');
    expect(body.review_event.rating).toBe('good');

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
  });

  it('returns 400 when rating is invalid (e.g. "easy")', async () => {
    await seedQuestion('q1');
    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'easy' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when review identity is missing', async () => {
    const res = await POST(submitReq({ rating: 'good' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('activity_ref, question_id, or mistake_id is required');
  });

  it('returns 400 when activity_ref kind is not supported by the question adapter', async () => {
    const res = await POST(
      submitReq({
        activity_ref: { kind: 'record', id: 'r1' },
        rating: 'good',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('unsupported_activity_kind');
    expect(body.message).toContain('question activities only');
  });

  it('returns 400 when activity_ref conflicts with legacy identity fields', async () => {
    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q2',
        rating: 'good',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('must reference the same question');
  });

  it('returns 404 when question not found', async () => {
    const res = await POST(submitReq({ mistake_id: 'q_missing', rating: 'good' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns null for response_md and latency_ms when not provided', async () => {
    await seedQuestion('q1');
    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'good' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: { response_md: string | null; latency_ms: number | null };
    };
    expect(body.review_event.response_md).toBeNull();
    expect(body.review_event.latency_ms).toBeNull();
  });

  it('includes response_md when provided', async () => {
    await seedQuestion('q1');
    const res = await POST(
      submitReq({
        mistake_id: 'q1',
        rating: 'hard',
        response_md: 'my answer',
        referenced_knowledge_ids: ['k1', 'k2'],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review_event: { response_md: string | null } };
    expect(body.review_event.response_md).toBe('my answer');

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect((events[0].payload as Record<string, unknown>).user_response_md).toBe('my answer');
    expect((events[0].payload as Record<string, unknown>).referenced_knowledge_ids).toEqual([
      'k1',
      'k2',
    ]);
  });

  it('rating transitions: again increases lapses, good increases reps', async () => {
    await seedQuestion('q1');
    const dueDate = new Date(Date.now() - 86400 * 1000);
    await seedFsrsState(
      'q1',
      {
        due: dueDate.toISOString(),
        stability: 2,
        difficulty: 5,
        elapsed_days: 1,
        scheduled_days: 2,
        learning_steps: 0,
        reps: 2,
        lapses: 0,
        state: 'review',
        last_review: null,
      },
      dueDate,
    );

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'again' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_state: { lapses: number; reps: number } };
    expect(body.new_state.lapses).toBeGreaterThan(0);
  });

  it('multiple reviews on same question keep one material_fsrs_state row (upsert behaviour)', async () => {
    await seedQuestion('q1');
    await POST(submitReq({ mistake_id: 'q1', rating: 'good' }));
    await POST(submitReq({ mistake_id: 'q1', rating: 'hard' }));

    const db = testDb();
    const rows = await db
      .select()
      .from(material_fsrs_state)
      // CodeRabbit (PR #295) — pin subject_kind on the assertion query.
      .where(
        and(
          eq(material_fsrs_state.subject_id, 'k1'),
          eq(material_fsrs_state.subject_kind, 'knowledge'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_kind).toBe('knowledge');
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // YUK-56 — auto-rating via JudgeInvoker (CC-3)
  // ──────────────────────────────────────────────────────────────────────────

  describe('YUK-56 auto-rating via JudgeInvoker', () => {
    it('exact judge auto-rate correct → final rating="good" + payload.judge embedded', async () => {
      await seedQuestion('q_exact_correct', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_exact_correct' },
          rating: 'again', // ignored — auto_rate overrides
          response_md: '答案',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: {
          route: string;
          coarse_outcome: string;
          suggested_rating: string;
          auto_rated: boolean;
          telemetry: { route: string; question_id: string; subject_id: string };
        };
      };
      expect(body.review_event.rating).toBe('good');
      expect(body.judge.route).toBe('exact');
      expect(body.judge.coarse_outcome).toBe('correct');
      expect(body.judge.suggested_rating).toBe('good');
      expect(body.judge.auto_rated).toBe(true);
      // CC-3 invariant — telemetry comes from the invoker (only path that
      // populates question_id + subject_id on the telemetry block).
      expect(body.judge.telemetry.route).toBe('exact');
      expect(body.judge.telemetry.question_id).toBe('q_exact_correct');
      expect(body.judge.telemetry.subject_id).toBe('wenyan');

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_exact_correct')));
      expect(events).toHaveLength(1);
      expect((events[0].payload as Record<string, unknown>).fsrs_rating).toBe('good');
      const payloadJudge = (events[0].payload as Record<string, unknown>).judge as Record<
        string,
        unknown
      >;
      expect(payloadJudge).toMatchObject({
        route: 'exact',
        coarse_outcome: 'correct',
        suggested_rating: 'good',
        auto_rated: true,
      });
    });

    // D6 (U4 L-stamp, critic-R2 HIGH) — end-to-end proof that the result-side
    // version override reaches the persisted review event. The judge result is
    // embedded at submit/route.ts:306 as `judgeResult.capability_ref`; a
    // telemetry-only override would leave `payload.judge.capability_ref.version`
    // at the runner's '1.0.0'. Inject a '2.0.0' profile and assert the event
    // stream carries it on BOTH the embedded judge block and the telemetry.
    it('D6: review event payload.judge.capability_ref.version == SubjectProfile.version (2.0.0)', async () => {
      vi.mocked(resolveSubjectProfileForKnowledgeIds).mockResolvedValueOnce({
        ...resolveSubjectProfile('wenyan'),
        version: '2.0.0',
      });
      await seedQuestion('q_d6_version', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_d6_version' },
          rating: 'again',
          response_md: '答案',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        judge: { capability_ref: { id: string; version: string } };
      };
      // Response side (mirrors the embedded event payload).
      expect(body.judge.capability_ref.version).toBe('2.0.0');

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_d6_version')));
      expect(events).toHaveLength(1);
      const payloadJudge = (events[0].payload as Record<string, unknown>).judge as {
        capability_ref: { version: string };
        telemetry: { capability_ref: { version: string }; profile_version: string };
      };
      // Event-stream side — the persisted, traceable record.
      expect(payloadJudge.capability_ref.version).toBe('2.0.0');
      expect(payloadJudge.telemetry.capability_ref.version).toBe('2.0.0');
      expect(payloadJudge.telemetry.profile_version).toBe('2.0.0');
    });

    it('exact judge auto-rate wrong → final rating="again" + outcome=failure', async () => {
      await seedQuestion('q_exact_wrong', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_exact_wrong' },
          rating: 'good', // ignored
          response_md: '错',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: { coarse_outcome: string; suggested_rating: string };
      };
      expect(body.review_event.rating).toBe('again');
      expect(body.judge.coarse_outcome).toBe('incorrect');
      expect(body.judge.suggested_rating).toBe('again');

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_exact_wrong')));
      expect(events[0].outcome).toBe('failure');
    });

    it('keyword judge partial → suggested_rating="hard"', async () => {
      await seedQuestion('q_keyword', {
        kind: 'fill_blank',
        reference_md: '虚词；代词；连词',
        judge_kind_override: 'keyword',
        knowledge_ids: [],
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
          keywords: ['虚词', '代词', '连词'],
        },
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_keyword' },
          rating: 'good',
          response_md: '虚词和代词',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: { route: string; coarse_outcome: string; suggested_rating: string };
      };
      expect(body.judge.route).toBe('keyword');
      expect(body.judge.coarse_outcome).toBe('partial');
      expect(body.judge.suggested_rating).toBe('hard');
      expect(body.review_event.rating).toBe('hard');
    });

    it('semantic judge runs SemanticJudgeTask via runTask and respects auto_rate', async () => {
      await seedQuestion('q_semantic', {
        kind: 'short_answer',
        reference_md: '之在这里作代词，指代前文的人或事。',
        judge_kind_override: 'semantic',
        knowledge_ids: [],
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖核心要点' }],
          required_points: ['说明之作代词', '说明指代前文'],
        },
      });
      vi.mocked(runTask).mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0.9,
          coarse_outcome: 'correct',
          confidence: 0.85,
          feedback_md: '要点完整。',
          evidence_json: { matched_points: ['说明之作代词'], missing_points: [] },
        }),
        cost: 0,
        usage: null,
        model: 'mock',
      } as never);

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_semantic' },
          rating: 'again',
          response_md: '之作代词。',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(200);
      expect(vi.mocked(runTask)).toHaveBeenCalledTimes(1);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: { route: string; suggested_rating: string };
      };
      expect(body.judge.route).toBe('semantic');
      expect(body.judge.suggested_rating).toBe('good');
      expect(body.review_event.rating).toBe('good');
    });

    it('semantic judge failure → unsupported in auto_rate mode → 422', async () => {
      await seedQuestion('q_semantic_unsupported', {
        kind: 'short_answer',
        reference_md: '之作代词。',
        judge_kind_override: 'semantic',
        knowledge_ids: [],
      });
      vi.mocked(runTask).mockRejectedValueOnce(new Error('provider down'));

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_semantic_unsupported' },
          rating: 'good',
          response_md: '之作代词。',
          auto_rate: true,
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unsupported_judge_route');
      expect(body.message).toContain("'semantic'");

      // No review event written — txn never opened.
      const events = await testDb()
        .select()
        .from(event)
        .where(eq(event.subject_id, 'q_semantic_unsupported'));
      expect(events).toHaveLength(0);
    });

    it('manual override (auto_rate=false): user rating wins, judge still runs + embedded, no user_cause written', async () => {
      await seedQuestion('q_override', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      // Judge would say 'correct' → suggest 'good', but user picks 'again'.
      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_override' },
          rating: 'again',
          response_md: '答案',
          // auto_rate defaults to false
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: { suggested_rating: string; auto_rated: boolean; coarse_outcome: string };
      };
      // User wins
      expect(body.review_event.rating).toBe('again');
      // Judge still ran + suggested 'good' (auto_rated flag reflects request mode)
      expect(body.judge.coarse_outcome).toBe('correct');
      expect(body.judge.suggested_rating).toBe('good');
      expect(body.judge.auto_rated).toBe(false);

      // CC-1 invariant — rating-only override must NOT write
      // experimental:user_cause; cause overrides happen via a separate channel.
      const userCauseEvents = await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:user_cause'));
      expect(userCauseEvents).toHaveLength(0);
    });

    it('no response_md → no judge invoked, response.judge=null, no payload.judge', async () => {
      await seedQuestion('q_no_answer', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_no_answer' },
          rating: 'good',
          // response_md omitted
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { judge: unknown };
      expect(body.judge).toBeNull();

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_no_answer')));
      expect((events[0].payload as Record<string, unknown>).judge).toBeUndefined();
    });

    it('empty response_md (whitespace) → no judge invoked', async () => {
      await seedQuestion('q_blank_answer', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_blank_answer' },
          rating: 'good',
          response_md: '   ',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { judge: unknown };
      expect(body.judge).toBeNull();
    });

    it('auto_rate=true with no response_md → 422 unsupported_judge_route', async () => {
      await seedQuestion('q_no_answer_auto', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_no_answer_auto' },
          rating: 'good',
          auto_rate: true,
          // response_md omitted
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unsupported_judge_route');
      expect(body.message).toContain('response_md');
    });
  });

  // Codex P1-G — concurrent double-submit must not produce torn FSRS state.
  // Previously the FSRS read (getFsrsState) ran OUTSIDE the write transaction:
  // two concurrent submissions both read the same prior state, both compute
  // their `nextState` from it, and both upsert. The projection then reflects
  // exactly one of the two — but it's not the state that should result from
  // *both* reviews applied serially (lapses get lost, reps misincrement, etc).
  it('concurrent double-submit: material_fsrs_state reflects exactly one review serially', async () => {
    await seedQuestion('q1');
    const db = testDb();

    const [resA, resB] = await Promise.all([
      POST(submitReq({ mistake_id: 'q1', rating: 'again' })),
      POST(submitReq({ mistake_id: 'q1', rating: 'again' })),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Both reviews must have written their event rows (event log is append-only).
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(2);

    // The projection row reflects exactly one review's final state — NOT a
    // torn merge of both. With row-level locking, the second review computes
    // its nextState from the first's (locked) result, so reps=2 (not 1).
    const stateRows = await db
      .select()
      .from(material_fsrs_state)
      // CodeRabbit (PR #295) — pin subject_kind on the assertion query.
      .where(
        and(
          eq(material_fsrs_state.subject_id, 'k1'),
          eq(material_fsrs_state.subject_kind, 'knowledge'),
        ),
      );
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0].subject_kind).toBe('knowledge');
    const finalState = stateRows[0].state as { reps: number };
    // Without locking, both reads see reps=0 and both write reps=1 → finalState.reps=1 (torn).
    // With locking, second sees reps=1 and writes reps=2.
    expect(finalState.reps).toBe(2);
  });

  // YUK-98 (T-RA) — RatingAdvisor wiring on /api/review/submit. Body schema
  // accepts an optional `judge_result_v2` so the UI can ship the prior judge
  // result back for advisory derivation + event-payload trace. Old clients
  // that do not send it stay green (backward-compat); the advisor never
  // overrides body.rating (informational only).
  describe('YUK-98 — judge_result_v2 advisory wiring', () => {
    it('backward-compat: submit without judge_result_v2 still 200 and writes event without judge_advice', async () => {
      await seedQuestion('q_ra_bc');

      const res = await POST(submitReq({ mistake_id: 'q_ra_bc', rating: 'good' }));
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_ra_bc')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as Record<string, unknown>;
      expect(payload.judge_advice).toBeUndefined();
    });

    it('submits judge_result_v2=partial → event payload contains judge_advice with rating + reason + evidence_score', async () => {
      await seedQuestion('q_ra_partial');

      const res = await POST(
        submitReq({
          mistake_id: 'q_ra_partial',
          rating: 'hard',
          response_md: 'partial answer',
          judge_result_v2: {
            coarse_outcome: 'partial',
            score: 0.6,
            score_meaning: 'steps_v1_weighted',
            confidence: 0.85,
            capability_ref: { id: 'steps', version: '1' },
            feedback_md: 'partial credit on step 2',
            evidence_json: {},
          },
        }),
      );
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_ra_partial')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        judge_advice?: {
          rating: string | null;
          reason: string;
          evidence_score: number | null;
        };
        fsrs_rating: string;
      };
      expect(payload.judge_advice).toBeDefined();
      expect(payload.judge_advice?.rating).toBe('hard');
      expect(payload.judge_advice?.evidence_score).toBe(0.6);
      expect(payload.judge_advice?.reason).toMatch(/partial/i);
      // CC-1 / advisor invariant: user's body.rating is the committed rating;
      // advisor does NOT override the user's choice.
      expect(payload.fsrs_rating).toBe('hard');
    });

    it('reuses supplied judge_result_v2 with response_md instead of re-running the deterministic judge', async () => {
      await seedQuestion('q_ra_reuse', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_ra_reuse' },
          rating: 'again',
          response_md: '答案',
          judge_result_v2: {
            coarse_outcome: 'partial',
            score: 0.6,
            score_meaning: 'correctness',
            confidence: 0.85,
            capability_ref: { id: 'advice', version: '1' },
            feedback_md: 'partial result generated by advice endpoint',
            evidence_json: { source: 'advice' },
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_event: { rating: string };
        judge: { coarse_outcome: string; suggested_rating: string; telemetry?: unknown };
      };
      expect(body.review_event.rating).toBe('again');
      expect(body.judge.coarse_outcome).toBe('partial');
      expect(body.judge.suggested_rating).toBe('hard');
      expect(body.judge.telemetry).toBeUndefined();

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_ra_reuse')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        fsrs_rating: string;
        judge?: { coarse_outcome: string; suggested_rating: string; telemetry?: unknown };
        judge_advice?: { rating: string | null };
      };
      // If the route ignored the supplied judge result, the exact judge would
      // mark response_md='答案' as correct. Persisting partial proves reuse.
      expect(payload.fsrs_rating).toBe('again');
      expect(payload.judge?.coarse_outcome).toBe('partial');
      expect(payload.judge?.suggested_rating).toBe('hard');
      expect(payload.judge?.telemetry).toBeUndefined();
      expect(payload.judge_advice?.rating).toBe('hard');
    });

    it('rejects malformed judge_result_v2 with 400 (zod validation)', async () => {
      await seedQuestion('q_ra_bad');

      const res = await POST(
        submitReq({
          mistake_id: 'q_ra_bad',
          rating: 'good',
          // coarse_outcome 'correct' requires score ≥ 0.85; 0.1 is invalid.
          judge_result_v2: {
            coarse_outcome: 'correct',
            score: 0.1,
            score_meaning: 'correctness',
            confidence: 0.9,
            capability_ref: { id: 'exact', version: '1' },
            feedback_md: 'mismatched score',
            evidence_json: {},
          },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // YUK-100 (W-05) — Cause wiring fix. Driver T-RA §1.1 says the partial-
  // credit advisor must apply carelessness/conceptual lean using CC-1's
  // effectiveCauseCategoryForFailureAttempt() helper. Pre-fix the submit
  // route never threaded cause into `judgeResultToRatingAdvice()`, so the
  // event payload's `judge_advice.rating` ignored prior cause and YUK-98's
  // stated goal "cause-aware RatingAdvisor" was dead code in production.
  // These tests pin the wiring at the route layer using prior user_cause
  // events. See `docs/audit/2026-05-27-wave1-postship-drift.md` §W-05.
  describe('YUK-100 — partial-credit cause lean on judge_advice (W-05 wiring)', () => {
    it('applies carelessness lean → judge_advice.rating="good" when prior user_cause=carelessness', async () => {
      await seedQuestion('q_sub_careless');
      await seedAttempt({
        id: 'a_sub_careless',
        question_id: 'q_sub_careless',
      });
      await seedUserCause({
        id: 'uc_sub_careless',
        attempt_event_id: 'a_sub_careless',
        primary_category: 'carelessness',
      });

      // Score 0.6 → default 'hard'; carelessness lean should promote to 'good'.
      const res = await POST(
        submitReq({
          mistake_id: 'q_sub_careless',
          rating: 'hard',
          response_md: 'partial answer',
          judge_result_v2: {
            coarse_outcome: 'partial',
            score: 0.6,
            score_meaning: 'steps_v1_weighted',
            confidence: 0.85,
            capability_ref: { id: 'steps', version: '1' },
            feedback_md: 'partial credit',
            evidence_json: {},
          },
        }),
      );
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_sub_careless')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        judge_advice?: { rating: string | null; reason: string };
        fsrs_rating: string;
      };
      expect(payload.judge_advice?.rating).toBe('good');
      expect(payload.judge_advice?.reason).toMatch(/careless|carelessness/i);
      // CC-1 / advisor invariant: user's body.rating still wins.
      expect(payload.fsrs_rating).toBe('hard');
    });

    it('applies conceptual lean → judge_advice.rating="again" when prior user_cause=conceptual_error', async () => {
      await seedQuestion('q_sub_concept');
      await seedAttempt({
        id: 'a_sub_concept',
        question_id: 'q_sub_concept',
      });
      await seedUserCause({
        id: 'uc_sub_concept',
        attempt_event_id: 'a_sub_concept',
        primary_category: 'conceptual_error',
      });

      // Score 0.6 → default 'hard'; conceptual lean should demote to 'again'.
      const res = await POST(
        submitReq({
          mistake_id: 'q_sub_concept',
          rating: 'hard',
          response_md: 'partial answer',
          judge_result_v2: {
            coarse_outcome: 'partial',
            score: 0.6,
            score_meaning: 'steps_v1_weighted',
            confidence: 0.85,
            capability_ref: { id: 'steps', version: '1' },
            feedback_md: 'partial credit',
            evidence_json: {},
          },
        }),
      );
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_sub_concept')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        judge_advice?: { rating: string | null; reason: string };
        fsrs_rating: string;
      };
      expect(payload.judge_advice?.rating).toBe('again');
      expect(payload.judge_advice?.reason).toMatch(/concept|conceptual/i);
      // CC-1 / advisor invariant: user's body.rating still wins.
      expect(payload.fsrs_rating).toBe('hard');
    });

    it('keeps default bucket when question has no prior failure attempt (causeCategory=null fallback)', async () => {
      await seedQuestion('q_sub_nocause');

      const res = await POST(
        submitReq({
          mistake_id: 'q_sub_nocause',
          rating: 'hard',
          response_md: 'partial answer',
          judge_result_v2: {
            coarse_outcome: 'partial',
            score: 0.6,
            score_meaning: 'steps_v1_weighted',
            confidence: 0.85,
            capability_ref: { id: 'steps', version: '1' },
            feedback_md: 'partial credit',
            evidence_json: {},
          },
        }),
      );
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_sub_nocause')));
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        judge_advice?: { rating: string | null; reason: string };
      };
      // No prior cause → default partial-credit bucket for 0.6 is 'hard'.
      expect(payload.judge_advice?.rating).toBe('hard');
      expect(payload.judge_advice?.reason).not.toMatch(/careless|conceptual/i);
    });

    // YUK-101 (iter2 fix F1) — pre-iter2 the judge_advice payload was gated on
    // `suppliedJudgeResult` (body.judge_result_v2). When the client did not
    // pre-supply a judge result and the server invoked its own judge inside
    // the route, the gate was false → `judgeAdvicePayload = {}` → judge_advice
    // never landed on the event row. The cause-aware advisor was dead code
    // for every server-judge caller. This test exercises the server-judge
    // path: POST without judge_result_v2, server runs keyword judge, prior
    // user_cause=carelessness still threads into the advisor and judge_advice
    // appears on the event payload with the lean applied.
    it('threads cause into judge_advice when SERVER runs the judge (no judge_result_v2 in body)', async () => {
      await seedQuestion('q_sub_server_judge_careless', {
        kind: 'fill_blank',
        reference_md: '虚词；代词；连词',
        judge_kind_override: 'keyword',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
          keywords: ['虚词', '代词', '连词'],
        },
      });
      await seedAttempt({
        id: 'a_sub_server_judge_careless',
        question_id: 'q_sub_server_judge_careless',
      });
      await seedUserCause({
        id: 'uc_sub_server_judge_careless',
        attempt_event_id: 'a_sub_server_judge_careless',
        primary_category: 'carelessness',
      });

      // No judge_result_v2 in body — server runs keyword judge against
      // response '虚词和代词' (2/3 keywords) → partial credit ~0.67.
      // Default partial-credit bucket for score ≥ 0.5 is 'hard'; carelessness
      // lean promotes to 'good'.
      const res = await POST(
        submitReq({
          mistake_id: 'q_sub_server_judge_careless',
          rating: 'hard',
          response_md: '虚词和代词',
        }),
      );
      expect(res.status).toBe(200);

      const events = await testDb()
        .select()
        .from(event)
        .where(
          and(eq(event.action, 'review'), eq(event.subject_id, 'q_sub_server_judge_careless')),
        );
      expect(events).toHaveLength(1);
      const payload = events[0].payload as {
        judge_advice?: { rating: string | null; reason: string };
        judge?: { route: string; coarse_outcome: string };
        fsrs_rating: string;
      };
      // Server ran the judge — judge envelope must be present on the payload.
      expect(payload.judge?.route).toBe('keyword');
      expect(payload.judge?.coarse_outcome).toBe('partial');
      // Pre-iter2: judge_advice was missing entirely. Post-iter2: it lands
      // with the carelessness lean from the prior user_cause attempt.
      expect(payload.judge_advice?.rating).toBe('good');
      expect(payload.judge_advice?.reason).toMatch(/careless|carelessness/i);
      // CC-1 / advisor invariant: user's body.rating still wins.
      expect(payload.fsrs_rating).toBe('hard');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // YUK-215 — handwriting-photo refs reach the judge + are frozen on the event
  // ──────────────────────────────────────────────────────────────────────────
  describe('YUK-215 handwriting-photo pass-through', () => {
    it('passes answer_image_refs to the judge as student_image_refs + freezes them on the review event', async () => {
      await seedQuestion('q_215', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      // Wrap the real invoker so the judge still runs (real exact match) while we
      // capture the input it received.
      const realFactory = invokerModule.createDefaultJudgeInvoker;
      const captured: Array<{ student_image_refs?: string[] }> = [];
      vi.spyOn(invokerModule, 'createDefaultJudgeInvoker').mockImplementation((deps) => {
        const real = realFactory(deps);
        return {
          invoke: (input: Parameters<typeof real.invoke>[0]) => {
            captured.push(input as { student_image_refs?: string[] });
            return real.invoke(input);
          },
        } as never;
      });

      try {
        const res = await POST(
          submitReq({
            activity_ref: { kind: 'question', id: 'q_215' },
            rating: 'good',
            response_md: '答案',
            answer_image_refs: ['asset_hw_1', 'asset_hw_2'],
          }),
        );
        expect(res.status).toBe(200);

        // (1) the judge received the photo refs
        expect(captured).toHaveLength(1);
        expect(captured[0].student_image_refs).toEqual(['asset_hw_1', 'asset_hw_2']);

        // (2) the refs are frozen onto the review event payload (evidence trail)
        const events = await testDb()
          .select()
          .from(event)
          .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_215')));
        expect(events).toHaveLength(1);
        expect((events[0].payload as { answer_image_refs?: string[] }).answer_image_refs).toEqual([
          'asset_hw_1',
          'asset_hw_2',
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('defaults answer_image_refs to [] for old callers (no regression)', async () => {
      await seedQuestion('q_215_default');
      const res = await POST(
        submitReq({ activity_ref: { kind: 'question', id: 'q_215_default' }, rating: 'good' }),
      );
      expect(res.status).toBe(200);
      const events = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_215_default')));
      expect((events[0].payload as { answer_image_refs?: string[] }).answer_image_refs).toEqual([]);
    });

    // F1 (PR #309 round-1) — a photo-only answer (no typed response_md, only
    // answer_image_refs) is a real answer and MUST be judged WHEN it is routed to
    // a judge that actually consumes the image (steps / multimodal_direct).
    //
    // F4 (PR #309 round-2) narrows this: an image-only answer is only judgeable by
    // an image-consuming route. Here we force `multimodal_direct` (an image route)
    // via `judge_kind_override` so the invoker is still called on the photo-only
    // answer. The runner's R2 image fetch fails in-test (no asset) → it returns a
    // graceful `unsupported` result rather than throwing — but the point of THIS
    // test is that F4 did NOT skip the judge: the invoker WAS invoked with the
    // image refs. (The text-only-route skip is covered by the F4 tests below.)
    it('photo-only answer routed to an image-consuming judge (multimodal_direct) still invokes the judge', async () => {
      await seedQuestion('q_215_photo_only', {
        kind: 'short_answer',
        reference_md: '答案',
        judge_kind_override: 'multimodal_direct',
        knowledge_ids: [],
      });

      const realFactory = invokerModule.createDefaultJudgeInvoker;
      const captured: Array<{ answer_md?: string; student_image_refs?: string[] }> = [];
      vi.spyOn(invokerModule, 'createDefaultJudgeInvoker').mockImplementation((deps) => {
        const real = realFactory(deps);
        return {
          invoke: (input: Parameters<typeof real.invoke>[0]) => {
            captured.push(input as { answer_md?: string; student_image_refs?: string[] });
            return real.invoke(input);
          },
        } as never;
      });

      try {
        const res = await POST(
          submitReq({
            activity_ref: { kind: 'question', id: 'q_215_photo_only' },
            rating: 'good',
            // response_md omitted → photo is the only answer.
            answer_image_refs: ['asset_photo_only_1'],
          }),
        );
        expect(res.status).toBe(200);

        // F4: the judge ran on the photo-only answer because the route consumes
        // images (multimodal_direct) — it was NOT skipped.
        expect(captured).toHaveLength(1);
        expect(captured[0].answer_md).toBe('');
        expect(captured[0].student_image_refs).toEqual(['asset_photo_only_1']);

        // The image refs are frozen on the review event as the evidence trail.
        const events = await testDb()
          .select()
          .from(event)
          .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_215_photo_only')));
        expect(events).toHaveLength(1);
        expect((events[0].payload as { answer_image_refs?: string[] }).answer_image_refs).toEqual([
          'asset_photo_only_1',
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // F4 (PR #309 round-2) — a photo-only answer routed to a TEXT-ONLY judge
    // (exact for a fill_blank) must NOT be judged: the judge reads only the
    // (empty) text and would score it wrong, polluting FSRS. In auto_rate mode
    // this is a 422 (the question type can't grade a pure image), and NO review
    // event / FSRS row is written.
    it('photo-only + text-only route (exact) + auto_rate → 422, judge not invoked, no FSRS write', async () => {
      await seedQuestion('q_215_photo_exact_auto', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: ['k_215_photo'],
      });

      const realFactory = invokerModule.createDefaultJudgeInvoker;
      const captured: unknown[] = [];
      vi.spyOn(invokerModule, 'createDefaultJudgeInvoker').mockImplementation((deps) => {
        const real = realFactory(deps);
        return {
          invoke: (input: Parameters<typeof real.invoke>[0]) => {
            captured.push(input);
            return real.invoke(input);
          },
        } as never;
      });

      try {
        const res = await POST(
          submitReq({
            activity_ref: { kind: 'question', id: 'q_215_photo_exact_auto' },
            rating: 'good',
            auto_rate: true,
            // photo is the only answer; exact judge would read empty text.
            answer_image_refs: ['asset_photo_exact_1'],
          }),
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('unsupported_judge_route');
        expect(body.message).toContain('photo-only');

        // F4: the judge was NOT invoked (route is text-only) — so no wrong-text
        // scoring happened.
        expect(captured).toHaveLength(0);

        // No review event written (txn never opened) and no FSRS pollution.
        const events = await testDb()
          .select()
          .from(event)
          .where(eq(event.subject_id, 'q_215_photo_exact_auto'));
        expect(events).toHaveLength(0);
        const fsrs = await testDb()
          .select()
          .from(material_fsrs_state)
          .where(eq(material_fsrs_state.subject_id, 'k_215_photo'));
        expect(fsrs).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // F4 — the same photo-only + text-only route WITHOUT auto_rate records the
    // attempt on the user's manual rating but DOES NOT run the judge (no judge
    // envelope on the payload, no wrong-text scoring).
    it('photo-only + text-only route (exact), non-auto_rate → attempt recorded, judge not invoked', async () => {
      await seedQuestion('q_215_photo_exact_manual', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: ['k_215_manual'],
      });

      const realFactory = invokerModule.createDefaultJudgeInvoker;
      const captured: unknown[] = [];
      vi.spyOn(invokerModule, 'createDefaultJudgeInvoker').mockImplementation((deps) => {
        const real = realFactory(deps);
        return {
          invoke: (input: Parameters<typeof real.invoke>[0]) => {
            captured.push(input);
            return real.invoke(input);
          },
        } as never;
      });

      try {
        const res = await POST(
          submitReq({
            activity_ref: { kind: 'question', id: 'q_215_photo_exact_manual' },
            rating: 'good',
            answer_image_refs: ['asset_photo_manual_1'],
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          review_event: { rating: string };
          judge: unknown;
        };
        // User's manual rating is committed; judge result is null (not run).
        expect(body.review_event.rating).toBe('good');
        expect(body.judge).toBeNull();
        // F4: the judge was NOT invoked.
        expect(captured).toHaveLength(0);

        const events = await testDb()
          .select()
          .from(event)
          .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_215_photo_exact_manual')));
        expect(events).toHaveLength(1);
        // No judge envelope on the payload (judge never ran), but the photo refs
        // are still frozen as the evidence trail.
        expect((events[0].payload as { judge?: unknown }).judge).toBeUndefined();
        expect((events[0].payload as { answer_image_refs?: string[] }).answer_image_refs).toEqual([
          'asset_photo_manual_1',
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // F1 — a truly empty submit (neither text nor image) with auto_rate STILL
    // 422s, now with a message naming both inputs.
    it('auto_rate with no answer at all (no text, no image) → 422 naming both inputs', async () => {
      await seedQuestion('q_215_empty_autorate', {
        kind: 'fill_blank',
        reference_md: '答案',
        knowledge_ids: [],
      });

      const res = await POST(
        submitReq({
          activity_ref: { kind: 'question', id: 'q_215_empty_autorate' },
          rating: 'good',
          auto_rate: true,
          // no response_md, no answer_image_refs
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unsupported_judge_route');
      expect(body.message).toContain('response_md');
      expect(body.message).toContain('answer_image_refs');
    });
  });
});
