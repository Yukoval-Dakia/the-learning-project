import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNativeJudgeSettled } from '@/capabilities/practice/grading/server/judge-run-observation';
import { nativeAppealFixture } from '../../../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { handleRejudge } from '../jobs/rejudge';
import { createNativeAppeal } from './appeal';
import { readAppealStatus } from './appeal-status';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('appeal status read model', () => {
  // @invariant grading: the learner-facing status reads the resolution receipt and the live head — a changed rejudge reports before/after verdicts and refresh settles on the activated candidate, not the appealed evaluation
  // @fails-if project after from the appealed evaluation instead of the resolution candidate or the head row; the changed status, after.effective_evaluation_id and settled effective/appeal-id assertions fail
  it('projects in_progress → changed and names the latest appeal on refresh', async () => {
    const f = await nativeAppealFixture(testDb());
    const { appeal_event_id } = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: '请重判',
    });
    const pending = await readAppealStatus(testDb(), appeal_event_id);
    expect(pending).toMatchObject({
      status: 'in_progress',
      disposition: null,
      after: null,
      before: { coarse_outcome: 'incorrect', score: 0 },
    });
    f.setPoints(1);
    const outcome = await handleRejudge(testDb(), { appeal_event_id });
    expect(outcome.status).toBe('reassessed');
    const done = await readAppealStatus(testDb(), appeal_event_id);
    expect(done).toMatchObject({
      status: 'changed',
      disposition: 'effective',
      before: { coarse_outcome: 'incorrect', score: 0 },
      after: { coarse_outcome: 'correct', score: 1 },
    });
    const newHead = done.after?.effective_evaluation_id;
    expect(newHead).toBeTruthy();
    expect(newHead).not.toBe(f.original.evaluation_id);
    const settled = await readNativeJudgeSettled(testDb(), f.original.submission_id);
    expect(settled).toMatchObject({ kind: 'terminal', latest_appeal_event_id: appeal_event_id });
    expect(
      settled?.kind === 'terminal' && settled.run.status === 'done'
        ? settled.run.result?.assessment?.effective_evaluation_id
        : null,
    ).toBe(newHead);
  });

  // @invariant concurrency: a second appeal for the same submission and the same reason must not re-run the model once a rejudge landed an effective result — even when the anchor moved to the new head
  // @fails-if scope completed-result reuse to identical appeal ids or to non-effective dispositions; the reused receipt, should_rejudge=false and execute-call-count assertions fail
  it('reports unchanged and reuses the completed appeal for the same submission and reason', async () => {
    const f = await nativeAppealFixture(testDb());
    const reason = 'same reason';
    const first = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: reason,
    });
    await handleRejudge(testDb(), { appeal_event_id: first.appeal_event_id });
    const done = await readAppealStatus(testDb(), first.appeal_event_id);
    expect(done).toMatchObject({ status: 'unchanged', disposition: 'effective' });
    const newHead = done.after?.effective_evaluation_id;
    expect(newHead).toBeTruthy();
    expect(newHead).not.toBe(f.original.evaluation_id);
    const calls = f.execute.mock.calls.length;
    // The anchor moved to the new head; the same submission + reason must reuse
    // the completed result instead of paying for another rejudge.
    const second = await createNativeAppeal(testDb(), {
      evaluation_id: newHead as string,
      reason_md: reason,
    });
    expect(second).toEqual({ appeal_event_id: first.appeal_event_id, should_rejudge: false });
    expect(f.execute.mock.calls.length).toBe(calls);
  });

  // @invariant concurrency: a review_required resolution is not a completed result — the same receipt stays a no-op while a fresh-key retry files a new appeal that pays for a real rejudge
  // @fails-if treat any resolution (or none) as completing the boundary; the should_rejudge flags, the reassessed outcome and the execute-call-count +1 assertion fail
  it('keeps an unjudgeable outcome retryable without counting it as completed', async () => {
    const f = await nativeAppealFixture(testDb());
    const reason = 'look again';
    const first = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: reason,
    });
    f.execute.mockImplementationOnce(async () => ({
      kind: 'pending',
      pending: { reason: 'insufficient_evidence', detail: 'fixture hold' },
      run_refs: [],
    }));
    await handleRejudge(testDb(), { appeal_event_id: first.appeal_event_id });
    const held = await readAppealStatus(testDb(), first.appeal_event_id);
    expect(held).toMatchObject({ status: 'unjudgeable', disposition: 'review_required' });
    expect(held.after?.effective_evaluation_id).toBe(f.original.evaluation_id);
    // Same receipt is a no-op; a fresh key files a new appeal and re-runs the model.
    const same = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: reason,
    });
    expect(same).toEqual({ appeal_event_id: first.appeal_event_id, should_rejudge: false });
    const retried = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: reason,
      idempotency_key: 'retry-1',
    });
    expect(retried).toMatchObject({ should_rejudge: true });
    expect(retried.appeal_event_id).not.toBe(first.appeal_event_id);
    const calls = f.execute.mock.calls.length;
    const outcome = await handleRejudge(testDb(), { appeal_event_id: retried.appeal_event_id });
    expect(outcome.status).toBe('reassessed');
    expect(f.execute.mock.calls.length).toBe(calls + 1);
  });

  // @invariant grading: failure modes never read as in_progress forever — a stale_head hold resolves failed, and a dead delivery without a resolution resolves failed instead of hanging the poll
  // @fails-if map non-effective dispositions to unjudgeable or ignore the delivery row; the failed status, stale_head disposition and dead-delivery assertions fail
  it('reports failed for a stale anchor and for a dead rejudge delivery', async () => {
    const f = await nativeAppealFixture(testDb());
    const a1 = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: 'first',
    });
    const a2 = await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: 'second',
    });
    f.setPoints(1);
    const moved = await handleRejudge(testDb(), { appeal_event_id: a2.appeal_event_id });
    expect(moved.status).toBe('reassessed');
    await handleRejudge(testDb(), { appeal_event_id: a1.appeal_event_id });
    const stale = await readAppealStatus(testDb(), a1.appeal_event_id);
    expect(stale).toMatchObject({ status: 'failed', disposition: 'stale_head', after: null });
    // A delivery that died before writing a resolution surfaces as failed, not stuck.
    // The plain db lane has no pg-boss install; the read model only needs the
    // four columns it selects, so a minimal namesake table exercises the query.
    const headId = moved.status === 'reassessed' ? moved.evaluation_id : f.original.evaluation_id;
    const dead = await createNativeAppeal(testDb(), {
      evaluation_id: headId,
      reason_md: 'dead job',
    });
    await testDb().execute(sql`create schema if not exists pgboss`);
    await testDb().execute(sql`
      create table if not exists pgboss.job
        (name text, state text, data jsonb, created_on timestamptz default now())
    `);
    await testDb().execute(sql`
      insert into pgboss.job (name, state, data)
      values ('rejudge', 'failed', jsonb_build_object('appeal_event_id', ${dead.appeal_event_id}::text))
    `);
    expect((await readAppealStatus(testDb(), dead.appeal_event_id)).status).toBe('failed');
  });

  // @invariant concurrency: concurrent identical appeal requests converge on a single deterministic receipt instead of racing two appeals for one judgment
  // @fails-if derive the appeal id without the input hash or drop the appeal lock; the identical appeal_event_id assertion fails or two event rows exist
  it('serializes a duplicated request onto one appeal receipt', async () => {
    const f = await nativeAppealFixture(testDb());
    const input = { evaluation_id: f.original.evaluation_id, reason_md: 'race' };
    const [x, y] = await Promise.all([
      createNativeAppeal(testDb(), input),
      createNativeAppeal(testDb(), input),
    ]);
    expect(x.appeal_event_id).toBe(y.appeal_event_id);
    await expect(readAppealStatus(testDb(), 'evt_native_appeal_nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});
