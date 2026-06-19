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
  runObjectiveStructuralRejectFilter,
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
  // YUK-350 objective structural reject filter — let a test seed choice / true_false
  // drafts (with explicit reference_md + choices_md) so the deterministic filter can be
  // exercised. Defaults keep the existing short_answer fixture byte-identical.
  kind?: string;
  referenceMd?: string;
  choicesMd?: string[] | null;
  judgeKindOverride?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: opts.kind ?? 'short_answer',
    prompt_md: opts.promptMd ?? '用你自己的话解释「之」作主谓间助词的作用。',
    reference_md: opts.referenceMd ?? '「之」用在主谓之间，取消句子独立性。',
    rubric_json: { required_points: ['用在主谓之间', '取消句子独立性'] } as never,
    choices_md: opts.choicesMd ?? null,
    judge_kind_override: opts.judgeKindOverride ?? 'semantic',
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

// YUK-350 — deterministic OBJECTIVE STRUCTURAL REJECT FILTER (pure, no LLM, no DB).
// This is the pure-function half: assert the filter is a meaningful structural check
// (reference-resolves-to-a-valid-unique-choice, NOT reference-vs-reference) and that it
// can ONLY emit a reject signal — never a promote/pass.
describe('runObjectiveStructuralRejectFilter (pure, deterministic)', () => {
  it('choice: a reference that resolves to exactly one in-range choice is well-formed (fall through)', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'B',
      choices_md: ['甲', '乙', '丙'],
    });
    expect(r.malformed).toBe(false);
    // The filter has NO "promote" verb in its result shape — it can ONLY reject or
    // fall through. There is no field that grants promotion.
    expect(Object.keys(r)).toEqual(['malformed']);
  });

  it('choice: a reference resolving to NO valid choice is malformed (reject)', () => {
    // 'Z' is out of range for a 3-option question → resolves to nothing.
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'Z',
      choices_md: ['甲', '乙', '丙'],
    });
    expect(r.malformed).toBe(true);
    if (r.malformed) expect(r.reason).toBeTruthy();
  });

  it('choice: a reference resolving to MORE THAN ONE choice is malformed (not unique)', () => {
    // "AB" resolves to two indices — not a single-answer well-formed choice item.
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'AB',
      choices_md: ['甲', '乙', '丙'],
    });
    expect(r.malformed).toBe(true);
  });

  it('choice: fewer than 2 choices is malformed', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'A',
      choices_md: ['只有一个选项'],
    });
    expect(r.malformed).toBe(true);
  });

  it('choice: duplicate choices (after normalize-dedup) is malformed', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'A',
      choices_md: ['甲', '甲 ', '乙'],
    });
    expect(r.malformed).toBe(true);
  });

  it('choice: missing choices_md is malformed', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: 'A',
      choices_md: null,
    });
    expect(r.malformed).toBe(true);
  });

  it('MEANINGFUL not tautological: a reference equal to a choice TEXT (not its letter) resolves to a unique index', () => {
    // The check resolves reference TEXT against the choices and asserts uniqueness —
    // it is NOT comparing reference to itself. A reference carrying the option text
    // resolves to exactly that option's index → well-formed.
    const r = runObjectiveStructuralRejectFilter({
      kind: 'choice',
      reference_md: '乙',
      choices_md: ['甲', '乙', '丙'],
    });
    expect(r.malformed).toBe(false);
  });

  // YUK-350 (Bugbot Medium fix) — true_false is routed + graded IDENTICALLY to choice
  // (judge-routing.ts:43 + route-resolve.ts:145 both map choice||true_false -> exact, and
  // the exact judge grades via resolveChoiceIndices against choices_md). The QuizGen prompt
  // (task-prompts.ts: "choice / true_false: ... 给 3–4 个选项，reference_md 第一行必须是正确选项原文")
  // produces true_false drafts carrying choices_md + reference_md = the correct OPTION TEXT.
  // So when choices are present, validate true_false EXACTLY like choice (reference must
  // resolve via resolveChoiceIndices to a single in-range choice). The prior boolean-token
  // whitelist (TRUE_TOKENS/FALSE_TOKENS) was the WRONG assumption and false-rejected these.
  it('true_false WITH choices: reference = a valid OPTION TEXT resolves to one choice (fall through, NOT rejected)', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'true_false',
      reference_md: '正确',
      choices_md: ['正确', '错误'],
    });
    // This is the Bugbot regression lock at the pure-filter layer: an option-text
    // reference must NOT be falsely rejected.
    expect(r.malformed).toBe(false);
    expect(Object.keys(r)).toEqual(['malformed']);
  });

  it('true_false WITH choices: reference letter resolves to one choice (fall through)', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'true_false',
      reference_md: 'A',
      choices_md: ['正确', '错误'],
    });
    expect(r.malformed).toBe(false);
  });

  it('true_false WITH choices: reference that resolves to NO valid choice is malformed (reject)', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'true_false',
      reference_md: 'Z',
      choices_md: ['正确', '错误'],
    });
    expect(r.malformed).toBe(true);
    if (r.malformed) expect(r.reason).toBeTruthy();
  });

  it('true_false WITHOUT choices (bare-boolean shape): falls through (NEVER rejected, defers to the LLM)', () => {
    // The sourced/practice 判断题 shape is kind='true_false' + a bare boolean reference and
    // NO choices_md. Falling through is always safe (the reject-filter is an optimization,
    // not a correctness gate); the LLM verify still runs. Even a non-boolean reference falls
    // through here — we no longer guess at a boolean-token whitelist.
    for (const ref of ['正确', '错', 'true', '这不是一个判断答案']) {
      const r = runObjectiveStructuralRejectFilter({
        kind: 'true_false',
        reference_md: ref,
        choices_md: null,
      });
      expect(r.malformed, `bare-boolean true_false ref ${ref} must not be rejected`).toBe(false);
    }
  });

  it('true_false with a SINGLE choice (<2): falls through (treated as the bare-boolean case)', () => {
    const r = runObjectiveStructuralRejectFilter({
      kind: 'true_false',
      reference_md: '正确',
      choices_md: ['正确'],
    });
    expect(r.malformed).toBe(false);
  });

  it('non-objective kinds never enter the filter (always falls through)', () => {
    for (const kind of ['short_answer', 'essay', 'translation', 'reading', 'derivation']) {
      const r = runObjectiveStructuralRejectFilter({
        kind,
        reference_md: 'anything',
        choices_md: null,
      });
      expect(r.malformed, `kind ${kind} must not be rejected by the filter`).toBe(false);
    }
  });
});

// YUK-350 — the DB-level wiring of the objective structural reject filter into
// runQuizVerify: a MALFORMED objective draft must reject (needs_review) WITHOUT burning
// the LLM (short-circuit), while a STRUCTURALLY VALID objective draft must fall through
// to the unchanged LLM verify path (the filter grants NOTHING).
describe('runQuizVerify — objective structural reject filter (YUK-350)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // (a) malformed choice — reference resolves to no valid choice.
  it('malformed choice (reference resolves to no choice): needs_review, structure_completeness fail, NOT promoted, LLM NOT called', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_bad',
      knowledgeId: 'k1',
      kind: 'choice',
      promptMd: '下列哪一项正确？',
      referenceMd: 'Z', // out of range for a 3-option question
      choicesMd: ['甲', '乙', '丙'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_should_not_run');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_choice_bad', runTaskFn });

    // Rejected, not promoted.
    expect(result.status).toBe('needs_review');
    expect(result.overall).toBe('needs_review');
    // LLM-saving short-circuit: the runTaskFn (the expensive LLM verify) NEVER ran.
    expect(runTaskFn).not.toHaveBeenCalled();

    const rows = await testDb().select().from(question).where(eq(question.id, 'q_choice_bad'));
    expect(rows[0].draft_status).toBe('draft'); // NOT active
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0); // NO FSRS enroll
    expect(await fsrsRowCount('question', 'q_choice_bad')).toBe(0);

    // A verify event was written with a structure_completeness=fail axis + overall
    // needs_review (NOT pass) + validation_failure class.
    const evs = await verifyEventsFor('q_choice_bad');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('partial'); // needs_review → partial (never success)
    expect(evs[0].payload?.overall).toBe('needs_review');
    expect(evs[0].payload?.failure_class).toBe('validation_failure');
    expect(evs[0].payload?.promoted).toBe(false);
    const axes = (evs[0].payload?.axes ?? []) as { axis_name: string; verdict: string }[];
    const structAxis = axes.find((a) => a.axis_name === 'structure_completeness');
    expect(structAxis).toBeDefined();
    expect(structAxis?.verdict).toBe('fail');
  });

  // (b) <2 choices / duplicate choices — same reject, LLM not called.
  it('malformed choice (<2 choices): needs_review, LLM NOT called, not promoted', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_one',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
      choicesMd: ['只有一个选项'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_choice_one', runTaskFn });
    expect(result.status).toBe('needs_review');
    expect(runTaskFn).not.toHaveBeenCalled();
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_choice_one'));
    expect(rows[0].draft_status).toBe('draft');
  });

  it('malformed choice (duplicate choices): needs_review, LLM NOT called, not promoted', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_dup',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
      choicesMd: ['甲', '甲', '乙'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_choice_dup', runTaskFn });
    expect(result.status).toBe('needs_review');
    expect(runTaskFn).not.toHaveBeenCalled();
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_choice_dup'));
    expect(rows[0].draft_status).toBe('draft');
  });

  // (c) structurally VALID choice → falls through to the LLM (filter grants nothing).
  it('structurally valid choice: falls through to the LLM (runTaskFn IS called); filter promotes nothing on its own', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_ok',
      knowledgeId: 'k1',
      kind: 'choice',
      promptMd: '「之」在「臣之壮也」中的用法是？',
      referenceMd: 'B',
      choicesMd: ['代词', '主谓之间取消独立性', '动词'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_ok');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_choice_ok', runTaskFn });

    // The LLM verify path ran unchanged — the structural filter granted NOTHING; the
    // LLM's own verdict drove the promotion.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');
    expect(result.status).toBe('verified');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_choice_ok'));
    expect(rows[0].draft_status).toBe('active');
  });

  it('structurally valid choice whose LLM verdict FAILS: stays draft (filter granted nothing, LLM gate decided)', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_ok_llmfail',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'A',
      choicesMd: ['代词', '助词'],
      judgeKindOverride: 'exact',
    });
    // Structurally valid, but the LLM says fail → must NOT promote. Proves the filter
    // did not auto-promote a structurally-valid draft.
    const runTaskFn = runTaskMock(
      verifyOutput({ overall: 'fail', groundingVerdict: 'fail' }),
      'tr_ok_fail',
    );

    const result = await runQuizVerify({
      db: testDb(),
      questionId: 'q_choice_ok_llmfail',
      runTaskFn,
    });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    const rows = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, 'q_choice_ok_llmfail'));
    expect(rows[0].draft_status).toBe('draft');
  });

  // (d) true_false: choice-shaped (carries choices_md) vs bare-boolean (no choices_md).
  // YUK-350 Bugbot Medium fix — true_false is routed + graded identically to choice, and
  // the QuizGen prompt emits true_false drafts with choices_md + reference_md = the correct
  // OPTION TEXT. Validate like choice WHEN choices are present; fall through when not.
  //
  // (a) THE BUGBOT REGRESSION LOCK: a true_false draft carrying choices_md whose reference_md
  //     is a valid OPTION TEXT must NOT be falsely rejected — it must fall through to the LLM
  //     (runTaskFn IS called). Before the fix the boolean-token whitelist rejected this and the
  //     verify-event idempotency guard made it terminal (stuck in needs_review forever).
  it('Bugbot regression: true_false with choices_md + reference = OPTION TEXT is NOT falsely rejected (falls through to the LLM)', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_tf_optiontext',
      knowledgeId: 'k1',
      kind: 'true_false',
      promptMd: '「之」可作主谓之间的结构助词。',
      referenceMd: '正确', // the correct OPTION TEXT, exactly as the QuizGen prompt produces it
      choicesMd: ['正确', '错误'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_tf_optiontext');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_tf_optiontext', runTaskFn });
    // The filter granted nothing; it fell through to the LLM verify path.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('verified');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_tf_optiontext'));
    // Promotion came from the LLM gate, NOT the filter.
    expect(rows[0].draft_status).toBe('active');
  });

  // (b) a true_false draft carrying choices_md whose reference resolves to NO valid choice
  //     is structurally malformed → rejected (needs_review), LLM NOT called.
  it('malformed true_false (choices present, reference resolves to no choice): needs_review, LLM NOT called, not promoted', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_tf_bad',
      knowledgeId: 'k1',
      kind: 'true_false',
      promptMd: '「之」总是代词。',
      referenceMd: 'Z', // out of range for a 2-option item → resolves to nothing
      choicesMd: ['正确', '错误'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_tf_bad', runTaskFn });
    expect(result.status).toBe('needs_review');
    expect(runTaskFn).not.toHaveBeenCalled();
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_tf_bad'));
    expect(rows[0].draft_status).toBe('draft');
    const evs = await verifyEventsFor('q_tf_bad');
    const axes = (evs[0].payload?.axes ?? []) as { axis_name: string; verdict: string }[];
    expect(axes.find((a) => a.axis_name === 'structure_completeness')?.verdict).toBe('fail');
  });

  // (c) a true_false draft with NO choices_md (bare-boolean shape) must NOT be rejected —
  //     it falls through to the LLM verify (we dropped the TRUE_TOKENS/FALSE_TOKENS whitelist).
  it('bare-boolean true_false (no choices_md): NOT rejected, falls through to the LLM', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_tf_bareboolean',
      knowledgeId: 'k1',
      kind: 'true_false',
      promptMd: '「之」可作主谓之间的结构助词。',
      referenceMd: '正确', // bare boolean, no choices_md attached
      choicesMd: null,
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_tf_bare');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_tf_bareboolean', runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('verified');
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_tf_bareboolean'));
    expect(rows[0].draft_status).toBe('active');
  });

  // (e) prose / translation never enters the filter — LLM called as today.
  it('translation draft: never enters the filter, LLM called as today', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_translation',
      knowledgeId: 'k1',
      kind: 'translation',
      promptMd: '翻译：臣之壮也，犹不如人。',
      referenceMd: '我壮年的时候，尚且不如别人。',
      choicesMd: null,
      judgeKindOverride: 'semantic',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_trans');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_translation', runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('verified');
  });

  it('short_answer draft: never enters the filter, LLM called as today', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q_prose', knowledgeId: 'k1' }); // default short_answer
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }), 'tr_prose');

    const result = await runQuizVerify({ db: testDb(), questionId: 'q_prose', runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('verified');
  });

  // (f) idempotency: a structural reject is terminal — a second run skips, no re-reject,
  // no regression to the promote/FSRS path.
  it('idempotency: a structural reject is terminal (second run skips, LLM never called, no FSRS)', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({
      id: 'q_choice_idem',
      knowledgeId: 'k1',
      kind: 'choice',
      referenceMd: 'Z',
      choicesMd: ['甲', '乙', '丙'],
      judgeKindOverride: 'exact',
    });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const first = await runQuizVerify({ db: testDb(), questionId: 'q_choice_idem', runTaskFn });
    expect(first.status).toBe('needs_review');

    const second = await runQuizVerify({ db: testDb(), questionId: 'q_choice_idem', runTaskFn });
    expect(second.status).toBe('skipped:already_verified');

    // LLM never ran (short-circuited both attempts; second skipped on idempotency).
    expect(runTaskFn).not.toHaveBeenCalled();
    // exactly one verify event, no FSRS rows, still draft.
    expect(await countVerifyEvents('q_choice_idem')).toBe(1);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    const rows = await testDb().select().from(question).where(eq(question.id, 'q_choice_idem'));
    expect(rows[0].draft_status).toBe('draft');
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
