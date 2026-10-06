import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import {
  ai_task_runs,
  assessment_submission,
  evaluation_effective_head,
  event,
  knowledge,
  learning_record,
  learning_session,
  material_fsrs_state,
  question,
  source_asset,
} from '@/db/schema';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';
import { listLearningRecords } from '@/kernel/records/queries';
import { Tutor } from '@/server/session';
import {
  seedFrozenCompositeSolveQuestion,
  seedFrozenSolveQuestion,
} from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { recordAssistanceExposure } from './assessment/assistance';
import { saveSubmission } from './assessment/submit';
import { planSolveHint, startSolveSession, submitSolveAttempt } from './solve-session';

const db = testDb();
async function seed() {
  const frozen = await seedFrozenSolveQuestion(db);
  const session = await startSolveSession({
    db,
    questionId: frozen.id,
    issuanceId: frozen.issuanceId,
  });
  const key = `solve_${session.sessionId}`;
  const submission = (answer = 'a+b') => ({
    assessment: {
      issuance_id: frozen.issuanceId,
      evaluation_group_id: key,
      idempotency_key: key,
      response_set: frozen.responseSet(answer),
    },
    student_text_steps: ['分解为 (a−b)(a+b)', '确认 a≠b 后约分'],
    student_final_answer_text: answer,
  });
  return { ...frozen, ...session, submission };
}
const hintRunner = () =>
  vi.fn(async () => ({
    text: JSON.stringify({
      kind: 'explain',
      text_md: '先检查分子能否因式分解，再检查约分条件。',
      suggested_next: 'continue',
    }),
  }));

beforeEach(resetDb);
describe('frozen solve session lifecycle', () => {
  it('starts with an immutable issuance, without generating or rewriting a solution', async () => {
    const frozen = await seedFrozenSolveQuestion(db);
    const result = await startSolveSession({
      db,
      questionId: frozen.id,
      issuanceId: frozen.issuanceId,
    });
    expect(await db.select().from(ai_task_runs)).toHaveLength(0);
    expect(await Tutor.getTutorQuestionId(db, result.sessionId)).toMatchObject({
      questionId: frozen.id,
      issuanceId: frozen.issuanceId,
      status: 'active',
    });
  });
  it('rejects a missing issuance instead of generating a current-row substitute', async () => {
    const frozen = await seedFrozenSolveQuestion(db);
    await expect(startSolveSession({ db, questionId: frozen.id })).rejects.toMatchObject({
      code: 'issuance_required',
    });
    expect(await db.select().from(ai_task_runs)).toHaveLength(0);
    expect(await db.select().from(learning_session)).toHaveLength(0);
  });
  it('rejects a missing question', async () => {
    await expect(
      startSolveSession({ db, questionId: 'missing', issuanceId: 'missing' }),
    ).rejects.toMatchObject({ code: 'question_not_found' });
  });
  it('hides intervention diagnostics from solve assistance', async () => {
    const frozen = await seedFrozenSolveQuestion(db);
    await db
      .update(question)
      .set({ source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE })
      .where(eq(question.id, frozen.id));
    await expect(
      startSolveSession({ db, questionId: frozen.id, issuanceId: frozen.issuanceId }),
    ).rejects.toMatchObject({ code: 'question_not_found' });
  });
  it('rejects a different question issuance before session creation', async () => {
    const a = await seedFrozenSolveQuestion(db);
    const b = await seedFrozenSolveQuestion(db);
    await expect(
      startSolveSession({ db, questionId: a.id, issuanceId: b.issuanceId }),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
  });
  it('uses frozen hint context after edits and persists help before returning', async () => {
    const s = await seed();
    const runTaskFn = hintRunner();
    await db
      .update(question)
      .set({ prompt_md: 'MUTATED PROMPT', reference_md: 'MUTATED REFERENCE' })
      .where(eq(question.id, s.id));
    const result = await planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn });
    expect(result.text_md).toContain('因式分解');
    expect(result.text_md).not.toContain('a+b');
    expect(JSON.stringify(runTaskFn.mock.calls)).not.toContain('MUTATED');
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
    ).toMatchObject([{ payload: { impact: 'unknown' } }]);
  });
  it('rejects a missing hint session without a model call', async () => {
    const runTaskFn = hintRunner();
    await expect(
      planSolveHint({ db, sessionId: 'missing', hintIndex: 0, runTaskFn }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
  it('rejects a hint for the wrong question', async () => {
    const s = await seed();
    const runTaskFn = hintRunner();
    await expect(
      planSolveHint({
        db,
        sessionId: s.sessionId,
        expectedQuestionId: 'other',
        hintIndex: 0,
        runTaskFn,
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
  it('refuses historical unbound hint sessions instead of reading today’s question', async () => {
    const f = await seedFrozenSolveQuestion(db);
    const s = await Tutor.startTutorSession(db, { questionId: f.id });
    const runTaskFn = hintRunner();
    await expect(
      planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn }),
    ).rejects.toMatchObject({ code: 'historical_unknown' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
  it('rejects hints after judgment', async () => {
    const s = await seed();
    const runTaskFn = hintRunner();
    await submitSolveAttempt({ db, sessionId: s.sessionId, submission: s.submission() });
    await expect(
      planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn }),
    ).rejects.toMatchObject({ code: 'session_not_active' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
  it('judges original native text, captures process separately and reveals the frozen solution', async () => {
    const s = await seed();
    const result = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: { ...s.submission(), student_final_answer_text: 'WRONG DISPLAY TEXT' },
    });
    expect(result).toMatchObject({ status: 'effective', judge: { coarse_outcome: 'correct' } });
    expect(result.revealed_solution_md).toContain('a≠b');
    expect(result.mistake_id).toBeUndefined();
    const [capture] = await db.select().from(event).where(eq(event.id, result.attempt_event_id));
    expect(capture).toMatchObject({
      action: 'experimental:assessment_attempt',
      outcome: null,
      payload: { reasoning_trace: '分解为 (a−b)(a+b)\n确认 a≠b 后约分' },
    });
    expect(capture.payload.response_md).toContain('WRONG DISPLAY TEXT');
    expect(await Tutor.getTutorQuestionId(db, s.sessionId)).toMatchObject({ status: 'judged' });
  });
  it('keeps client hint counts as capture while server help determines learning eligibility', async () => {
    const s = await seed();
    await recordAssistanceExposure(db, {
      issuanceId: s.issuanceId,
      questionId: s.id,
      kind: 'hint',
      impact: 'unknown',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    });
    const result = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: s.submission(),
      hintsUsed: 0,
      finalHintLevel: 0,
    });
    expect(result.judge.coarse_outcome).toBe('correct');
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    const [capture] = await db.select().from(event).where(eq(event.id, result.attempt_event_id));
    expect(capture.payload).toMatchObject({ hints_used: 0, final_hint_level: 0 });
  });
  it('omits absent process and hint capture fields', async () => {
    const s = await seed();
    const result = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: { assessment: s.submission().assessment },
    });
    const [capture] = await db.select().from(event).where(eq(event.id, result.attempt_event_id));
    expect(capture.payload).not.toHaveProperty('reasoning_trace');
    expect(capture.payload).not.toHaveProperty('hints_used');
    expect(capture.payload).not.toHaveProperty('final_hint_level');
  });
  it('enrolls an incorrect native answer once and binds its exact revision', async () => {
    const s = await seed();
    const result = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: s.submission('a-b'),
    });
    expect(result.judge.coarse_outcome).toBe('incorrect');
    expect(result.mistake_id).toBeTruthy();
    const [record] = await db.select().from(learning_record);
    expect(record).toMatchObject({
      id: result.mistake_id,
      origin_event_id: result.attempt_event_id,
      payload: { assessment: { revision_id: s.revisionId } },
    });
  });
  it.each([false, true])(
    'enrolls the accepted frozen KC scope after hot edits with archived=%s and remains visible through knowledge filtering',
    async (archived) => {
      const s = await seed();
      await db.insert(knowledge).values([
        {
          id: 'solve_frozen_kc',
          name: '因式分解与非零条件',
          domain: 'math',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'solve_live_kc',
          name: '另一知识点',
          domain: 'math',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      await db
        .update(question)
        .set({ knowledge_ids: ['solve_frozen_kc'] })
        .where(eq(question.id, s.id));
      const request = s.submission('a-b');
      const accepted = await saveSubmission(db, request.assessment);
      expect(accepted.status).toBe('saved');
      if (accepted.status !== 'saved') throw new Error('fixture submission was not accepted');
      if (archived)
        await db
          .update(knowledge)
          .set({ archived_at: new Date() })
          .where(eq(knowledge.id, 'solve_frozen_kc'));
      await db
        .update(question)
        .set({ knowledge_ids: ['solve_live_kc'], prompt_md: 'EDITED AFTER ACCEPTANCE' })
        .where(eq(question.id, s.id));
      const result = await submitSolveAttempt({ db, sessionId: s.sessionId, submission: request });
      expect(result.judge.coarse_outcome).toBe('incorrect');
      expect(result.status).toBe('effective');
      expect(await Tutor.getTutorQuestionId(db, s.sessionId)).toMatchObject({ status: 'judged' });
      expect(await db.select().from(evaluation_effective_head)).toMatchObject([
        {
          submission_id: accepted.submission.submission_id,
          effective_evaluation_id: result.assessment?.candidate_id,
          generation: 1,
        },
      ]);
      expect(result.mistake_id).toBeTruthy();
      const [record] = await db
        .select()
        .from(learning_record)
        .where(eq(learning_record.id, result.mistake_id ?? 'missing'));
      expect(record.knowledge_ids).toEqual(['solve_frozen_kc']);
      expect(
        await listLearningRecords(db, { kind: ['mistake'], knowledge_id: 'solve_frozen_kc' }),
      ).toMatchObject([{ id: result.mistake_id }]);
      expect(
        await listLearningRecords(db, { kind: ['mistake'], knowledge_id: 'solve_live_kc' }),
      ).toEqual([]);
      await submitSolveAttempt({ db, sessionId: s.sessionId, submission: request });
      expect(await db.select().from(learning_record)).toHaveLength(1);
      expect(await db.select().from(evaluation_effective_head)).toMatchObject([{ generation: 1 }]);
      for (const action of [
        'experimental:assessment_activation',
        'experimental:assessment_settlement',
      ]) {
        expect(
          await db
            .select()
            .from(event)
            .where(
              and(
                eq(event.action, action),
                eq(event.subject_id, request.assessment.evaluation_group_id),
              ),
            ),
        ).toHaveLength(1);
      }
    },
  );
  it('replays an already judged answer without a second FSRS occurrence', async () => {
    const s = await seed();
    const params = { db, sessionId: s.sessionId, submission: s.submission() };
    const first = await submitSolveAttempt(params);
    const second = await submitSolveAttempt(params);
    expect(second.attempt_event_id).toBe(first.attempt_event_id);
    expect(second.assessment?.effect).toBe('idempotent_replay');
    expect(await db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 1 } }]);
  });
  it('rejects changed accepted response bytes', async () => {
    const s = await seed();
    await submitSolveAttempt({ db, sessionId: s.sessionId, submission: s.submission() });
    await expect(
      submitSolveAttempt({ db, sessionId: s.sessionId, submission: s.submission('changed') }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('preserves an original handwritten attachment without scoring an empty text field as wrong', async () => {
    const s = await seed();
    const now = new Date();
    const sha = 'b'.repeat(64);
    await db.insert(source_asset).values({
      id: 'original-handwriting',
      kind: 'image',
      storage_key: 'test/original-handwriting',
      mime_type: 'image/png',
      byte_size: 120,
      sha256: sha,
      created_at: now,
    });
    const evidence = {
      evidence_id: 'handwriting',
      kind: 'image' as const,
      asset: { asset_id: 'original-handwriting', digest: `sha256:${sha}` },
      mime_type: 'image/png',
      bytes: 120,
      uploaded_at: now.toISOString(),
    };
    const result = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: {
        assessment: {
          ...s.submission('').assessment,
          group_evidence: [{ evidence, target: { scope: 'all_units' } }],
        },
      },
    });
    expect(result).toMatchObject({
      status: 'review_required',
      judge: { coarse_outcome: 'unsupported', score: null },
      revealed_solution_md: null,
    });
    expect(result.mistake_id).toBeUndefined();
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(await db.select().from(learning_record)).toHaveLength(0);
    expect(await Tutor.getTutorQuestionId(db, s.sessionId)).toMatchObject({ status: 'active' });
    expect(await db.select().from(assessment_submission)).toMatchObject([
      { group_evidence: [{ evidence, target: { scope: 'all_units' } }] },
    ]);
    const manual = await submitSolveAttempt({
      db,
      sessionId: s.sessionId,
      submission: {
        self_report: true,
        user_rating: 'hard',
        assessment: {
          ...s.submission('').assessment,
          group_evidence: [{ evidence, target: { scope: 'all_units' } }],
        },
      },
    });
    expect(manual.status).toBe('effective');
    expect(await db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 1 } }]);
    expect(await getQuestionTimeline(db, s.id)).toMatchObject([
      {
        outcome: 'unsupported',
        assessment: {
          original_evaluation_id: result.assessment?.candidate_id,
          effective_evaluation_id: manual.assessment?.candidate_id,
        },
      },
    ]);
  });
  it.each([
    { correct: 2, score: 0.5, mistake: true },
    { correct: 3, score: 0.75, mistake: false },
  ])(
    'preserves partial-credit mastery threshold at $score using four real scored units',
    async ({ correct, score, mistake }) => {
      const frozen = await seedFrozenCompositeSolveQuestion(db);
      const { sessionId } = await startSolveSession({
        db,
        questionId: frozen.id,
        issuanceId: frozen.issuanceId,
      });
      const key = `solve_${sessionId}`;
      const result = await submitSolveAttempt({
        db,
        sessionId,
        submission: {
          assessment: {
            issuance_id: frozen.issuanceId,
            evaluation_group_id: key,
            idempotency_key: key,
            response_set: frozen.responseSet(correct),
          },
        },
      });
      expect(result.judge).toMatchObject({ coarse_outcome: 'partial', score });
      expect(Boolean(result.mistake_id)).toBe(mistake);
      expect(await db.select().from(learning_record)).toHaveLength(mistake ? 1 : 0);
    },
  );
  it('rejects a submit for the wrong question', async () => {
    const s = await seed();
    await expect(
      submitSolveAttempt({
        db,
        sessionId: s.sessionId,
        submission: s.submission(),
        expectedQuestionId: 'other',
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
  });
  it('rejects changed group coordinates before creating a candidate', async () => {
    const s = await seed();
    const submission = s.submission();
    submission.assessment.evaluation_group_id = 'other_group';
    await expect(
      submitSolveAttempt({ db, sessionId: s.sessionId, submission }),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
  });
  it('rejects old flat-only submission on an unbound historical session', async () => {
    const f = await seedFrozenSolveQuestion(db);
    const s = await Tutor.startTutorSession(db, { questionId: f.id });
    await expect(
      submitSolveAttempt({
        db,
        sessionId: s.sessionId,
        submission: { student_final_answer_text: 'a+b' },
      }),
    ).rejects.toMatchObject({ code: 'historical_unknown' });
    expect(await db.select().from(learning_record)).toHaveLength(0);
  });
  it('rejects an empty request on a bound session without interpreting it as a wrong answer', async () => {
    const s = await seed();
    await expect(
      submitSolveAttempt({ db, sessionId: s.sessionId, submission: {} }),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
  });
});
