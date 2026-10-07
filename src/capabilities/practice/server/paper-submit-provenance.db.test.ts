// Native paper execution provenance: original model claims and actual run refs
// remain distinct from deterministic evaluations and from a planned run identity.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answer,
  artifact,
  assessment_submission,
  evaluation,
  event,
  learning_session,
  question,
} from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import {
  publishPaperModelFixture,
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import * as evaluationService from './judge/evaluate-submission';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(),
}));

async function seedQuestion(
  id: string,
  overrides: Partial<typeof question.$inferInsert>,
): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: '参考答案',
    knowledge_ids: ['kc_prov'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

async function seedPaper(id: string, questionIds: string[], primaryKc: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: 'provenance paper',
    knowledge_ids: [primaryKc],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: [primaryKc],
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            primary_knowledge_id: primaryKc,
            secondary_knowledge_ids: [],
            selection_reason: 'test',
            review_profile_snapshot: {},
          })),
        },
      ],
    } as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function readCandidate(evaluationId: string | undefined) {
  if (!evaluationId) throw new Error('expected a native candidate');
  const [candidate] = await testDb()
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, evaluationId));
  return candidate;
}

afterEach(() => vi.restoreAllMocks());
describe('paper native execution provenance', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(runTask).mockReset();
  });

  it('a failed model execution keeps its claim and pending receipt, without fabricating an actual run or retrying payment', async () => {
    const db = testDb();
    await seedQuestion('pq_sem_fail', {
      judge_kind_override: 'semantic',
      prompt_md: '结合两句原文，解释人物态度的转变，并指出相反解释的问题。',
      reference_md: '必须说明由犹疑到承担责任，并结合原句举证；只复述情节不能替代态度分析。',
    });
    await publishPaperModelFixture(db, 'pq_sem_fail');
    await seedPaper('paper_sem_fail', ['pq_sem_fail'], 'kc_prov');
    const execute = vi.fn(async () => {
      throw new Error('provider unavailable before a result');
    });
    vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
      createRecordedModelExecutor(db, execute),
    );
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_sem_fail');
    const input = {
      sessionId,
      paperArtifactId: 'paper_sem_fail',
      questionId: 'pq_sem_fail',
      answerMd: '他先担心承担责任，后来主动接受；“我来”与前文的迟疑对照，不能只解释成情节推进。',
    };
    const result = await submitPaperSlot(input, db);
    expect(result).toMatchObject({ coarseOutcome: 'unsupported', status: 'review_required' });
    const candidate = await readCandidate(result.evaluationId);
    expect(candidate.run_refs).toEqual([]);
    expect(candidate.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'infra_failure', retryable: false },
    });
    const claims = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_model_claim'));
    expect(claims).toHaveLength(1);
    expect(claims[0].payload).toMatchObject({
      reserved_cost_usd_micros: 1000,
      planned_task_run_id: expect.any(String),
    });
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_model_result')),
    ).toHaveLength(1);
    expect(await submitPaperSlot(input, db)).toMatchObject({
      evaluationId: result.evaluationId,
      status: 'review_required',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('capture commits before slow model work, survives terminal transition, and retries never pay twice', async () => {
    const db = testDb();
    await seedQuestion('pq_terminal', {
      judge_kind_override: 'semantic',
      prompt_md: '结合两句原文解释人物态度变化，并比较相反解释。',
      reference_md: '由犹疑到承担责任，结合原句举证，不能仅复述情节。',
    });
    await publishPaperModelFixture(db, 'pq_terminal');
    await seedPaper('paper_terminal', ['pq_terminal'], 'kc_prov');
    let start = () => {},
      release = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      start();
      await gate;
      throw new Error('offline provider stopped after capture');
    });
    vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
      createRecordedModelExecutor(db, execute),
    );
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_terminal');
    const input = {
      sessionId,
      paperArtifactId: 'paper_terminal',
      questionId: 'pq_terminal',
      answerMd: '先犹疑后承担责任，“我来”与迟疑对照，排除只复述情节的解释。',
    };
    const submit = submitPaperSlot(input, db);
    try {
      await started;
      expect(await db.select().from(assessment_submission)).toHaveLength(1);
      expect(await db.select().from(answer)).toHaveLength(1);
      expect(
        await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
      ).toHaveLength(1);
      await db
        .update(learning_session)
        .set({ status: 'completed' })
        .where(eq(learning_session.id, sessionId));
    } finally {
      release();
    }
    const result = await submit;
    expect(result.status).toBe('review_required');
    const original = await db.select().from(assessment_submission);
    const capture = await db.select().from(answer);
    expect(await submitPaperSlot(input, db)).toMatchObject({ answerId: result.answerId });
    expect(await db.select().from(assessment_submission)).toEqual(original);
    expect(await db.select().from(answer)).toEqual(capture);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a published exact answer uses no model and creates no model claim', async () => {
    const db = testDb();
    await seedQuestion('pq_tf', {
      kind: 'true_false',
      reference_md: 'true',
      judge_kind_override: 'exact',
    });
    await seedPaper('paper_tf', ['pq_tf'], 'kc_prov');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_tf');
    const result = await submitPaperSlot(
      { sessionId, paperArtifactId: 'paper_tf', questionId: 'pq_tf', answerMd: 'true' },
      db,
    );
    expect(result.coarseOutcome).toBe('correct');
    expect((await readCandidate(result.evaluationId)).run_refs).toEqual([]);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_model_claim')),
    ).toEqual([]);
    expect(runTask).not.toHaveBeenCalled();
  });

  it.each(['30 m/s', '108 km/h'])(
    'frozen unit conversion evaluates %s deterministically with no model attempt',
    async (answerMd) => {
      const db = testDb();
      await seedQuestion('pq_unit_accel', {
        judge_kind_override: 'unit_dimension',
        kind: 'calculation',
        prompt_md: '速度是多少？',
        reference_md: '30 m/s',
        metadata: { reference_value: 30, reference_unit: 'm/s' },
      });
      await seedPaper('paper_unit_accel', ['pq_unit_accel'], 'kc_prov');
      const { sessionId } = await startFrozenPaperFixture(db, 'paper_unit_accel');
      // Current metadata edits cannot change the original published numeric key.
      await db
        .update(question)
        .set({ metadata: { reference_value: 100, reference_unit: 'kg' } })
        .where(eq(question.id, 'pq_unit_accel'));
      const result = await submitPaperSlot(
        { sessionId, paperArtifactId: 'paper_unit_accel', questionId: 'pq_unit_accel', answerMd },
        db,
      );
      expect(result.coarseOutcome).toBe('correct');
      expect((await readCandidate(result.evaluationId)).run_refs).toEqual([]);
      expect(
        await db
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:assessment_model_claim')),
      ).toEqual([]);
      expect(runTask).not.toHaveBeenCalled();
    },
  );
});
