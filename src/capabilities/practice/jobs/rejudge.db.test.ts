// M2 (YUK-316, D15) — 申诉自动重判链 E2E：appeal API 写事件 → handler 重跑
// （mock judgeFn）→ 改判（新 judge + CorrectEvent supersede 直接生效，经
// effective-truth 断言）/ 维持（appeal_upheld 留痕）/ 幂等跳过。
// FSRS 刻意不在 handler 内重写（设计稿语义：评级是用户确认动作）——见 rejudge.ts 头注。

import { event, question } from '@/db/schema';
import type { JudgeAnswerResult } from '@/server/ai/judges/question-contract';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as appealPost } from '../api/appeal';
import { getEffectiveTruth } from '../server/effective-truth';
import { handleRejudge } from './rejudge';

function mockJudge(outcome: 'correct' | 'partial' | 'incorrect', feedback: string) {
  const base = {
    score_meaning: 'correctness' as const,
    confidence: 0.8,
    capability_ref: { id: 'semantic', version: '1.0.0' },
    feedback_md: feedback,
    evidence_json: {},
  };
  // JudgeResultV2 是按 coarse_outcome 判别的 union——逐分支构造字面量。
  const result =
    outcome === 'correct'
      ? { ...base, coarse_outcome: 'correct' as const, score: 0.9 }
      : outcome === 'partial'
        ? { ...base, coarse_outcome: 'partial' as const, score: 0.5 }
        : { ...base, coarse_outcome: 'incorrect' as const, score: 0 as const };
  return async (): Promise<JudgeAnswerResult> => ({ route: 'semantic', result });
}

async function seedAppealedJudge(): Promise<{
  questionId: string;
  attemptEventId: string;
  judgeEventId: string;
  appealEventId: string;
}> {
  const db = testDb();
  const now = new Date();
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: '翻译：吾妻之美我者，私我也。',
    reference_md: '我的妻子认为我美，是因为偏爱我。',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const attemptEventId = createId();
  await db.insert(event).values({
    id: attemptEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: { answer_md: '我妻子觉得我美，是偏爱我。', answer_image_refs: [] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const judgeEventId = createId();
  await db.insert(event).values({
    id: judgeEventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<seed>',
        confidence: 0.7,
      },
      coarse_outcome: 'partial',
      score: 0.5,
      judge_route: 'semantic',
      capability_ref: { id: 'semantic', version: '1.0.0' },
      profile_version: '1.0.0',
    },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const res = await appealPost(
    new Request('http://t/api/review/appeal', {
      method: 'POST',
      body: JSON.stringify({
        judge_event_id: judgeEventId,
        reason_md: '「觉得我美」已经含了意动义，判严了。',
      }),
    }),
  );
  expect(res.status).toBe(200);
  const { appeal_event_id } = (await res.json()) as { appeal_event_id: string };
  return { questionId, attemptEventId, judgeEventId, appealEventId: appeal_event_id };
}

describe('rejudge job (D15 申诉自动重判)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('改判：新 judge event + CorrectEvent(supersede) 直接生效（effective-truth 断言）', async () => {
    const db = testDb();
    const { judgeEventId, attemptEventId, appealEventId } = await seedAppealedJudge();

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', '你说得对——意动义已含其中，改判：对。') },
    );
    expect(outcome.status).toBe('overturned');
    if (outcome.status !== 'overturned') return;
    expect(outcome.prior_outcome).toBe('partial');
    expect(outcome.new_outcome).toBe('correct');

    // 新 judge event 挂在原作答事件上（newest-wins 锚点），caused_by 申诉。
    const [newJudge] = await db
      .select()
      .from(event)
      .where(eq(event.id, outcome.new_judge_event_id));
    expect(newJudge.action).toBe('judge');
    expect(newJudge.subject_id).toBe(attemptEventId);
    expect(newJudge.caused_by_event_id).toBe(appealEventId);
    expect((newJudge.payload as { coarse_outcome: string }).coarse_outcome).toBe('correct');

    // D15 直接生效：原 judge event 被 supersede（无 proposal 介入）。
    const truth = await getEffectiveTruth(db, judgeEventId);
    expect(truth.terminal_state).toBe('active');
    expect(truth.effective_event_id).toBe(outcome.new_judge_event_id);
    expect(truth.chain[0].state).toBe('superseded');
  });

  it('维持原判：appeal_upheld 留痕（带复核理由），原判定不动', async () => {
    const db = testDb();
    const { judgeEventId, appealEventId } = await seedAppealedJudge();

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('partial', '意动义在译文里确实没有落地，维持部分对。') },
    );
    expect(outcome.status).toBe('upheld');

    const [upheld] = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:appeal_upheld'), eq(event.subject_id, judgeEventId)),
      );
    expect(upheld).toBeTruthy();
    expect((upheld.payload as { rejudge_outcome: string }).rejudge_outcome).toBe('partial');

    const truth = await getEffectiveTruth(db, judgeEventId);
    expect(truth.terminal_state).toBe('active');
    expect(truth.effective_event_id).toBe(judgeEventId);
  });

  it('幂等：同一申诉第二次执行跳过（already_resolved）', async () => {
    const db = testDb();
    const { appealEventId } = await seedAppealedJudge();

    const first = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', '改判。') },
    );
    expect(first.status).toBe('overturned');

    const second = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('incorrect', '不该被调用') },
    );
    expect(second).toEqual({ status: 'skipped', reason: 'already_resolved' });
  });
});
