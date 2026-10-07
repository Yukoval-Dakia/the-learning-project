// Native preview persists an immutable original/candidate, never participation or learning.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import { POST } from './advice';
import { ReviewAdviceResponseSchema } from './review-planning-contracts';
import { createAttempt } from './submit';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const preview = (body: unknown) => POST(nativeHttpRequest(body));
const actions = (action: string) => testDb().select().from(event).where(eq(event.action, action));
async function noLearning() {
  expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
  expect(await testDb().select().from(mastery_state)).toHaveLength(0);
  expect(await actions('experimental:assessment_attempt')).toHaveLength(0);
  expect(await actions('experimental:assessment_activation')).toHaveLength(0);
}

describe('native assessment advice', () => {
  it.each([
    { answer: 'A', verdict: 'correct', rating: 'good' },
    { answer: 'B', verdict: 'incorrect', rating: 'again' },
    { answer: '', verdict: 'incorrect', rating: 'again' },
  ])(
    'previews the frozen $answer response without participation or learning',
    async ({ answer, verdict, rating }) => {
      const f = await nativeSoloHttpFixture(testDb());
      const response = await preview(f.body({ assessment: f.issued.assessment(answer) }));
      expect(response.status).toBe(200);
      const body = ReviewAdviceResponseSchema.parse(await response.json());
      expect(body).toMatchObject({
        question_id: f.id,
        automatic_commit: true,
        judge: { route: 'evaluate_submission', coarse_outcome: verdict, suggested_rating: rating },
        advice: { rating },
      });
      expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
      expect(await testDb().select().from(evaluation)).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
      await noLearning();
    },
  );

  it('requires the original issuance instead of recreating it from legacy flat text', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const response = await preview(f.body({ assessment: undefined, response_md: 'A' }));
    expect(response.status).toBe(400);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
    await noLearning();
  });

  it.each(['2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'])(
    'rejects diagnostic preview at due time %s without spending or writing a candidate',
    async (dueAt) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true });
      await testDb()
        .update(question)
        .set({
          source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          metadata: { intervention_diagnostic: { due_at: dueAt } },
        })
        .where(eq(question.id, f.id));
      expect((await preview(f.body())).status).toBe(409);
      expect(f.execute).not.toHaveBeenCalled();
      expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
      await noLearning();
    },
  );

  it.each([
    { cause: 'carelessness', rating: 'good' },
    { cause: 'conceptual_error', rating: 'again' },
    { cause: null, rating: 'hard' },
  ])(
    'keeps partial-credit $cause advice informational and reuses one model evaluation',
    async ({ cause, rating }) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true, points: 0.5 });
      if (cause) {
        await seedAttempt({
          id: `prior_${f.id}`,
          question_id: f.id,
          knowledge_ids: f.knowledgeIds,
          answer_md: '历史错误原答',
          outcome: 'failure',
          created_at: new Date(Date.now() - 60_000),
        });
        await seedUserCause({ attempt_event_id: `prior_${f.id}`, primary_category: cause });
      }
      const response = await preview(f.body());
      expect(response.status).toBe(200);
      const body = ReviewAdviceResponseSchema.parse(await response.json());
      expect(body).toMatchObject({
        automatic_commit: false,
        judge: { coarse_outcome: 'partial', suggested_rating: 'hard' },
        advice: { rating },
      });
      expect((await preview(f.body())).status).toBe(200);
      expect(f.execute).toHaveBeenCalledOnce();
      await noLearning();
      const committed = await createAttempt(
        nativeHttpRequest(
          f.body({ activation_intent: body.activation_intent, auto_rate: false, rating: 'hard' }),
        ),
      );
      expect(committed.status).toBe(200);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(await actions('experimental:assessment_settlement')).toMatchObject([
        { payload: { rating: 'hard', rating_source: 'user' } },
      ]);
    },
  );

  it('reads a user cause from a real native failed attempt for the next issued preview', async () => {
    const f = await nativeSoloHttpFixture(testDb(), { model: true, points: 0 });
    const failed = await createAttempt(nativeHttpRequest(f.body()));
    expect(failed.status).toBe(200);
    const original = await failed.json();
    await seedUserCause({
      attempt_event_id: original.review_event.id,
      primary_category: 'carelessness',
    });
    const cards = await testDb().select().from(material_fsrs_state);
    const theta = await testDb().select().from(mastery_state);
    const issued = await issueSoloFixture(testDb(), f.id, true);
    f.setOutcome(0.5);
    const response = await preview(
      f.body({ assessment: issued.assessment('保持水量相同，改变坡度。') }),
    );
    expect(response.status).toBe(200);
    expect(ReviewAdviceResponseSchema.parse(await response.json())).toMatchObject({
      judge: { coarse_outcome: 'partial' },
      advice: { rating: 'good' },
    });
    expect(await testDb().select().from(material_fsrs_state)).toEqual(cards);
    expect(await testDb().select().from(mastery_state)).toEqual(theta);
    expect(await actions('experimental:assessment_attempt')).toHaveLength(1);
  });

  it('keeps the preview tied to the issued question and accepted answer after current-row edits', async () => {
    const f = await nativeSoloHttpFixture(testDb(), { model: true });
    const response = await preview(f.body());
    expect(response.status).toBe(200);
    const first = ReviewAdviceResponseSchema.parse(await response.json());
    await testDb()
      .update(question)
      .set({
        prompt_md: '后来的题面',
        reference_md: '后来的答案',
        choices_md: ['后来选项'],
        knowledge_ids: [],
      })
      .where(eq(question.id, f.id));
    const second = await preview(f.body({ response_md: '观察文本不能重写原始ResponseSet' }));
    expect(ReviewAdviceResponseSchema.parse(await second.json())).toMatchObject({
      candidate_id: first.candidate_id,
      judge: first.judge,
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.execute.mock.calls[0][0])).not.toContain('后来');
    await noLearning();
    const conflict = await preview(f.body({ assessment: f.issued.assessment('不同原答') }));
    expect(conflict.status).toBe(409);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('holds an unjudgeable preview without activating or dropping the accepted original', async () => {
    const f = await nativeSoloHttpFixture(testDb(), { model: true });
    f.setOutcome('pending');
    const response = await preview(f.body());
    expect(response.status).toBe(200);
    expect(ReviewAdviceResponseSchema.parse(await response.json())).toMatchObject({
      automatic_commit: false,
      judge: { coarse_outcome: 'unsupported', suggested_rating: null },
      advice: { rating: null },
    });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    expect(await testDb().select().from(evaluation_effective_head)).toMatchObject([
      { effective_evaluation_id: null },
    ]);
    await noLearning();
  });
});
