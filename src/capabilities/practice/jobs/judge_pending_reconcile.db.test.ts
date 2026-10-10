import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import { event, job_events } from '@/db/schema';
import { dispatchFrozenJudge, resetJudgeControl } from '../../../../tests/dbos-judge/support';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { judgeDeliveryInput } from '../server/judge-engine-client';
import {
  acceptJudgeDelivery,
  authorizeJudgeSend,
  disposeJudgeRun,
  lockJudgeRun,
  reserveJudgeDelivery,
} from '../server/judge-operational';
import { recordJudgePendingAttempt } from '../server/judge-run-dispatch';
import { readJudgeRunPermanent } from '../server/judge-run-observation';
import type { JudgePendingReconcileDeps } from './judge_pending_reconcile';
import {
  RECONCILE_STALL_MS,
  RECOVERY_MAX_AGE_MS,
  reconcileStalledJudgeAttempts,
} from './judge_pending_reconcile';

beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb());
});
function deps(): JudgePendingReconcileDeps {
  return {
    checkRateLimit: vi.fn(() => 7),
    refundRateLimit: vi.fn(),
    boss: {
      send: vi.fn(async (_name, _data, options) => options?.id ?? null),
      getJobById: vi.fn(async () => null),
    },
    observe: vi.fn<NonNullable<JudgePendingReconcileDeps['observe']>>(async (reservation) => ({
      kind: 'absent',
      deliveryId: reservation.delivery_id,
    })),
  };
}
const stalled = () => new Date(Date.now() - RECONCILE_STALL_MS - 60_000);
it('repairs lost initial ack by exact lookup without refund, new identity or notification authority', async () => {
  const d = deps();
  d.boss?.send && vi.mocked(d.boss.send).mockRejectedValueOnce(new Error('ack lost after enqueue'));
  const f = await dispatchFrozenJudge(testDb(), d, stalled());
  const observe = vi.fn<NonNullable<JudgePendingReconcileDeps['observe']>>(async (r) => ({
    kind: 'present',
    state: 'PENDING',
    input: judgeDeliveryInput(r),
    deliveryId: r.delivery_id,
  }));
  await testDb().delete(job_events);
  const report = await reconcileStalledJudgeAttempts(testDb(), { deps: { ...d, observe } });
  expect(report).toMatchObject({ reenqueued: 0, skippedLive: 1 });
  expect(d.refundRateLimit).not.toHaveBeenCalled();
  expect(d.boss?.send).toHaveBeenCalledTimes(1);
  const state = await readJudgeRunPermanent(testDb(), f.runId);
  expect(state.kind).toBe('pending');
  if (state.kind === 'pending') expect(state.delivery?.kind).toBe('accepted');
});
it('two sweepers resend the same uncertain slot and cannot allocate competing recovery identities', async () => {
  const d = deps();
  d.boss?.send && vi.mocked(d.boss.send).mockRejectedValueOnce(new Error('send outcome unknown'));
  const f = await dispatchFrozenJudge(testDb(), d, stalled());
  await Promise.all([
    reconcileStalledJudgeAttempts(testDb(), {
      deps: d,
      tick: { backend: 'pg-boss', id: 'concurrent-a' },
    }),
    reconcileStalledJudgeAttempts(testDb(), {
      deps: d,
      tick: { backend: 'pg-boss', id: 'concurrent-b' },
    }),
  ]);
  const rows = await testDb()
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:judge_delivery_reserved'));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload.delivery_id).toBe(f.input.delivery_id);
});
it('counts permanent accepted slots through notification pruning; two recoveries exhaust, a live final delivery may finish', async () => {
  const d = deps(),
    f = await dispatchFrozenJudge(testDb(), d, stalled());
  for (const slot of [1, 2])
    await testDb().transaction(async (tx) => {
      await lockJudgeRun(tx, f.runId);
      const [row] = await tx.select().from(event).where(eq(event.id, f.input.pending_id));
      const reservation = await reserveJudgeDelivery(
        tx,
        f.input.pending_id,
        JudgePendingAttemptPayload.parse(row?.payload),
        f.input.ownership,
        slot,
        new Date(),
      );
      const send = await authorizeJudgeSend(tx, reservation, new Date());
      await acceptJudgeDelivery(tx, reservation, send, 'enqueue_ack');
    });
  await testDb().delete(job_events);
  const live: NonNullable<JudgePendingReconcileDeps['observe']> = async (r) => ({
    kind: 'present',
    state: 'PENDING',
    deliveryId: r.delivery_id,
    input: judgeDeliveryInput(r),
  });
  expect(
    await reconcileStalledJudgeAttempts(testDb(), { deps: { ...d, observe: live } }),
  ).toMatchObject({ reenqueued: 0, skippedLive: 1 });
  const finished: NonNullable<JudgePendingReconcileDeps['observe']> = async (r) => ({
    kind: 'present',
    state: 'SUCCESS',
    deliveryId: r.delivery_id,
    input: judgeDeliveryInput(r),
  });
  expect(
    await reconcileStalledJudgeAttempts(testDb(), { deps: { ...d, observe: finished } }),
  ).toMatchObject({ reenqueued: 0, skippedExhausted: 1 });
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
});
it('forbids fresh authorization at the seventh day and distinguishes missing accepted engine evidence from absence', async () => {
  const d = deps(),
    at = new Date(Date.now() - RECOVERY_MAX_AGE_MS),
    f = await dispatchFrozenJudge(testDb(), d, at);
  expect(
    await reconcileStalledJudgeAttempts(testDb(), {
      deps: d,
      now: new Date(at.getTime() + RECOVERY_MAX_AGE_MS),
    }),
  ).toMatchObject({ reenqueued: 0, skippedTerminal: 1 });
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
  expect(d.boss?.send).toHaveBeenCalledTimes(1);
});
it('advances a permanent keyset cursor beyond 200 malformed or live originals', async () => {
  const d = deps();
  for (let i = 0; i < 205; i++)
    await testDb().execute(sql`insert into event(id,actor_kind,actor_ref,action,subject_kind,subject_id,payload,outcome,created_at,ingest_at,affected_scopes)
 values(${`malformed-${i.toString().padStart(3, '0')}`},'system','test','experimental:judge_pending_attempt','question','legacy',${JSON.stringify({ invalid: 'old incomplete payload', nested: { answers: ['retain '.repeat(80)] } })}::jsonb,null,${stalled().toISOString()}::timestamptz,clock_timestamp(),'{}')`);
  const f = await dispatchFrozenJudge(testDb(), d, stalled());
  await disposeJudgeRun(testDb(), f.runId, {
    reason: 'explicit_disposal',
    actorRef: 'test:manual-after-prefix',
    evidenceRefs: [f.input.pending_id],
    evidenceDigest: '0'.repeat(64),
  });
  await testDb().delete(job_events);
  d.boss?.send && vi.mocked(d.boss.send).mockClear();
  const first = await reconcileStalledJudgeAttempts(testDb(), {
    deps: d,
    tick: { backend: 'pg-boss', id: 'page-a' },
  });
  const second = await reconcileStalledJudgeAttempts(testDb(), {
    deps: d,
    tick: { backend: 'pg-boss', id: 'page-b' },
  });
  expect(first.scanned).toBe(200);
  expect(second.scanned).toBeGreaterThan(0);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
  expect((await testDb().select().from(job_events)).map((m) => m.event_type)).toEqual([
    'judge_run.failed',
  ]);
  expect(d.boss?.send).not.toHaveBeenCalled();
  expect(d.observe).not.toHaveBeenCalled();
  expect(
    await reconcileStalledJudgeAttempts(testDb(), {
      deps: d,
      tick: { backend: 'pg-boss', id: 'page-c' },
    }),
  ).toMatchObject({ scanned: 0 });
});
it('disposes unfinished legacy submit without invoking scorer and retains disposition after pruning', async () => {
  const id = 'legacy-long-answer',
    at = stalled();
  await recordJudgePendingAttempt(testDb(), {
    runId: id,
    sessionId: null,
    questionId: 'old-question',
    knowledgeIds: ['old-kc'],
    submit: {
      body: { response_md: '文言文原始答案。'.repeat(180) },
      question_id: 'old-question',
      subject_profile: { subject: 'wenyan' },
      submitted_at: at.toISOString(),
    },
    submittedAt: at,
  });
  const d = deps();
  expect(await reconcileStalledJudgeAttempts(testDb(), { deps: d })).toMatchObject({
    reenqueued: 0,
    skippedTerminal: 1,
  });
  await testDb().delete(job_events);
  const state = await readJudgeRunPermanent(testDb(), id);
  expect(state.kind).toBe('manual');
  if (state.kind === 'manual') expect(state.disposition.reason).toBe('historical_unknown');
  expect(d.boss?.send).not.toHaveBeenCalled();
  expect(await reconcileStalledJudgeAttempts(testDb(), { deps: d })).toMatchObject({ scanned: 0 });
});

it.each(['send_unknown', 'reserved_unsent', 'accepted_success'] as const)(
  'uses the locked fresh clock for %s at <7d, exact7d and >7d, independently of old selection time',
  async (kind) => {
    for (const offset of [-1, 0, 1]) {
      await resetDb();
      await resetJudgeControl(testDb());
      const d = deps(),
        submittedAt = new Date(Date.now() - RECOVERY_MAX_AGE_MS),
        boundary = submittedAt.getTime() + RECOVERY_MAX_AGE_MS,
        authorizationAt = new Date(boundary + offset);
      if (kind === 'send_unknown')
        d.boss?.send &&
          vi.mocked(d.boss.send).mockRejectedValueOnce(new Error('controlled unknown enqueue'));
      const f = await dispatchFrozenJudge(testDb(), d, submittedAt);
      if (kind === 'reserved_unsent')
        await testDb().transaction(async (tx) => {
          await lockJudgeRun(tx, f.runId);
          const [pending] = await tx.select().from(event).where(eq(event.id, f.input.pending_id));
          await reserveJudgeDelivery(
            tx,
            f.input.pending_id,
            JudgePendingAttemptPayload.parse(pending?.payload),
            f.input.ownership,
            1,
            new Date(boundary - 60_000),
          );
        });
      const before = await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_send'));
      const clock = vi.fn(() => authorizationAt);
      const report = await reconcileStalledJudgeAttempts(testDb(), {
        now: new Date(boundary - 3600_000),
        deps: {
          ...d,
          authorizationClock: clock,
          observe:
            kind === 'accepted_success'
              ? async (r) => ({
                  kind: 'present',
                  state: 'SUCCESS',
                  deliveryId: r.delivery_id,
                  input: judgeDeliveryInput(r),
                })
              : d.observe,
        },
      });
      expect(clock).toHaveBeenCalledTimes(1);
      const after = await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_send'));
      expect(after).toHaveLength(before.length + (offset < 0 ? 1 : 0));
      expect(report).toMatchObject(
        offset < 0 ? { reenqueued: 1 } : { reenqueued: 0, skippedExhausted: 1 },
      );
      if (offset < 0) {
        const send = after.find((r) => !before.some((b) => b.id === r.id));
        expect(send?.payload.gate_checked_at).toBe(authorizationAt.toISOString());
        expect(send?.created_at).toEqual(authorizationAt);
        const current = await readJudgeRunPermanent(testDb(), f.runId);
        if (current.kind !== 'pending' || !current.delivery)
          throw new Error('Expected authorized pending');
        expect(current.delivery.reservation.slot).toBe(kind === 'send_unknown' ? 0 : 1);
      } else {
        const current = await readJudgeRunPermanent(testDb(), f.runId);
        expect(current.kind).toBe('manual');
        if (current.kind === 'manual')
          expect(current.disposition.reason).toBe('recovery_exhausted');
      }
      expect(
        await testDb()
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:assessment_model_claim')),
      ).toHaveLength(0);
      expect(d.boss?.send).toHaveBeenCalledTimes(offset < 0 ? 2 : 1);
    }
  },
);

it('samples every authorization after a mid-sweep boundary crossing instead of freezing the sweep clock', async () => {
  const submittedAt = new Date(Date.now() - RECOVERY_MAX_AGE_MS),
    boundary = submittedAt.getTime() + RECOVERY_MAX_AGE_MS,
    d = deps();
  d.boss?.send && vi.mocked(d.boss.send).mockRejectedValue(new Error('controlled unsent gap'));
  const a = await dispatchFrozenJudge(testDb(), d, submittedAt),
    b = await dispatchFrozenJudge(testDb(), d, submittedAt);
  d.boss?.send &&
    vi.mocked(d.boss.send).mockImplementation(async (_name, _data, options) => options?.id ?? null);
  let authorizationAt = new Date(boundary - 1),
    observed = 0;
  const clock = vi.fn(() => authorizationAt);
  const before = await testDb()
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:judge_delivery_send'));
  const report = await reconcileStalledJudgeAttempts(testDb(), {
    now: new Date(boundary - 3600_000),
    deps: {
      ...d,
      authorizationClock: clock,
      observe: async (r) => {
        if (++observed === 2) authorizationAt = new Date(boundary);
        return { kind: 'absent', deliveryId: r.delivery_id };
      },
    },
  });
  expect(clock).toHaveBeenCalledTimes(2);
  expect(report).toMatchObject({ scanned: 2, reenqueued: 1, skippedExhausted: 1 });
  const after = await testDb()
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:judge_delivery_send'));
  expect(after).toHaveLength(before.length + 1);
  expect(after.find((r) => !before.some((s) => s.id === r.id))?.payload.gate_checked_at).toBe(
    new Date(boundary - 1).toISOString(),
  );
  expect(
    [
      (await readJudgeRunPermanent(testDb(), a.runId)).kind,
      (await readJudgeRunPermanent(testDb(), b.runId)).kind,
    ].sort(),
  ).toEqual(['manual', 'pending']);
});

it('old args.now alone cannot backdate a same-ID fresh authorization past the real boundary', async () => {
  const d = deps(),
    submittedAt = new Date(Date.now() - RECOVERY_MAX_AGE_MS - 60_000);
  d.boss?.send &&
    vi.mocked(d.boss.send).mockRejectedValueOnce(new Error('controlled send unknown'));
  const f = await dispatchFrozenJudge(testDb(), d, submittedAt);
  expect(
    await reconcileStalledJudgeAttempts(testDb(), {
      deps: d,
      now: new Date(submittedAt.getTime() + RECOVERY_MAX_AGE_MS - 3600_000),
    }),
  ).toMatchObject({ reenqueued: 0, skippedExhausted: 1 });
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
  expect(d.boss?.send).toHaveBeenCalledTimes(1);
});
