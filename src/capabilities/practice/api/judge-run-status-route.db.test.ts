import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import { event, job_events } from '@/db/schema';
import { dispatchFrozenJudge, resetJudgeControl } from '../../../../tests/dbos-judge/support';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import * as practice from '../public';
import { judgeDeliveryInput } from '../server/judge-engine-client';
import {
  disposeJudgeRun,
  judgeCoordinate,
  judgeRunEnvelope,
  lockJudgeRun,
  writeJudgeReceipt,
} from '../server/judge-operational';
import { judgeDispositionId } from '../server/judge-operational-state';
import {
  createJudgeRunStatusReader,
  readJudgeQuestionActivity,
  readJudgeRunPermanent,
} from '../server/judge-run-observation';
import { GET } from './judge-run-status-route';

beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb());
});
afterEach(() => vi.restoreAllMocks());
const request = new Request('http://localhost/api/jobs/judge_run/run/status');
// @invariant data: the status route reports 404 only when absence is verified; an unavailable observation backend yields 503 and never a false absence for a possibly-live paid run
// @fails-if map a backend_unavailable observation to 404/absent; the 503-then-404 sequence fails and a caller could treat a live run as nonexistent
it('route distinguishes verified absence from unavailable metadata; no false 404', async () => {
  const observe = vi.fn(async () => ({
    kind: 'unavailable' as const,
    reason: 'backend_unavailable' as const,
  }));
  const reader = createJudgeRunStatusReader({ observe, observeUnmapped: observe });
  vi.spyOn(practice, 'readJudgeRunStatus').mockImplementation(reader);
  expect((await GET(request, { id: 'unknown' })).status).toBe(503);
  observe.mockResolvedValueOnce({ kind: 'unavailable', reason: 'backend_unavailable' });
  const absent = createJudgeRunStatusReader({
    observe,
    observeUnmapped: async () => ({ kind: 'absent', deliveryId: 'none' }),
  });
  vi.mocked(practice.readJudgeRunStatus).mockImplementation(absent);
  expect((await GET(request, { id: 'unknown' })).status).toBe(404);
});
// @invariant data: a committed pending run stays reported as queued from the durable record when the engine observation is unavailable or identity-unverified
// @fails-if trust the failed or unverified engine lookup over the stored pending row and report absent/failed; the found/queued equality and the unmapped-throw guard fail
it('known pending remains queued when observation is unavailable or identity mismatched', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  const reader = createJudgeRunStatusReader({
    observe: async () => ({ kind: 'unavailable', reason: 'identity_unverified' }),
    observeUnmapped: async () => {
      throw new Error('unexpected unmapped');
    },
  });
  expect(await reader(testDb(), f.runId)).toEqual({
    kind: 'found',
    value: { run_id: f.runId, status: 'queued', result: null },
  });
});
// @invariant data: a terminal manual disposition permanently outranks a later engine SUCCESS and survives job_events pruning, and question activity reports the same manual truth
// @fails-if consult the engine observation over the stored disposition, or lose the disposition when notifications are pruned; the 'failed' status, observe-not-called and 'manual' activity assertions fail
it('terminal permanent manual survives retention, beats engine success and agrees with question activity', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  await disposeJudgeRun(testDb(), f.runId, {
    reason: 'provider_unknown',
    actorRef: 'test:operator',
    evidenceRefs: [f.input.reservation_id],
    evidenceDigest: canonicalHash('unknown-response'),
  });
  await testDb().delete(job_events);
  const observe = vi.fn(async () => ({
    kind: 'present' as const,
    state: 'SUCCESS' as const,
    input: f.input,
    deliveryId: f.input.delivery_id,
  }));
  const reader = createJudgeRunStatusReader({ observe, observeUnmapped: observe });
  expect(await reader(testDb(), f.runId)).toEqual({
    kind: 'found',
    value: { run_id: f.runId, status: 'failed', result: null },
  });
  expect(observe).not.toHaveBeenCalled();
  expect((await readJudgeQuestionActivity(testDb(), [f.id])).get(f.id)?.[0]?.kind).toBe('manual');
});
// @invariant concurrency: an uncommitted manual receipt is visible only inside its own transaction, and rollback restores the accepted pending row byte-identical
// @fails-if leak the uncommitted disposition to a separate connection, or let the rollback drop or mutate the pending row; the 'pending' reads and toEqual(before) assertions fail
it('caller Tx sees uncommitted manual; a separate observer sees pending; rollback preserves the accepted original', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  const before = (await testDb().select().from(event).where(eq(event.id, f.input.pending_id)))[0];
  const payload = JudgePendingAttemptPayload.parse(before?.payload);
  await expect(
    testDb().transaction(async (tx) => {
      await lockJudgeRun(tx, f.runId);
      await writeJudgeReceipt(tx, judgeDispositionId(f.runId), {
        ...judgeRunEnvelope(f.input.pending_id),
        action: 'experimental:judge_disposition',
        payload: {
          ...judgeCoordinate(f.input.pending_id, payload),
          version: 1,
          kind: 'manual',
          reason: 'explicit_disposal',
          actor_ref: 'test:tx',
          decided_at: new Date().toISOString(),
          observed_ownership: f.input.ownership,
          evidence_refs: [f.input.pending_id],
          evidence_digest: canonicalHash('tx-only'),
        },
      });
      expect((await readJudgeRunPermanent(tx, f.runId)).kind).toBe('manual');
      expect((await readJudgeQuestionActivity(tx, [f.id])).get(f.id)?.[0]?.kind).toBe('manual');
      // A separate pool connection cannot see the uncommitted receipt and never needs the run lock for reading.
      expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('pending');
      throw new Error('intentional caller rollback');
    }),
  ).rejects.toThrow('intentional caller rollback');
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('pending');
  expect((await testDb().select().from(event).where(eq(event.id, f.input.pending_id)))[0]).toEqual(
    before,
  );
});
// @invariant concurrency: the reader performs one bounded re-read of durable state after an engine observation, so a manual disposition committed mid-flight still wins
// @fails-if return the pre-commit engine SUCCESS without the durable re-read; the found/'failed' assertion fails and observe stays at exactly one call
it('one bounded re-read lets manual truth win an in-flight engine observation', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  const observe = vi.fn(async () => {
    await disposeJudgeRun(testDb(), f.runId, {
      reason: 'provider_unknown',
      actorRef: 'test:observer-race',
      evidenceRefs: [f.input.pending_id],
      evidenceDigest: canonicalHash('race'),
    });
    return {
      kind: 'present' as const,
      state: 'SUCCESS' as const,
      input: judgeDeliveryInput(f.delivery.reservation),
      deliveryId: f.input.delivery_id,
    };
  });
  expect(
    await createJudgeRunStatusReader({ observe, observeUnmapped: observe })(testDb(), f.runId),
  ).toMatchObject({ kind: 'found', value: { status: 'failed', result: null } });
  expect(observe).toHaveBeenCalledTimes(1);
});
