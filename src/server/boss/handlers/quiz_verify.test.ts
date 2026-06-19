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

import { readAgentNotes } from '@/capabilities/agency/server/notes';
import { exactJudgeCapability } from '@/core/capability/judges/exact';
import type { QuizGenMetadataT } from '@/core/schema/quiz_gen';
import { event, knowledge, material_fsrs_state, question, source_document } from '@/db/schema';
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
  // YUK-224 F2 — tier-3 material relevance verdict. Omitted from the JSON when
  // undefined (older / non-material verifier outputs don't emit it).
  materialGroundingVerdict?: 'pass' | 'fail' | 'unclear';
}): string {
  return JSON.stringify({
    grounding: { verdict: opts.groundingVerdict ?? 'pass', note: 'grounded in source' },
    copy_safety: { verdict: opts.copySafety ?? 'original', max_overlap: 0.1 },
    knowledge_hit: { verdict: opts.knowledgeHitVerdict ?? 'pass', note: 'tests k1' },
    ...(opts.materialGroundingVerdict
      ? { material_grounding: { verdict: opts.materialGroundingVerdict, note: 'probes material' } }
      : {}),
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

// YUK-350 (B5 ADR-0038 决定 #2, increment 1) — objective draft seeds.
// A choice / true_false / fill_blank / translation draft carries a reference
// answer (+ choices for choice) so the deterministic exact judge can self-check
// objective kinds WITHOUT burning an LLM. judge_kind_override left null so the
// route resolves naturally (choices_md present → 'exact'; kind choice/true_false
// → 'exact'; translation → PROSE → semantic, NOT short-circuited).
async function seedObjectiveDraftQuestion(opts: {
  id: string;
  knowledgeId: string;
  kind: 'choice' | 'true_false' | 'fill_blank' | 'translation';
  referenceMd?: string;
  choicesMd?: string[] | null;
  source?: string;
}) {
  const db = testDb();
  const now = new Date();
  const defaultChoices =
    opts.kind === 'choice'
      ? ['A. 取消句子独立性', 'B. 表示领属', 'C. 代词', 'D. 动词「到」']
      : opts.kind === 'true_false'
        ? ['对', '错']
        : null;
  await db.insert(question).values({
    id: opts.id,
    kind: opts.kind,
    prompt_md: '下列关于「之」作主谓间助词的说法，正确的是？',
    reference_md: opts.referenceMd ?? 'A',
    rubric_json: null as never,
    choices_md: opts.choicesMd === undefined ? defaultChoices : opts.choicesMd,
    judge_kind_override: null,
    knowledge_ids: [opts.knowledgeId],
    difficulty: 3,
    source: opts.source ?? 'quiz_gen',
    source_ref: opts.knowledgeId,
    // draft_status explicitly set (audit:draft-status compliant).
    draft_status: 'draft',
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr_gen' } as never,
    metadata: { quiz_gen: BASE_META } as never,
    created_at: now,
    updated_at: now,
  });
}

// YUK-224 (slice 3, tier 3) — material_grounded meta carrying the grounded doc id.
function materialMeta(materialDocId: string): QuizGenMetadataT {
  return {
    ...BASE_META,
    generation_method: 'material_grounded',
    material_source_document_id: materialDocId,
  };
}

async function seedMaterialDoc(opts: { id: string; bodyMd?: string }) {
  const db = testDb();
  const now = new Date();
  await db.insert(source_document).values({
    id: opts.id,
    title: '汉朝的建立',
    source_asset_ids: [],
    body_md: opts.bodyMd ?? '汉朝由刘邦建立于公元前 202 年，定都长安。',
    provenance: {
      source_kind: 'quiz_gen_material',
      url: 'https://example.edu/han/founding',
      fetched_at: '2026-06-06T10:00:00.000Z',
    } as never,
    created_at: now,
    updated_at: now,
    version: 0,
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

// U8 / AF §4 — coach-addressed question_pool_gap notes referencing a knowledge id.
async function poolGapNotesForKnowledge(knowledgeId: string): Promise<number> {
  const notes = await readAgentNotes(testDb(), { for_agent: 'coach', now: new Date() });
  return notes.filter(
    (n) =>
      n.signal_kind === 'question_pool_gap' &&
      n.source_task_kind === 'quiz_verify' &&
      n.refs.some((r) => r.id === knowledgeId),
  ).length;
}

// YUK-350 (RL1) — read the verify event rows (payload) for a question so a test can
// assert the system-error class on the catch-bottom event.
async function verifyEventsFor(questionId: string): Promise<
  {
    outcome: string | null;
    payload: Record<string, unknown> | null;
  }[]
> {
  const rows = await testDb()
    .select({ outcome: event.outcome, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:quiz_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    );
  return rows.map((r) => ({
    outcome: r.outcome,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
  }));
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
    // U8 / AF §4 (U3 L-note) — a promoted draft DID enter the pool, so no
    // question_pool_gap hint is left.
    expect(await poolGapNotesForKnowledge('k1')).toBe(0);
  });

  // Codex (PR #295) — enroll-if-absent. Verifying a NEW question that binds to a
  // knowledge point which already has an FSRS projection (supplementary-question
  // scenario) must NOT reset that node's state/due_at back to a fresh card.
  it('pass: does NOT reset an existing knowledge FSRS schedule when binding a new question', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q_existing_sched', knowledgeId: 'k1' });

    // Pre-existing knowledge-level projection with a far-future due + prior reps.
    const futureDue = new Date(Date.now() + 30 * 86400 * 1000);
    const priorState = {
      due: futureDue.toISOString(),
      stability: 12,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 30,
      learning_steps: 0,
      reps: 4,
      lapses: 1,
      state: 'review',
      last_review: new Date(Date.now() - 86400 * 1000).toISOString(),
    };
    await testDb()
      .insert(material_fsrs_state)
      .values({
        id: 'f_k1_existing',
        subject_kind: 'knowledge',
        subject_id: 'k1',
        state: priorState as never,
        due_at: futureDue,
        last_review_event_id: 'evt_prior_review',
        updated_at: new Date(),
      });

    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_keep');
    const result = await runQuizVerify({ db: testDb(), questionId: 'q_existing_sched', runTaskFn });
    expect(result.status).toBe('verified');

    // Still exactly one knowledge row, with the ORIGINAL state/due preserved.
    const rows = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          eq(material_fsrs_state.subject_id, 'k1'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].due_at.getTime()).toBe(futureDue.getTime());
    expect(rows[0].last_review_event_id).toBe('evt_prior_review');
    expect((rows[0].state as { reps: number }).reps).toBe(4);

    // The question is still promoted to active.
    const qRows = await testDb().select().from(question).where(eq(question.id, 'q_existing_sched'));
    expect(qRows[0].draft_status).toBe('active');
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
    // U8 / AF §4 (U3 L-note) — a draft that did NOT enter the pool leaves a
    // coach-addressed question_pool_gap hint referencing its knowledge point(s).
    expect(await poolGapNotesForKnowledge('k1')).toBe(1);
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

    // YUK-350 (RL1) — the transient-error event carries the machine-readable
    // system-error marker payload.overall='error' (model can never emit it).
    const evs = await verifyEventsFor('q5b');
    const errorEv = evs.find((e) => e.outcome === 'error');
    expect(errorEv).toBeDefined();
    expect(errorEv?.payload?.overall).toBe('error');
    // YUK-350 (L3, RL5) — the SAME transient-error event also carries the event-layer
    // failure_class='system_error' (merged with L1's overall='error' assertion above).
    expect(errorEv?.payload?.failure_class).toBe('system_error');
    // the terminal success event carries the model verdict, NOT 'error', and (promote)
    // carries NO failure_class.
    const successEv = evs.find((e) => e.outcome === 'success');
    expect(successEv?.payload?.overall).toBe('pass');
    expect(successEv?.payload?.failure_class).toBeUndefined();
  });

  // YUK-350 (RL1) — system-error class: a task/parse blowup BEFORE a verdict must
  // re-throw (pg-boss retries), leave the draft un-promoted with zero FSRS rows, and
  // record outcome='error' + payload.overall='error'. The model can never inject
  // 'error' through the LLM-parse path (asserted in the unit test).
  it("system error: re-throws, stays draft, 0 FSRS, event outcome='error' + payload.overall='error'", async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q_syserr', knowledgeId: 'k1' });
    // Bad JSON → parseQuizVerifyOutput throws inside the try → catch-bottom.
    const runTaskFn = runTaskMock('not a json verdict at all', 'tr_syserr');

    await expect(
      runQuizVerify({ db: testDb(), questionId: 'q_syserr', runTaskFn }),
    ).rejects.toThrow();

    // NEVER promoted.
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_syserr'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'q_syserr')).toBe(0);

    // Exactly one event, outcome='error', payload.overall='error'.
    const evs = await verifyEventsFor('q_syserr');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('error');
    expect(evs[0].payload?.overall).toBe('error');
    // YUK-350 (L3, RL5) — event-layer system-error class.
    expect(evs[0].payload?.failure_class).toBe('system_error');
  });

  // YUK-350 (L3, RL5) — a model verdict that does NOT promote (real validation
  // failure) carries payload.failure_class='validation_failure', distinct from the
  // system_error class. Stays draft, no FSRS.
  it("non-promote success: payload.failure_class='validation_failure'", async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q_valfail', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'fail' }), 'tr_valfail');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_valfail', runTaskFn });
    expect(result.status).toBe('failed');

    const rows = await testDb().select().from(question).where(eq(question.id, 'q_valfail'));
    expect(rows[0].draft_status).toBe('draft');

    const evs = await verifyEventsFor('q_valfail');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('failure');
    expect(evs[0].payload?.failure_class).toBe('validation_failure');
    // not a system error.
    expect(evs[0].payload?.overall).toBe('fail');
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

  // YUK-224 (slice 3, tier 3) — material_grounding check.
  it('tier 3 material_grounded: feeds the grounded material to the verifier + records material_grounding, promotes on pass', async () => {
    await seedKnowledge('k1');
    await seedMaterialDoc({ id: 'doc1' });
    await seedDraftQuestion({ id: 'qm1', knowledgeId: 'k1', meta: materialMeta('doc1') });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_mat_v');

    const result = await runQuizVerify({ db: testDb(), questionId: 'qm1', runTaskFn });
    expect(result.status).toBe('verified');

    // The verifier receives the persisted material body so the grounding check can
    // confirm the question probes THAT material (spec §6.1 row 3 真原文判据).
    const input = runTaskFn.mock.calls[0][1] as { material?: { body_md?: string } };
    expect(input.material?.body_md).toContain('公元前 202 年');

    // Promoted into the pool.
    const rows = await testDb().select().from(question).where(eq(question.id, 'qm1'));
    expect(rows[0].draft_status).toBe('active');

    // The verify event records source_tier=3 + the material_grounding outcome.
    const evRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:quiz_verify'), eq(event.subject_id, 'qm1')));
    expect(evRows).toHaveLength(1);
    expect(evRows[0].payload).toMatchObject({
      source_tier: 3,
      material_grounding: { material_source_document_id: 'doc1', material_present: true },
    });
  });

  it('tier 3 material_grounded: does NOT promote when the grounded source_document is missing', async () => {
    await seedKnowledge('k1');
    // No seedMaterialDoc — the referenced doc never persisted / was deleted.
    await seedDraftQuestion({ id: 'qm2', knowledgeId: 'k1', meta: materialMeta('doc_gone') });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_mat_gone');

    const result = await runQuizVerify({ db: testDb(), questionId: 'qm2', runTaskFn });
    // LLM said pass, but the material_grounding structural guard blocks promotion.
    expect(result.status).toBe('needs_review');

    const rows = await testDb().select().from(question).where(eq(question.id, 'qm2'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);

    const evRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:quiz_verify'), eq(event.subject_id, 'qm2')));
    expect(evRows[0].payload).toMatchObject({
      source_tier: 3,
      material_grounding: { material_present: false },
      promoted: false,
    });
  });

  // YUK-224 F2 (PR #314 round-1) — the material is present + non-empty, but the
  // verifier judges the question does NOT actually probe it (irrelevant material).
  // The relevance verdict must block promotion even though overall='pass' and the
  // material row exists (the old gate only checked "row non-empty").
  it('tier 3 material_grounded: irrelevant material (material_grounding=fail) blocks promotion', async () => {
    await seedKnowledge('k1');
    await seedMaterialDoc({ id: 'doc1' });
    await seedDraftQuestion({ id: 'qm3', knowledgeId: 'k1', meta: materialMeta('doc1') });
    const runTaskFn = runTaskMock(
      verifyOutput({ overall: 'pass', materialGroundingVerdict: 'fail' }),
      'tr_mat_irrelevant',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'qm3', runTaskFn });
    expect(result.status).toBe('needs_review');

    const rows = await testDb().select().from(question).where(eq(question.id, 'qm3'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);

    const evRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:quiz_verify'), eq(event.subject_id, 'qm3')));
    expect(evRows[0].payload).toMatchObject({
      source_tier: 3,
      material_grounding: { material_present: true, verdict: 'fail' },
      promoted: false,
    });
  });
});

// YUK-350 (B5 ADR-0038 决定 #2, increment 1) — DETERMINISTIC objective-question
// verify short-circuit. choice / true_false drafts whose route resolves to the
// `exact` judge are verified WITHOUT burning an LLM. A runTaskFn that THROWS if
// called proves the LLM path is never taken. fill_blank is increment 2 (still
// LLM this increment); prose/translation must NEVER short-circuit.
describe('runQuizVerify — deterministic objective short-circuit (YUK-350 inc 1)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // A runTaskFn that explodes if invoked — its absence-of-call proves the
  // deterministic path replaced the LLM verdict source.
  function throwingRunTaskFn() {
    return vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => {
      throw new Error('LLM runTaskFn MUST NOT be called for a short-circuited objective question');
    });
  }

  it('(a) choice with a correct reference: deterministic pass — LLM NOT called, draft promotes to active', async () => {
    await seedKnowledge('k1');
    // reference 'A' matches the leading-letter of choice option 'A. 取消句子独立性'.
    await seedObjectiveDraftQuestion({
      id: 'oc1',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
    });
    const runTaskFn = throwingRunTaskFn();

    const result = await runQuizVerify({ db: testDb(), questionId: 'oc1', runTaskFn });

    // LLM short-circuited.
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(result.status).toBe('verified');
    expect(result.overall).toBe('pass');

    // Promote path unchanged: draft→active + per-knowledge FSRS enroll.
    const rows = await testDb().select().from(question).where(eq(question.id, 'oc1'));
    expect(rows[0].draft_status).toBe('active');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'oc1')).toBe(0);

    // Exactly one verify event, outcome success.
    expect(await countVerifyEvents('oc1')).toBe(1);

    // The verify event payload carries the deterministic_check axis (verdict source
    // = deterministic, not LLM).
    const evs = await verifyEventsFor('oc1');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('success');
    expect(evs[0].payload?.overall).toBe('pass');
    const axes = (evs[0].payload?.axes ?? []) as Array<{ axis_name: string; verdict: string }>;
    expect(axes.some((a) => a.axis_name === 'deterministic_check')).toBe(true);
  });

  it('(b) true_false correct → pass/promote; incorrect (empty reference) → no-promote, stays draft', async () => {
    await seedKnowledge('k1');
    // correct: reference '对' matches option '对'.
    await seedObjectiveDraftQuestion({
      id: 'tf_ok',
      knowledgeId: 'k1',
      kind: 'true_false',
      referenceMd: '对',
    });
    // incorrect: empty reference → exact judge cannot verify → no promote.
    await seedObjectiveDraftQuestion({
      id: 'tf_bad',
      knowledgeId: 'k1',
      kind: 'true_false',
      referenceMd: '',
    });
    const runTaskFn = throwingRunTaskFn();

    const ok = await runQuizVerify({ db: testDb(), questionId: 'tf_ok', runTaskFn });
    expect(ok.status).toBe('verified');
    expect(ok.overall).toBe('pass');
    const okRows = await testDb().select().from(question).where(eq(question.id, 'tf_ok'));
    expect(okRows[0].draft_status).toBe('active');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);

    const bad = await runQuizVerify({ db: testDb(), questionId: 'tf_bad', runTaskFn });
    expect(bad.status).not.toBe('verified');
    const badRows = await testDb().select().from(question).where(eq(question.id, 'tf_bad'));
    expect(badRows[0].draft_status).toBe('draft');

    // The deterministic path never touched the LLM for either question.
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // NEGATIVE — a translation (PROSE_KIND) draft must NOT be short-circuited; it
  // still hits the LLM runTaskFn exactly once.
  it('(c) translation (PROSE_KIND): LLM runTaskFn IS called once (not mis-short-circuited)', async () => {
    await seedKnowledge('k1');
    await seedObjectiveDraftQuestion({
      id: 'tr1',
      knowledgeId: 'k1',
      kind: 'translation',
      referenceMd: '把这句古文翻成白话。',
      choicesMd: null,
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_prose');

    const result = await runQuizVerify({ db: testDb(), questionId: 'tr1', runTaskFn });

    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');
    expect(result.status).toBe('verified');
  });

  // fill_blank is increment 2 — STILL the LLM path this increment.
  it('(d) fill_blank: STILL hits the LLM path this increment (increment 2 handles it)', async () => {
    await seedKnowledge('k1');
    await seedObjectiveDraftQuestion({
      id: 'fb1',
      knowledgeId: 'k1',
      kind: 'fill_blank',
      referenceMd: '取消句子独立性',
      choicesMd: null,
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_fb');

    const result = await runQuizVerify({ db: testDb(), questionId: 'fb1', runTaskFn });

    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');
    expect(result.status).toBe('verified');
  });

  // (e) idempotency — a second run of a deterministically-verified choice skips
  // (no duplicate event, no re-promote), proving the existing promote/idempotency
  // guard is not regressed by the short-circuit.
  it('(e) idempotency: second run of a deterministic choice skips, no duplicate event / FSRS row', async () => {
    await seedKnowledge('k1');
    await seedObjectiveDraftQuestion({
      id: 'oc_idem',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
    });
    const runTaskFn = throwingRunTaskFn();

    const first = await runQuizVerify({ db: testDb(), questionId: 'oc_idem', runTaskFn });
    expect(first.status).toBe('verified');

    const second = await runQuizVerify({ db: testDb(), questionId: 'oc_idem', runTaskFn });
    expect(second.status).toBe('skipped:already_verified');

    expect(runTaskFn).not.toHaveBeenCalled();
    expect(await countVerifyEvents('oc_idem')).toBe(1);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'oc_idem')).toBe(0);
  });

  // (f) FAILURE-BOTTOM (YUK-478) — the deterministic short-circuit early-returns BEFORE
  // the LLM try/catch, so without its OWN catch a thrown exact-judge / buildLocalJudgeQuestion
  // / DB error would crash the pg-boss job with NO verify-event trail and leave the draft in a
  // non-deterministic state with no clean retry. Force the exact judge to throw and assert the
  // SAME error-handling contract as the LLM path: a failure verify-event (outcome='error' /
  // failure_class='system_error' / overall='error') is written, the error is re-thrown for
  // pg-boss retry, and the draft is NOT promoted (stays draft_status='draft', no FSRS row).
  it('(f) exact judge throws → writes system_error verify-event, re-throws, draft NOT promoted', async () => {
    await seedKnowledge('k1');
    await seedObjectiveDraftQuestion({
      id: 'oc_throw',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
    });
    // A runTaskFn that would explode if the deterministic path ever fell through to the LLM —
    // proves the error came from the deterministic body, not the LLM path.
    const runTaskFn = throwingRunTaskFn();

    const judgeSpy = vi.spyOn(exactJudgeCapability, 'run').mockImplementation(() => {
      throw new Error('boom: exact judge blew up mid-verify');
    });
    try {
      // The error must propagate (re-thrown for pg-boss retry).
      await expect(
        runQuizVerify({ db: testDb(), questionId: 'oc_throw', runTaskFn }),
      ).rejects.toThrow('boom: exact judge blew up mid-verify');
    } finally {
      judgeSpy.mockRestore();
    }

    // Draft NOT promoted — stays draft, no FSRS enroll.
    const rows = await testDb().select().from(question).where(eq(question.id, 'oc_throw'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('question', 'oc_throw')).toBe(0);

    // verification.status best-effort marked failed on the row.
    const meta = await readMeta('oc_throw');
    expect((meta?.verification as Record<string, unknown>)?.status).toBe('failed');

    // A failure verify-event was written: outcome='error', system_error class, overall='error'.
    const evs = await verifyEventsFor('oc_throw');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('error');
    expect(evs[0].payload?.overall).toBe('error');
    expect(evs[0].payload?.failure_class).toBe('system_error');

    // The LLM path was never reached.
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
