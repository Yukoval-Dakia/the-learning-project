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

// YUK-538 / YUK-554 — solve-check wiring makes tier3/4 verify fire a SECOND task
// (SolutionGenerateTask) whenever all free checks pass, so tests that want to control the
// solve outcome must dispatch by task kind. Solver output shape consumed by runSolveCheck
// (reads only reference_solution.final_answer + answer_equivalents).
function solverOutput(finalAnswer: string, equivalents: string[] = []): string {
  return JSON.stringify({
    reference_solution: { final_answer: finalAnswer, answer_equivalents: equivalents },
  });
}

// SemanticJudgeTask output shape (SemanticJudgeOutput schema) for the open-question solve
// path — only a confident 'incorrect' (confidence>=0.8) makes solve_check fail.
function semanticJudgeOutput(
  outcome: 'correct' | 'partial' | 'incorrect',
  confidence: number,
): string {
  return JSON.stringify({
    score: outcome === 'incorrect' ? 0 : outcome === 'partial' ? 0.5 : 0.9,
    coarse_outcome: outcome,
    confidence,
    feedback_md: 'fb',
    evidence_json: { matched_points: [], missing_points: [] },
  });
}

// QuizVerifyTask → verifyText; SolutionGenerateTask → solverText; everything else →
// verifyText. Covers the exact (normalize) solve path (no SemanticJudge call).
function dualTaskMock(verifyText: string, solverText: string, taskRunId = 'tr_v') {
  return vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => ({
    text: kind === 'SolutionGenerateTask' ? solverText : verifyText,
    task_run_id: taskRunId,
  }));
}

// Three-way dispatch for the open-question (semantic) solve path: QuizVerifyTask →
// verifyText, SolutionGenerateTask → solverText, SemanticJudgeTask → semanticText.
function tripleTaskMock(
  verifyText: string,
  solverText: string,
  semanticText: string,
  taskRunId = 'tr_v',
) {
  return vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => ({
    text:
      kind === 'SolutionGenerateTask'
        ? solverText
        : kind === 'SemanticJudgeTask'
          ? semanticText
          : verifyText,
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
  // YUK-538 / YUK-554 — override to seed an EXACT-kind question (fill_blank / choice) so a
  // solve-check normalize-mismatch fail can be built. Default stays the semantic short_answer.
  kind?: string;
  referenceMd?: string;
  choicesMd?: string[] | null;
  judge?: string | null;
  rubricJson?: unknown;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: opts.kind ?? 'short_answer',
    prompt_md: opts.promptMd ?? '用你自己的话解释「之」作主谓间助词的作用。',
    reference_md: opts.referenceMd ?? '「之」用在主谓之间，取消句子独立性。',
    rubric_json: (opts.rubricJson ?? {
      required_points: ['用在主谓之间', '取消句子独立性'],
    }) as never,
    choices_md: opts.choicesMd === undefined ? null : opts.choicesMd,
    judge_kind_override: opts.judge === undefined ? 'semantic' : opts.judge,
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
    // YUK-538 / YUK-554 — a tier4 all-pass row now fires verify + an independent solve
    // (SolutionGenerateTask). The single-value mock returns the verify JSON for the solver
    // too → empty final_answer → solve_check 'unsupported' → non-blocking (promote stands).
    expect(runTaskFn).toHaveBeenCalledTimes(2);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');
    expect(runTaskFn.mock.calls[1][0]).toBe('SolutionGenerateTask');

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
    // LLM only ran on the first pass (verify + solve = 2); the second run skips.
    expect(runTaskFn).toHaveBeenCalledTimes(2);
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
    // YUK-538 / YUK-554 — 1st run rejects at QuizVerifyTask (never reaches solve); 2nd run
    // fires verify + solve = 2. The 3rd call (solve) hits the unqueued vi.fn default
    // (undefined) → runSolveCheck destructures undefined.text → throws → swallowed to
    // 'unsupported' → non-blocking, status stays verified. Total = 3.
    expect(runTaskFn).toHaveBeenCalledTimes(3);

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

  // ─────────────────────────────────────────────────────────────────────────────
  // YUK-538 / YUK-554 — solve_check wiring (spec docs/design/2026-07-03-verify-check-spec.md).
  // NOTE: the flag-off retreat (SOLVE_CHECK_TIER34_VETO.normalize=false) is verified as a
  // pure-function unit test in verify-framework.test.ts (`solveCheckBlocks` describe) — the
  // handler consumes the module-const default, so there is no runtime flag seam to drive here.
  // ─────────────────────────────────────────────────────────────────────────────

  it('solve_check pass (exact normalize match) + all else pass → promotes', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'qsolve_pass',
      knowledgeId: 'k1',
      kind: 'fill_blank',
      judge: 'exact',
      promptMd: '「之」这个字在此句中的词性是____。',
      referenceMd: '代词',
      rubricJson: { required_points: [] },
    });
    // solver AGREES with the reference (代词) → normalize match → solve_check pass.
    const runTaskFn = dualTaskMock(
      verifyOutput({ overall: 'pass' }),
      solverOutput('代词'),
      'tr_sp',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'qsolve_pass', runTaskFn });
    expect(result.status).toBe('verified');

    const rows = await testDb().select().from(question).where(eq(question.id, 'qsolve_pass'));
    expect(rows[0].draft_status).toBe('active');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);

    const evs = await verifyEventsFor('qsolve_pass');
    expect(evs).toHaveLength(1);
    const payload = evs[0].payload as Record<string, unknown>;
    expect(payload.solve_check).toMatchObject({ verdict: 'pass', compared_by: 'normalize' });
    const axes = payload.axes as { axis_name: string; verdict: string }[];
    expect(axes.find((a) => a.axis_name === 'solve_check')).toMatchObject({ verdict: 'pass' });
  });

  it('solve_check fail (exact normalize mismatch) → needs_review, stays draft, records fail', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'qsolve_fail',
      knowledgeId: 'k1',
      kind: 'fill_blank',
      judge: 'exact',
      promptMd: '「之」这个字在此句中的词性是____。',
      referenceMd: '代词',
      rubricJson: { required_points: [] },
    });
    // solver DISAGREES (助词 vs reference 代词) → normalize mismatch → solve_check fail.
    const runTaskFn = dualTaskMock(
      verifyOutput({ overall: 'pass' }),
      solverOutput('助词'),
      'tr_sf',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'qsolve_fail', runTaskFn });
    // Q1: an exact normalize-fail VETOES promotion but records `needs_review` (hold for human
    // review), NOT `failed` — the model self-review said pass, only the weak normalize signal
    // disagreed.
    expect(result.status).toBe('needs_review');

    const rows = await testDb().select().from(question).where(eq(question.id, 'qsolve_fail'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);

    const evs = await verifyEventsFor('qsolve_fail');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('partial');
    const payload = evs[0].payload as Record<string, unknown>;
    expect(payload.promoted).toBe(false);
    // Q4/#6 payload completeness — all four solve_check fields present + typed.
    expect(payload.solve_check).toMatchObject({
      verdict: 'fail',
      compared_by: 'normalize',
      solver_final_answer: '助词',
    });
    expect(typeof (payload.solve_check as Record<string, unknown>).reason).toBe('string');
    const axes = payload.axes as { axis_name: string; verdict: string }[];
    expect(axes.find((a) => a.axis_name === 'solve_check')).toMatchObject({ verdict: 'fail' });
  });

  it('solve_check fail (semantic confident-incorrect) → needs_review, compared_by=semantic', async () => {
    await seedKnowledge('k1');
    // default seed = short_answer + judge_kind_override 'semantic' → open (semantic) solve path.
    await seedDraftQuestion({ id: 'qsem_fail', knowledgeId: 'k1' });
    // solver produces an answer; SemanticJudge confidently scores it incorrect (>=0.8).
    const runTaskFn = tripleTaskMock(
      verifyOutput({ overall: 'pass' }),
      solverOutput('独立求解得到的一个答案'),
      semanticJudgeOutput('incorrect', 0.95),
      'tr_semf',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'qsem_fail', runTaskFn });
    expect(result.status).toBe('needs_review');

    const rows = await testDb().select().from(question).where(eq(question.id, 'qsem_fail'));
    expect(rows[0].draft_status).toBe('draft');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);

    const evs = await verifyEventsFor('qsem_fail');
    const payload = evs[0].payload as Record<string, unknown>;
    expect(payload.solve_check).toMatchObject({ verdict: 'fail', compared_by: 'semantic' });
  });

  it('solve_check unsupported (empty solver answer) → non-blocking, promotes', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'qsolve_unsup', knowledgeId: 'k1' });
    // empty solver final_answer → runSolveCheck 'unsupported' (short-circuits before Semantic).
    const runTaskFn = dualTaskMock(verifyOutput({ overall: 'pass' }), solverOutput(''), 'tr_unsup');

    const result = await runQuizVerify({ db: testDb(), questionId: 'qsolve_unsup', runTaskFn });
    // unsupported carries no signal → never blocks (R2 conservative) → promote stands.
    expect(result.status).toBe('verified');
    const rows = await testDb().select().from(question).where(eq(question.id, 'qsolve_unsup'));
    expect(rows[0].draft_status).toBe('active');

    const evs = await verifyEventsFor('qsolve_unsup');
    const payload = evs[0].payload as Record<string, unknown>;
    expect(payload.solve_check).toMatchObject({ verdict: 'unsupported', compared_by: 'none' });
  });

  it('short-circuits solve (SolutionGenerateTask NOT called) when a free check already fails', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'qshort', knowledgeId: 'k1' });
    // overall=pass but grounding=fail → checksPass false → freeChecksPass false → no solve.
    const runTaskFn = dualTaskMock(
      verifyOutput({ overall: 'pass', groundingVerdict: 'fail' }),
      solverOutput('代词'),
      'tr_short',
    );

    const result = await runQuizVerify({ db: testDb(), questionId: 'qshort', runTaskFn });
    expect(result.status).toBe('needs_review');
    // The independent solver was never invoked (cost saved; solve only spends on all-else-pass).
    expect(runTaskFn.mock.calls.every((c) => c[0] !== 'SolutionGenerateTask')).toBe(true);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    // No solve_check block on the event when solve did not run.
    const evs = await verifyEventsFor('qshort');
    expect((evs[0].payload as Record<string, unknown>).solve_check).toBeUndefined();
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

    // YUK-538 / YUK-554 — two tier4 questions × (verify + solve) = 4 calls.
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    const qa = await testDb().select().from(question).where(eq(question.id, 'qa'));
    const qb = await testDb().select().from(question).where(eq(question.id, 'qb'));
    expect(qa[0].draft_status).toBe('active');
    expect(qb[0].draft_status).toBe('active');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('question', 'qa')).toBe(0);
    expect(await fsrsRowCount('question', 'qb')).toBe(0);
  });
});
