import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAttributionAndWriteJudgeEvent } from './failure-learning-attribution';

async function insertAttemptEvent(opts: { attemptId: string; questionId: string }) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.questionId,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'test',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(event).values({
    id: opts.attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

describe('runAttributionAndWriteJudgeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const validInput = {
    prompt_md: '"之"在主谓之间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'yuwen' }],
  };

  it('idempotent — calling twice on same attempt does not duplicate judge event', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    const attemptId = 'attempt_e_idem';
    await insertAttemptEvent({ attemptId, questionId: 'q_idem' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"first","confidence":0.5}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    // Second call must skip with a warn — judge already exists for this attempt.
    const fakeRunTask2 = vi.fn(async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"analysis_md":"second","confidence":0.6}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask2,
    });
    expect(warnSpy).toHaveBeenCalled();
    const rows = await db.select().from(event).where(eq(event.caused_by_event_id, attemptId));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { cause: { analysis_md: string } };
    expect(payload.cause.analysis_md).toBe('first');
    warnSpy.mockRestore();
  });

  it('round-4 fix #4: real attribution judge (no attribution_pending) IS idempotent — blocks second run', async () => {
    // Once a real attribution judge exists (attribution_pending absent/false),
    // a second call must skip and not invoke the LLM again.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    const attemptId = 'attempt_e_real';
    await insertAttemptEvent({ attemptId, questionId: 'q_real' });

    const fakeRunTask = async () => ({
      text: '{"primary_category":"reading","secondary_categories":[],"analysis_md":"real","confidence":0.75}',
    });
    // First call — writes real judge (no attribution_pending).
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });

    // Second call — real judge already exists, must skip.
    const secondSpy = vi.fn(async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"analysis_md":"should not write","confidence":0.5}',
    }));
    const res = await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: secondSpy,
    });

    // YUK-379: idempotency early-out returns the `skipped` discriminant.
    expect(res.outcome).toBe('skipped');
    expect(secondSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(rows).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
