import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLearnerStateWatermarks } from '@/capabilities/copilot/server/learner-state';
import { evaluation_effective_head, event, material_fsrs_state, question } from '@/db/schema';
import {
  getCurrentFailureAttempts,
  getFailureAttempts,
} from '@/kernel/read-models/failure-attempts';
import { countQuestionAssociations } from '@/server/questions/write';
import { nativeAppealFixture } from '../../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as dueReport } from '../api/due';
import { GET as weeklyReport } from '../api/weekly';
import { createFailureLearning } from './failure-learning';
import { handleFailureLearningAttemptDelivery } from './failure-learning-subscription';
import { runVariantGen } from './failure-learning-variant';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const attribution = {
  text: JSON.stringify({
    primary_category: 'method',
    secondary_categories: [],
    analysis_md: '原答列出两个方程但消元步骤需要复核；按冻结的原题与提交判断。',
    confidence: 0.8,
  }),
};

describe('native failure learning', () => {
  it('activation delivers the original identity and attribution uses frozen content after edits', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db);
    await db
      .update(question)
      .set({
        prompt_md: 'CHANGED LIVE PROMPT',
        reference_md: 'CHANGED LIVE KEY',
        knowledge_ids: [],
      })
      .where(eq(question.id, f.questionId));
    const [activation] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_activation'),
          eq(event.subject_id, f.original.evaluation_group_id),
        ),
      );
    expect(activation).toBeDefined();
    const bossSend = vi.fn().mockResolvedValue('accepted');
    await expect(
      handleFailureLearningAttemptDelivery(
        db,
        {
          subscriberId: 'practice.failure-learning-attempt',
          subscriberVersion: 2,
          deliverySeq: '1',
          sourceEventId: activation.id,
        },
        { bossSend },
      ),
    ).resolves.toMatchObject({ status: 'succeeded', detail: { attempt_event_id: f.attemptId } });
    const runTaskFn = vi.fn(async () => attribution);
    const result = await createFailureLearning({ db, runTaskFn }).attribute({
      attemptEventId: f.attemptId,
    });
    expect(result.status).toBe('written');
    expect(runTaskFn).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(runTaskFn.mock.calls);
    expect(serialized).toContain('顺流18');
    expect(serialized).toContain('v+c=18');
    expect(serialized).toContain(f.knowledgeId);
    expect(serialized).not.toContain('CHANGED LIVE');
  });

  it('generates a variant from the native frozen failure after the editable question changes', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db);
    await createFailureLearning({ db, runTaskFn: async () => attribution }).attribute({
      attemptEventId: f.attemptId,
    });
    await db
      .update(question)
      .set({
        prompt_md: 'CHANGED LIVE PROMPT',
        reference_md: 'CHANGED LIVE KEY',
        knowledge_ids: [],
      })
      .where(eq(question.id, f.questionId));
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        prompt_md: '顺流20 km/h，逆流10 km/h，求静水船速并说明消元步骤。',
        reference_md: '联立 v+c=20 与 v-c=10，相加得 v=15 km/h。',
        difficulty: 3,
        reasoning: '保留相加消元，改变两方向速度。',
      }),
    }));
    expect((await runVariantGen({ db, attemptEventId: f.attemptId, runTaskFn })).status).toBe(
      'proposed',
    );
    const input = JSON.stringify(runTaskFn.mock.calls);
    expect(input).toContain('顺流18');
    expect(input).toContain(f.knowledgeId);
    expect(input).not.toContain('CHANGED LIVE');
  });

  it('reports native failure scope and preserves history after the effective verdict becomes pending', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db, { userRating: 'good' });
    await db.update(question).set({ knowledge_ids: [] }).where(eq(question.id, f.questionId));
    const failures = await getCurrentFailureAttempts(db);
    expect(failures).toHaveLength(1);
    expect(failures[0].referenced_knowledge_ids).toEqual([f.knowledgeId]);
    expect(await countQuestionAssociations(db, f.questionId)).toMatchObject({
      attempts: 1,
      mistakes: 1,
    });
    const weekly = await weeklyReport(new Request('http://local/api/review/weekly'));
    expect(await weekly.json()).toMatchObject({
      totals: { failures: 1, reviews: 1 },
      ratings: { good: 1, again: 0 },
      daily: expect.arrayContaining([
        expect.objectContaining({ correct: 0, incorrect: 1, partial: 0, ungraded: 0 }),
      ]),
      top_knowledge: [{ id: f.knowledgeId, failure_count: 1 }],
    });
    expect(await getCurrentFailureAttempts(db, { perQuestionLimit: 1 })).toHaveLength(1);
    expect(
      await getFailureAttempts(db, { questionIds: [f.questionId], perQuestionLimit: 4 }),
    ).toHaveLength(1);
    // The fixture's first settlement schedules a future KC review; never-reviewed
    // discovery must keep that exclusion even after editable KC tags were removed.
    const scheduled = await dueReport(new Request('http://local/api/review/due'));
    expect(await scheduled.json()).toEqual({ rows: [] });
    await db.delete(material_fsrs_state);
    expect(
      (await db.select().from(question).where(eq(question.id, f.questionId)))[0].draft_status,
    ).not.toBe('draft');
    const due = await dueReport(new Request('http://local/api/review/due'));
    expect(JSON.stringify(await due.json())).toContain(f.questionId);
    expect((await readLearnerStateWatermarks(db)).attempt_at).not.toBeNull();
    await db
      .update(evaluation_effective_head)
      .set({ effective_evaluation_id: null })
      .where(eq(evaluation_effective_head.evaluation_group_id, f.original.evaluation_group_id));
    expect(await getCurrentFailureAttempts(db)).toHaveLength(0);
    expect(await countQuestionAssociations(db, f.questionId)).toMatchObject({
      attempts: 1,
      mistakes: 0,
    });
    const after = await weeklyReport(new Request('http://local/api/review/weekly'));
    expect(await after.json()).toMatchObject({ totals: { failures: 0 }, top_knowledge: [] });
  });

  it('does not publish late attribution when the effective native verdict changes during model work', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db);
    const runTaskFn = vi.fn(async () => {
      await db
        .update(evaluation_effective_head)
        .set({ effective_evaluation_id: null })
        .where(eq(evaluation_effective_head.evaluation_group_id, f.original.evaluation_group_id));
      return attribution;
    });
    await expect(
      createFailureLearning({ db, runTaskFn }).attribute({ attemptEventId: f.attemptId }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: 'verdict_overturned',
      modelInvoked: true,
    });
    expect(
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, f.attemptId))),
    ).toHaveLength(0);
  });
});
