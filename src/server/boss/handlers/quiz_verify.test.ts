// Q5 + Q6 — search-grounded QuizGen verify handler DB test
// (docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §3 / §5).
//
// Mocks the AI (runTaskFn). Asserts the Option-B gate:
//   - verify pass → draft_status 'draft'→'active' + material_fsrs_state row built
//     (Q6 FSRS enroll, question enters the pool) + metadata.quiz_gen.verification
//     status='verified' + copy_safety checked_by='quiz_verify'.
//   - LLM overall='fail' → stays draft + verification.status='failed'.
//   - copy_safety 'too_close' (LLM or deterministic overlap) → stays draft +
//     verification.status='needs_review' + NO FSRS enroll.
//   - idempotency — a second run skips (no duplicate verify event, no re-promote).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuizGenMetadataT } from '@/core/schema/quiz_gen';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  COPY_SAFETY_TOO_CLOSE_THRESHOLD,
  buildQuizVerifyHandler,
  maxNgramOverlap,
  runQuizVerify,
} from './quiz_verify';

function verifyOutput(opts: {
  overall: 'pass' | 'needs_review' | 'fail';
  copySafety?: 'original' | 'too_close' | 'unknown';
  groundingVerdict?: 'pass' | 'fail' | 'unclear';
  knowledgeHitVerdict?: 'pass' | 'fail' | 'unclear';
}): string {
  return JSON.stringify({
    grounding: { verdict: opts.groundingVerdict ?? 'pass', note: 'grounded in source' },
    copy_safety: { verdict: opts.copySafety ?? 'original', max_overlap: 0.1 },
    knowledge_hit: { verdict: opts.knowledgeHitVerdict ?? 'pass', note: 'tests k1' },
    overall: opts.overall,
    summary_md: `复核结论：${opts.overall}`,
    confidence: 0.8,
  });
}

function runTaskMock(output: string, taskRunId = 'tr_v') {
  return vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
    text: output,
    task_run_id: taskRunId,
  }));
}

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

const BASE_META: QuizGenMetadataT = {
  source_pack: {
    query_plan: ['文言 之 主谓间 用法'],
    searched_at: '2026-06-02T10:00:00.000Z',
    tool: 'tavily',
  },
  source_refs: [
    {
      url: 'https://example.edu/wenyan/zhi',
      title: '文言虚词「之」',
      snippet: '之用于主谓之间，取消句子独立性。',
      used_for: 'fact',
      extracted: true,
    },
  ],
  generation_method: 'search_grounded',
  copy_safety: { verdict: 'original', max_overlap: 0.12, checked_by: 'agent_self' },
  generation_status: 'ready',
};

async function seedDraftQuestion(opts: {
  id: string;
  knowledgeId: string;
  promptMd?: string;
  meta?: QuizGenMetadataT;
  source?: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: opts.promptMd ?? '用你自己的话解释「之」作主谓间助词的作用。',
    reference_md: '「之」用在主谓之间，取消句子独立性。',
    rubric_json: { required_points: ['用在主谓之间', '取消句子独立性'] } as never,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: [opts.knowledgeId],
    difficulty: 3,
    source: opts.source ?? 'quiz_gen',
    source_ref: opts.knowledgeId,
    draft_status: 'draft',
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr_gen' } as never,
    metadata: { quiz_gen: opts.meta ?? BASE_META } as never,
    created_at: now,
    updated_at: now,
  });
}

async function readMeta(questionId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await testDb().select().from(question).where(eq(question.id, questionId)).limit(1);
  const m = rows[0]?.metadata as Record<string, unknown> | null;
  return m?.quiz_gen as Record<string, unknown> | undefined;
}

async function countVerifyEvents(questionId: string): Promise<number> {
  const rows = await testDb()
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:quiz_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    );
  return rows.length;
}

async function fsrsRowCount(subjectKind: string, subjectId: string): Promise<number> {
  const rows = await testDb()
    .select({ id: material_fsrs_state.id })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        eq(material_fsrs_state.subject_id, subjectId),
      ),
    );
  return rows.length;
}

describe('maxNgramOverlap (deterministic copy-safety signal)', () => {
  it('returns a high score for a near-verbatim copy and low for original wording', () => {
    const snippet = '之用于主谓之间，取消句子独立性。';
    const verbatim = maxNgramOverlap('之用于主谓之间，取消句子独立性。', [snippet]);
    const original = maxNgramOverlap('用你自己的话谈谈这个虚词在句子里的语法角色。', [snippet]);
    expect(verbatim).toBeGreaterThan(original);
    expect(verbatim).toBeGreaterThanOrEqual(COPY_SAFETY_TOO_CLOSE_THRESHOLD);
  });

  it('returns 0 when there are no snippets', () => {
    expect(maxNgramOverlap('anything at all here', [])).toBe(0);
  });
});

describe('runQuizVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('pass: promotes draft→active and FSRS-enrolls the question', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q1', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_pass');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q1', runTaskFn });

    expect(result.status).toBe('verified');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');

    const rows = await testDb().select().from(question).where(eq(question.id, 'q1'));
    expect(rows[0].draft_status).toBe('active');

    // YUK-203 P3 — FSRS enroll is per knowledge point; the verified question is
    // just the current probe chosen when that knowledge becomes due.
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'q1')).toBe(0);

    const meta = await readMeta('q1');
    expect((meta?.verification as Record<string, unknown>)?.status).toBe('verified');
    // copy_safety re-checked by quiz_verify (was agent_self).
    expect((meta?.copy_safety as Record<string, unknown>)?.checked_by).toBe('quiz_verify');
    expect(typeof (meta?.copy_safety as Record<string, unknown>)?.max_overlap).toBe('number');
    // source_pack / source_refs preserved.
    expect(meta?.source_pack).toMatchObject({ tool: 'tavily' });
    expect((meta?.source_refs as unknown[]).length).toBe(1);

    // one verify event, outcome success.
    expect(await countVerifyEvents('q1')).toBe(1);
  });

  it('fail: leaves draft + verification.status=failed + NO FSRS enroll', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q2', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(
      verifyOutput({ overall: 'fail', groundingVerdict: 'fail' }),
      'tr_fail',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'q2', runTaskFn });

    expect(result.status).toBe('failed');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q2'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'q2')).toBe(0);
    const meta = await readMeta('q2');
    expect((meta?.verification as Record<string, unknown>)?.status).toBe('failed');
    expect(await countVerifyEvents('q2')).toBe(1);
  });

  it('too_close (LLM verdict): leaves draft + needs_review + NO FSRS enroll', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q3', knowledgeId: 'k1' });
    // overall=pass but copy_safety=too_close — gate must still block promotion.
    const runTaskFn = runTaskMock(
      verifyOutput({ overall: 'pass', copySafety: 'too_close' }),
      'tr_close',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'q3', runTaskFn });

    expect(result.status).toBe('needs_review');
    expect(result.copy_safety_verdict).toBe('too_close');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q3'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'q3')).toBe(0);
    const meta = await readMeta('q3');
    expect((meta?.verification as Record<string, unknown>)?.status).toBe('needs_review');
  });

  it('too_close (deterministic overlap): blocks promotion even when the LLM says original', async () => {
    await seedKnowledge('k1');
    // prompt is a near-verbatim copy of the source snippet → deterministic overlap
    // crosses the threshold even though the LLM (mock) reports copy_safety=original.
    await seedDraftQuestion({
      id: 'q4',
      knowledgeId: 'k1',
      promptMd: '之用于主谓之间，取消句子独立性。',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass', copySafety: 'original' }));

    const result = await runQuizVerify({ db: testDb(), questionId: 'q4', runTaskFn });

    expect(result.copy_safety_verdict).toBe('too_close');
    expect(result.status).toBe('needs_review');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q4'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'q4')).toBe(0);
  });

  it('idempotency: a second run skips (no duplicate event, no re-run of the LLM)', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q5', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const first = await runQuizVerify({ db: testDb(), questionId: 'q5', runTaskFn });
    expect(first.status).toBe('verified');

    const second = await runQuizVerify({ db: testDb(), questionId: 'q5', runTaskFn });
    expect(second.status).toBe('skipped:already_verified');
    // LLM only ran on the first pass.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    // exactly one verify event, one fsrs row.
    expect(await countVerifyEvents('q5')).toBe(1);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'q5')).toBe(0);
  });

  it('idempotency: a first transient failure does NOT short-circuit the retry', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q5b', knowledgeId: 'k1' });
    // First invocation throws (transient LLM/parse/DB error → catch-bottom writes a
    // failure event with outcome='error'); second invocation succeeds. The second
    // run MUST re-invoke the task and verify, NOT skip as already_verified.
    const runTaskFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient boom'))
      .mockResolvedValueOnce({ text: verifyOutput({ overall: 'pass' }), task_run_id: 'tr_retry' });

    await expect(runQuizVerify({ db: testDb(), questionId: 'q5b', runTaskFn })).rejects.toThrow(
      /transient boom/,
    );

    const second = await runQuizVerify({ db: testDb(), questionId: 'q5b', runTaskFn });
    expect(second.status).toBe('verified');
    expect(runTaskFn).toHaveBeenCalledTimes(2);

    const rows = await testDb().select().from(question).where(eq(question.id, 'q5b'));
    expect(rows[0].draft_status).toBe('active');
    // two verify events (one transient-error, one terminal success) + one fsrs row.
    expect(await countVerifyEvents('q5b')).toBe(2);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'q5b')).toBe(0);
  });

  it('does NOT promote when overall=pass but a structured check verdict is fail', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q7', knowledgeId: 'k1' });
    // Inconsistent output: roll-up says pass but grounding failed — must stay draft.
    const runTaskFn = runTaskMock(
      verifyOutput({ overall: 'pass', groundingVerdict: 'fail' }),
      'tr_inconsistent',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'q7', runTaskFn });

    expect(result.status).toBe('needs_review');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q7'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'q7')).toBe(0);
  });

  it('skips a non-quiz_gen question', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q6', knowledgeId: 'k1', source: 'embedded' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const result = await runQuizVerify({ db: testDb(), questionId: 'q6', runTaskFn });
    expect(result.status).toBe('skipped:not_quiz_gen');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('skips a missing question', async () => {
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));
    const result = await runQuizVerify({ db: testDb(), questionId: 'missing', runTaskFn });
    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});

describe('buildQuizVerifyHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('verifies every question_id in the job batch', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'qa', knowledgeId: 'k1' });
    await seedDraftQuestion({ id: 'qb', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const handler = buildQuizVerifyHandler(testDb(), { runTaskFn });
    await handler([{ id: 'j1', data: { question_ids: ['qa', 'qb'] } }] as never);

    expect(runTaskFn).toHaveBeenCalledTimes(2);
    const qa = await testDb().select().from(question).where(eq(question.id, 'qa'));
    const qb = await testDb().select().from(question).where(eq(question.id, 'qb'));
    expect(qa[0].draft_status).toBe('active');
    expect(qb[0].draft_status).toBe('active');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'qa')).toBe(0);
    expect(await fsrsRowCount('question', 'qb')).toBe(0);
  });
});
