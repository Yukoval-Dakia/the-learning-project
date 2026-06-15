// POST /api/embedded-check/attempt
// Tests for the embedded check attempt endpoint.

import { event, learning_record, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './embedded-check-attempt';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const QUESTION_BASE = {
  kind: 'fill_blank' as const,
  // short_answer with reference_md allows the exact judge to run deterministically
  reference_md: '答案',
  knowledge_ids: [] as string[],
  difficulty: 3,
  variant_depth: 0,
  version: 0,
};

async function seedEmbeddedQuestion(
  id = 'q1',
  overrides: Partial<typeof question.$inferInsert> = {},
) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: '填空题',
    source: 'embedded',
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

async function postAttempt(body: unknown) {
  return POST(
    new Request('http://localhost/api/embedded-check/attempt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('POST /api/embedded-check/attempt', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(runTask).mockReset();
  });

  // Test 1: Happy path correct
  it('correct answer → outcome=success, attempt event written, no learning_record', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '答案' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      outcome: string;
      judge: { route: string; score: number };
      mistake_id?: string;
    };
    expect(body.outcome).toBe('success');
    expect(body.judge).toBeDefined();
    expect(body.mistake_id).toBeUndefined();

    const db = testDb();
    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('attempt');
    expect(events[0].outcome).toBe('success');
    const payload = events[0].payload as Record<string, unknown>;
    expect(typeof payload.judge_elapsed_ms).toBe('number');
    expect(payload.judge).toMatchObject({
      route: 'exact',
      telemetry: {
        route: 'exact',
        coarse_outcome: 'correct',
        question_id: 'q1',
        // knowledge_ids:[] → no domain → neutral default subject (general,
        // post wenyan-deprotagonist — was wenyan).
        subject_id: 'general',
      },
    });

    const records = await db.select().from(learning_record);
    expect(records).toHaveLength(0);
  });

  // B1-W1 (ADR-0035, D5 regression) — embedded checks are deliberately NOT
  // enrolled into the diagnostic axis: they never update mastery_state.θ̂.
  // Even with a labeled question, an embedded attempt writes zero mastery rows.
  it('does NOT write mastery_state for an embedded-check attempt (D5)', async () => {
    await seedEmbeddedQuestion('q_embed_theta', {
      knowledge_ids: ['k_embed'],
      reference_md: '答案',
    });

    const res = await postAttempt({ question_id: 'q_embed_theta', answer_md: '答案' });
    expect(res.status).toBe(200);

    const rows = await testDb().select().from(mastery_state);
    expect(rows).toHaveLength(0);
  });

  // Test 2: Happy path wrong
  it('wrong answer → outcome=failure, attempt event + learning_record(kind=mistake)', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '错' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      outcome: string;
      judge: { route: string; score: number };
      mistake_id: string;
    };
    expect(body.outcome).toBe('failure');
    expect(body.mistake_id).toBeTruthy();

    const db = testDb();

    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('attempt');
    expect(events[0].outcome).toBe('failure');

    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q1'));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(body.mistake_id);
    expect(records[0].kind).toBe('mistake');
    expect(records[0].question_id).toBe('q1');
    expect(records[0].attempt_event_id).toBe(events[0].id);
    expect((records[0].payload as Record<string, unknown>).from).toBe('embedded_check');
  });

  it('teaching_check wrong answer → failure event + mistake provenance from teaching_check', async () => {
    await seedEmbeddedQuestion('q_teach', {
      source: 'teaching_check',
      reference_md: '答案',
      source_ref: 'agent_msg_1',
    });

    const res = await postAttempt({ question_id: 'q_teach', answer_md: '错' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      outcome: string;
      mistake_id: string;
    };
    expect(body.outcome).toBe('failure');
    expect(body.mistake_id).toBeTruthy();

    const db = testDb();
    const events = await db.select().from(event).where(eq(event.subject_id, 'q_teach'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect((events[0].payload as Record<string, unknown>).source).toBe('teaching_check');

    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q_teach'));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(body.mistake_id);
    expect((records[0].payload as Record<string, unknown>).from).toBe('teaching_check');
  });

  // Test 3: 422 on unsupported inline question source
  it('returns 422 when question source is not embedded', async () => {
    await seedEmbeddedQuestion('q1', { source: 'daily' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '答案' });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('question_not_embedded');
  });

  // Test 4: 404 on missing question
  it('returns 404 when question does not exist', async () => {
    const res = await postAttempt({ question_id: 'q_missing', answer_md: '答案' });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  // Test 5: 400 on missing/invalid body fields
  it('returns 400 when question_id is missing', async () => {
    const res = await postAttempt({ answer_md: '答案' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when answer_md is missing', async () => {
    const res = await postAttempt({ question_id: 'q1' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 on empty body', async () => {
    const res = POST(
      new Request('http://localhost/api/embedded-check/attempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    const response = await res;
    expect(response.status).toBe(400);
  });

  // Test 6: Auth — middleware enforces x-internal-token globally; route tests
  // assume auth has already passed (same pattern as learning-items/[id]/route.test.ts
  // which doesn't test middleware auth in the route test file). No per-route auth
  // assertion needed here.

  // Test 7: Idempotency — second attempt writes a second event + second learning_record
  it('second wrong attempt creates a second event row and second learning_record', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    await postAttempt({ question_id: 'q1', answer_md: '错1' });
    await postAttempt({ question_id: 'q1', answer_md: '错2' });

    const db = testDb();

    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(2);

    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q1'));
    expect(records).toHaveLength(2);
  });

  // Test 8: FSRS untouched
  it('does not write material_fsrs_state rows', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const db = testDb();

    const countBefore = await db.select().from(material_fsrs_state);

    // both correct and incorrect attempt
    await postAttempt({ question_id: 'q1', answer_md: '答案' });
    await postAttempt({ question_id: 'q1', answer_md: '错' });

    const countAfter = await db.select().from(material_fsrs_state);
    expect(countAfter.length).toBe(countBefore.length);
  });

  it('keyword partial → outcome=partial, no learning_record', async () => {
    await seedEmbeddedQuestion('q_keyword', {
      reference_md: '虚词；代词；连词',
      judge_kind_override: 'keyword',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
        keywords: ['虚词', '代词', '连词'],
      },
    });

    const res = await postAttempt({ question_id: 'q_keyword', answer_md: '虚词和代词' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      judge: { route: string; score: number; coarse_outcome: string };
      mistake_id?: string;
    };
    expect(body.outcome).toBe('partial');
    expect(body.judge).toMatchObject({ route: 'keyword', coarse_outcome: 'partial' });
    expect(body.mistake_id).toBeUndefined();

    const events = await testDb().select().from(event).where(eq(event.subject_id, 'q_keyword'));
    expect(events[0].outcome).toBe('partial');
    const records = await testDb()
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q_keyword'));
    expect(records).toHaveLength(0);
  });

  it('semantic correct/partial/incorrect outcomes use SemanticJudgeTask', async () => {
    await seedEmbeddedQuestion('q_semantic', {
      kind: 'short_answer',
      reference_md: '之在这里作代词，指代前文的人或事。',
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖核心要点' }],
        required_points: ['说明之作代词', '说明指代前文'],
      },
    });
    vi.mocked(runTask)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0.9,
          coarse_outcome: 'correct',
          confidence: 0.8,
          feedback_md: '要点完整。',
          evidence_json: { matched_points: ['说明之作代词'], missing_points: [] },
        }),
        cost: 0,
        usage: null,
        model: 'mock',
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0.5,
          coarse_outcome: 'partial',
          confidence: 0.8,
          feedback_md: '还缺少指代对象。',
          evidence_json: { matched_points: ['说明之作代词'], missing_points: ['说明指代前文'] },
        }),
        cost: 0,
        usage: null,
        model: 'mock',
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0,
          coarse_outcome: 'incorrect',
          confidence: 0.9,
          feedback_md: '未命中核心要点。',
          evidence_json: { matched_points: [], missing_points: ['说明之作代词'] },
        }),
        cost: 0,
        usage: null,
        model: 'mock',
      } as never);

    const correct = await postAttempt({ question_id: 'q_semantic', answer_md: '之作代词。' });
    const partial = await postAttempt({ question_id: 'q_semantic', answer_md: '是代词。' });
    const incorrect = await postAttempt({ question_id: 'q_semantic', answer_md: '不知道。' });

    expect((await correct.json()).outcome).toBe('success');
    expect((await partial.json()).outcome).toBe('partial');
    expect((await incorrect.json()).outcome).toBe('failure');
    expect(vi.mocked(runTask)).toHaveBeenCalledTimes(3);
  });

  it('semantic provider failure returns partial unsupported and creates no learning_record', async () => {
    await seedEmbeddedQuestion('q_semantic_fail', {
      kind: 'short_answer',
      reference_md: '之在这里作代词。',
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖核心要点' }],
        required_points: ['说明之作代词'],
      },
    });
    vi.mocked(runTask).mockRejectedValueOnce(new Error('provider down'));

    const res = await postAttempt({ question_id: 'q_semantic_fail', answer_md: '之作代词。' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      judge: { coarse_outcome: string; score: number | null };
      mistake_id?: string;
    };
    expect(body.outcome).toBe('partial');
    expect(body.judge.coarse_outcome).toBe('unsupported');
    expect(body.judge.score).toBeNull();
    expect(body.mistake_id).toBeUndefined();

    const records = await testDb()
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q_semantic_fail'));
    expect(records).toHaveLength(0);
  });
});
