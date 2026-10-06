import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
import { evaluation_effective_head, misconception } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { AttemptTimeline } from '@/ui/components/AttemptTimeline';
import { issueSoloFixture } from '../../../tests/fixtures/assessment-solo';
import { nativeAppealFixture } from '../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getQuestionTimeline } from './question-activity';

const T0 = new Date('2026-10-06T01:00:00.000Z');
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function judge(
  id: string,
  attemptId: string,
  subjectId = attemptId,
  causedBy = attemptId,
  primary = 'misc_native_primary',
  at = T0,
) {
  await writeEvent(testDb(), {
    id,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: subjectId,
    caused_by_event_id: causedBy,
    outcome: 'success',
    created_at: at,
    payload: {
      cause: {
        primary_category: primary,
        secondary_categories: ['misc_native_secondary', 'misc_missing', 'concept'],
        analysis_md: '原答未区分水速与船速，推导中多次使用同方向速度；须按原始方程复核。',
        confidence: 0.87,
      },
      referenced_knowledge_ids: [],
      coarse_outcome: 'correct',
      score: 1,
    },
  });
}
async function seedLabels() {
  await testDb()
    .insert(misconception)
    .values(
      [
        { id: 'misc_native_primary', title: '混淆静水速度与水流速度' },
        { id: 'misc_native_secondary', title: '忽略方向约定' },
      ].map((item): typeof misconception.$inferInsert => ({
        ...item,
        weight: 1,
        status: 'active',
        source: 'soft',
        seen: 2,
        evidence: [],
        created_by: { by: 'system' },
        proposed_by_ai: true,
        created_at: T0,
        updated_at: T0,
      })),
    );
}

describe('native timeline attribution (YUK-1047)', () => {
  it.each(['subject', 'caused_by'])(
    'resolves %s attribution anchors and labels without changing native grades',
    async (anchor) => {
      const f = await nativeAppealFixture(testDb(), { model: false });
      await seedLabels();
      await judge(
        'native_judge',
        f.attemptId,
        anchor === 'subject' ? f.attemptId : 'historic_subject',
        anchor === 'subject' ? 'appeal_anchor' : f.attemptId,
      );
      const [entry] = await getQuestionTimeline(testDb(), f.questionId);
      expect(entry).toMatchObject({
        kind: 'attempt',
        outcome: 'failure',
        cause: {
          primary: 'misc_native_primary',
          primary_label: '混淆静水速度与水流速度',
          secondary: ['misc_native_secondary', 'misc_missing', 'concept'],
          secondary_labels: { misc_native_secondary: '忽略方向约定' },
        },
        judge: { original_event_id: 'native_judge', effective_event_id: 'native_judge' },
        assessment: { effective_evaluation_id: f.original.evaluation_id },
      });
      await testDb()
        .update(evaluation_effective_head)
        .set({ effective_evaluation_id: null })
        .where(eq(evaluation_effective_head.evaluation_group_id, f.original.evaluation_group_id));
      expect((await getQuestionTimeline(testDb(), f.questionId))[0]).toMatchObject({
        outcome: 'pending',
        cause: { primary: 'misc_native_primary' },
      });
    },
  );

  it('uses supersede/retract truth while preserving original attribution identity', async () => {
    const f = await nativeAppealFixture(testDb(), { model: false });
    await judge('native_old', f.attemptId);
    await judge(
      'native_new',
      f.attemptId,
      f.attemptId,
      'appeal_anchor',
      'method',
      new Date(T0.getTime() + 1000),
    );
    await writeEvent(testDb(), {
      id: 'native_supersede',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'native_old',
      outcome: 'success',
      created_at: new Date(T0.getTime() + 2000),
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: 'native_new',
        reason_md: '复核后改归因',
        affected_refs: [{ kind: 'question', id: f.questionId }],
      },
    });
    expect((await getQuestionTimeline(testDb(), f.questionId))[0]).toMatchObject({
      outcome: 'failure',
      cause: { primary: 'method' },
      judge: { original_event_id: 'native_old', effective_event_id: 'native_new' },
    });
    await writeEvent(testDb(), {
      id: 'native_retract',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'native_new',
      outcome: 'success',
      created_at: new Date(T0.getTime() + 3000),
      payload: {
        correction_kind: 'retract',
        reason_md: '撤回不充分归因',
        affected_refs: [{ kind: 'question', id: f.questionId }],
      },
    });
    expect((await getQuestionTimeline(testDb(), f.questionId))[0]).toMatchObject({
      outcome: 'failure',
      cause: null,
      judge: { original_event_id: 'native_old', effective_event_id: null },
    });
  });

  it('carries repeated native misconception identity into the existing timeline warning', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db, { model: false });
    const issued = await issueSoloFixture(db, f.questionId);
    const second = await commitFormalAttempt(
      db,
      'solo_submit',
      f.questionId,
      issued.assessment('错误'),
    );
    await seedLabels();
    await judge('repeat_first', f.attemptId);
    await judge('repeat_second', second.attempt_id);
    const timeline = await getQuestionTimeline(db, f.questionId);
    const attempts = timeline.flatMap((entry) =>
      entry.kind === 'attempt'
        ? [{ ...entry, created_at_sec: entry.created_at.getTime() / 1000 }]
        : [],
    );
    expect(attempts).toHaveLength(2);
    const html = renderToString(
      createElement(AttemptTimeline, { events: attempts, now_sec: T0.getTime() / 1000 }),
    );
    expect(html).toContain('混淆静水速度与水流速度');
    expect(html.match(/data-repeated-cause="true"/g)).toHaveLength(2);
  });
});
