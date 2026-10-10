import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluation,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import * as domainEvents from '@/kernel/events';
import { nativeAppealFixture } from '../../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createNativeAppeal } from '../server/assessment/appeal';
import { handleRejudge } from './rejudge';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const reason = '请复核原式：两式相加消去水速，30/2=15 km/h；不能以改写后的题目替代。';
async function appeal(f: Awaited<ReturnType<typeof nativeAppealFixture>>, text = reason) {
  return {
    appeal_event_id: await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: text,
    }),
  };
}
async function head(groupId: string) {
  return (
    await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, groupId))
  )[0];
}
async function theta(kc: string) {
  return (
    await testDb()
      .select()
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kc)))
  )[0];
}
async function resolutions(appealId: string) {
  return testDb().select().from(event).where(eq(event.caused_by_event_id, appealId));
}

describe('native appeal worker', () => {
  it('replays a resolved appeal without evaluating again', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    await handleRejudge(testDb(), job);
    expect(await handleRejudge(testDb(), job)).toEqual({
      status: 'skipped',
      reason: 'already_resolved',
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
  });

  it('serializes concurrent delivery into one candidate, head, receipt, and learning occurrence', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    f.setPoints(1);
    await Promise.all([handleRejudge(testDb(), job), handleRejudge(testDb(), job)]);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await testDb().select().from(evaluation)).toHaveLength(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
    expect(await head(f.original.evaluation_group_id)).toMatchObject({ generation: 2 });
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, success_count: 1 });
  });

  it('replays later native occurrences in order when an earlier answer is corrected', async () => {
    const first = await nativeAppealFixture(testDb(), { now: new Date('2026-10-01T08:00:00Z') });
    const job = await appeal(first);
    const later = await nativeAppealFixture(testDb(), {
      points: 1,
      knowledgeId: first.knowledgeId,
      now: new Date('2026-10-02T08:00:00Z'),
    });
    expect(await theta(first.knowledgeId)).toMatchObject({
      evidence_count: 2,
      success_count: 1,
      fail_count: 1,
    });
    expect(await handleRejudge(testDb(), job)).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    expect(await theta(first.knowledgeId)).toMatchObject({
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date('2026-10-02T08:00:00Z'),
    });
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 2 } },
    ]);
    expect(await head(later.original.evaluation_group_id)).toMatchObject({
      effective_evaluation_id: later.original.evaluation_id,
      generation: 1,
    });
  });

  it('preserves untracked later theta movement and records an explicit replay requirement', async () => {
    const f = await nativeAppealFixture(testDb());
    await testDb()
      .update(mastery_state)
      .set({ theta_hat: 7, evidence_count: 20, last_outcome_at: new Date(Date.now() + 60_000) })
      .where(eq(mastery_state.subject_id, f.knowledgeId));
    const before = await theta(f.knowledgeId);
    f.setPoints(1);
    expect(await handleRejudge(testDb(), await appeal(f))).toMatchObject({
      status: 'reassessed',
      effect: 'failed_pending',
    });
    expect(await theta(f.knowledgeId)).toEqual(before);
    const receipts = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts.some((r) => r.payload.effect === 'replay_required')).toBe(true);
  });

  it('rolls back head, theta, and receipt atomically and retries with the sealed model result', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    f.setPoints(1);
    const beforeHead = await head(f.original.evaluation_group_id);
    const beforeTheta = await theta(f.knowledgeId);
    const beforeCards = await testDb().select().from(material_fsrs_state);
    const write = domainEvents.writeEvent;
    const spy = vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (...args) => {
      if (args[1].action === 'experimental:assessment_appeal_resolution')
        throw new Error('transient receipt failure');
      return write(...args);
    });
    await expect(handleRejudge(testDb(), job)).rejects.toThrow('transient receipt failure');
    expect(await head(f.original.evaluation_group_id)).toEqual(beforeHead);
    expect(await theta(f.knowledgeId)).toEqual(beforeTheta);
    expect(await testDb().select().from(material_fsrs_state)).toEqual(beforeCards);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(0);
    spy.mockRestore();
    expect(await handleRejudge(testDb(), job)).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
  });
});
