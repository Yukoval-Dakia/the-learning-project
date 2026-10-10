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
import {
  event,
  knowledge,
  material_fsrs_state,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { solverOutput } from '../../../../tests/helpers/solve-check-fixtures';
import { teachingQualityOutput } from '../../../../tests/helpers/teaching-quality-fixtures';
import { runQuizVerify } from './quiz_verify';

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

// YUK-538 / YUK-554 (review SIMP-2/R3) — SINGLE per-kind mock dispatcher. Solve-check wiring
// makes tier3/4 verify fire additional tasks (SolutionGenerateTask, and SemanticJudgeTask on
// the open path), so tests that control the solve outcome pass per-kind overrides; every
// unmatched kind gets `defaultText` (for the plain single-output tests, the solver leg then
// parses the verify JSON → empty final_answer → solve 'unsupported' → non-blocking).
// solverOutput / semanticJudgeOutput come from tests/helpers/solve-check-fixtures (R1/R2 —
// shared with verify-framework.test.ts).
// YUK-578 — teaching_quality (TeachingQualityTask) is a further tier3/4 probe gated on the SAME
// freeChecksPass. Plain tests leave it unmatched → it too gets `defaultText` (the verify JSON),
// which lacks the clarity/unique_answer axes → teaching 'unsupported' → non-blocking. Tests that
// control the审题闸 outcome pass a { TeachingQualityTask: teachingQualityOutput(...) } override.
function taskMock(
  defaultText: string,
  overrides: Partial<Record<string, string>> = {},
  taskRunId = 'tr_v',
) {
  return vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => ({
    text: overrides[kind] ?? defaultText,
    task_run_id: taskRunId,
  }));
}

// Back-compat single-output wrapper (pre-review call sites keep their minimal shape).
function runTaskMock(output: string, taskRunId = 'tr_v') {
  return taskMock(output, {}, taskRunId);
}

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain: 'yuwen',
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
  /** YUK-1037 — multi-binding override; defaults to [knowledgeId]. */
  knowledgeIds?: string[];
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
  supplyTrace?: unknown;
  difficultyEvidence?: unknown;
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
    knowledge_ids: opts.knowledgeIds ?? [opts.knowledgeId],
    difficulty: 3,
    source: opts.source ?? 'quiz_gen',
    source_ref: opts.knowledgeId,
    draft_status: 'draft',
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr_gen' } as never,
    metadata: {
      quiz_gen: opts.meta ?? BASE_META,
      ...(opts.supplyTrace ? { supply_trace: opts.supplyTrace } : {}),
      ...(opts.difficultyEvidence ? { difficulty_evidence: opts.difficultyEvidence } : {}),
    } as never,
    created_at: now,
    updated_at: now,
  });
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

describe('runQuizVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects a stale verdict when KC attribution changes mid-verify, then retries current version', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    await seedKnowledge('k2');
    await seedDraftQuestion({ id: 'q_verify_version_race', knowledgeId: 'k1' });
    let mutated = false;
    const staleRun = vi.fn(async (kind: string) => {
      if (kind === 'QuizVerifyTask' && !mutated) {
        mutated = true;
        await db
          .update(question)
          .set({ knowledge_ids: ['k1', 'k2'], version: 1 })
          .where(eq(question.id, 'q_verify_version_race'));
      }
      return { text: verifyOutput({ overall: 'pass' }), task_run_id: 'tr-stale-verify' };
    });

    await expect(
      runQuizVerify({ db, questionId: 'q_verify_version_race', runTaskFn: staleRun }),
    ).rejects.toThrow('changed during verification');

    const [afterStale] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q_verify_version_race'));
    expect(afterStale).toMatchObject({
      draft_status: 'draft',
      knowledge_ids: ['k1', 'k2'],
      version: 1,
    });
    const staleEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_verify'));
    expect(staleEvents.map((candidate) => candidate.outcome)).toEqual(['error']);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('knowledge', 'k2')).toBe(0);

    const retry = await runQuizVerify({
      db,
      questionId: 'q_verify_version_race',
      runTaskFn: runTaskMock(verifyOutput({ overall: 'pass' }), 'tr-current-verify'),
    });
    expect(retry.status).toBe('verified');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('knowledge', 'k2')).toBe(1);
    const outcomes = (
      await db.select().from(event).where(eq(event.action, 'experimental:quiz_verify'))
    ).map((candidate) => candidate.outcome);
    expect(outcomes.sort()).toEqual(['error', 'success']);
  });

  // YUK-1095 — 反向回归：generation 与当前值一致的 success（真正的并发副本）仍
  // 必须跳过挂起写，并发保护不被收窄误伤。
  it('YUK-1095: 当前 generation 的 success 仍跳过挂起（并发保护不误伤）', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q_curr_succ', knowledgeId: 'k1' });
    await db.insert(question_group_lifecycle).values({
      group_id: 'q_curr_succ',
      current_revision_id: null,
      availability: 'container_only',
      scoring_admission_state: 'withheld',
      scoring_admission_withheld_reason: 'unverified_rules',
      scoring_admission_generation: 5,
      claim_policy: 'one_time',
      suspended: false,
      withdrawn: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const concurrentSuccess = vi.fn(async (kind: string) => {
      if (kind === 'QuizVerifyTask') {
        await db.insert(event).values({
          id: 'evt_curr_succ',
          actor_kind: 'agent',
          actor_ref: 'quiz_verify',
          action: 'experimental:quiz_verify',
          subject_kind: 'question',
          subject_id: 'q_curr_succ',
          outcome: 'success',
          payload: { question_id: 'q_curr_succ', promoted: true, admission_generation: 5 },
          created_at: new Date(),
        });
      }
      return {
        text: verifyOutput({ overall: 'fail', groundingVerdict: 'fail' }),
        task_run_id: 'tr_curr_succ',
      };
    });

    const result = await runQuizVerify({
      db,
      questionId: 'q_curr_succ',
      runTaskFn: concurrentSuccess,
    });

    expect(result.status).toBe('failed');
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, 'q_curr_succ'));
    expect(lifecycle.suspended).toBe(false);
    expect(lifecycle.scoring_admission_generation).toBe(5);
  });

  it('idempotency: a second run skips (no duplicate event, no re-run of the LLM)', async () => {
    await seedKnowledge('k1');
    await seedDraftQuestion({ id: 'q5', knowledgeId: 'k1' });
    const runTaskFn = runTaskMock(verifyOutput({ overall: 'pass' }));

    const first = await runQuizVerify({ db: testDb(), questionId: 'q5', runTaskFn });
    expect(first.status).toBe('verified');

    const second = await runQuizVerify({ db: testDb(), questionId: 'q5', runTaskFn });
    expect(second.status).toBe('skipped:already_verified');
    // LLM only ran on the first pass (verify + solve + teaching = 3); the second run skips.
    expect(runTaskFn).toHaveBeenCalledTimes(3);
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
    // B-obs-1 (review) — every call explicitly mocked: 1st run rejects at QuizVerifyTask
    // (never reaches solve); 2nd run fires verify (2nd mock) + solve (EXPLICIT empty
    // final_answer → the documented 'solver returned an empty final_answer' unsupported
    // path → non-blocking) + teaching (YUK-578 — explicit pass → non-blocking).
    // OCR (PR #716 round-2) — solve_check and teaching_quality now fire CONCURRENTLY via
    // Promise.all, so which of the two lands as "the 3rd call" vs "the 4th call" is no
    // longer a production-code guarantee. Dispatch the 2nd invocation's mock BY KIND (not
    // by raw call-sequence position) so the test doesn't depend on that ordering; only the
    // very first call (call count 1, across BOTH invocations) is order-guaranteed to be the
    // rejected QuizVerifyTask attempt, since nothing else runs before verify succeeds.
    let callCount = 0;
    const runTaskFn = vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => {
      callCount += 1;
      if (callCount === 1) throw new Error('transient boom');
      if (kind === 'QuizVerifyTask') {
        return { text: verifyOutput({ overall: 'pass' }), task_run_id: 'tr_retry' };
      }
      if (kind === 'SolutionGenerateTask') {
        return { text: solverOutput(''), task_run_id: 'tr_retry_solve' };
      }
      if (kind === 'TeachingQualityTask') {
        return { text: teachingQualityOutput({}), task_run_id: 'tr_retry_tq' };
      }
      throw new Error(`unexpected task kind in retry test: ${kind}`);
    });

    await expect(runQuizVerify({ db: testDb(), questionId: 'q5b', runTaskFn })).rejects.toThrow(
      /transient boom/,
    );

    const second = await runQuizVerify({ db: testDb(), questionId: 'q5b', runTaskFn });
    expect(second.status).toBe('verified');
    // 1st run = 1 call (rejected verify); 2nd run = verify + solve + teaching. Total = 4.
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    expect(runTaskFn.mock.calls[0][0]).toBe('QuizVerifyTask');
    expect(runTaskFn.mock.calls[1][0]).toBe('QuizVerifyTask');
    // solve_check + teaching_quality race concurrently — assert the SET of kinds fired at
    // calls 2/3, not their relative position.
    const concurrentKinds = runTaskFn.mock.calls.slice(2).map((c) => c[0]);
    expect(new Set(concurrentKinds)).toEqual(
      new Set(['SolutionGenerateTask', 'TeachingQualityTask']),
    );

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
    // QoL——首次调用在 SDK 层即抛（taskResult 为 null）：raw_output_head 留 null，
    // 与「SDK 成功但 parse 抛」（q_syserr，raw head 有值）区开。
    expect(errorEv?.payload?.raw_output_head).toBeNull();
    // the terminal success event carries the model verdict, NOT 'error', and (promote)
    // carries NO failure_class.
    const successEv = evs.find((e) => e.outcome === 'success');
    expect(successEv?.payload?.overall).toBe('pass');
    expect(successEv?.payload?.failure_class).toBeUndefined();
    // B-obs-1 — the explicit empty-answer solve leg lands as a recorded (non-blocking)
    // unsupported verdict on the success event.
    expect(successEv?.payload?.solve_check).toMatchObject({
      verdict: 'unsupported',
      compared_by: 'none',
    });
  });
});
