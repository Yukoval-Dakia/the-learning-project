import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcileStalledJudgeAttempts } from '@/capabilities/practice/jobs/judge_pending_reconcile';
import { runJudgeWorkflowDelivery } from '@/capabilities/practice/jobs/judge_run';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import { judgeDeliveryInput } from '@/capabilities/practice/server/judge-engine-client';
import {
  acceptJudgeDelivery,
  authorizeJudgeSend,
  disposeJudgeRun,
  fenceJudgeUnitClaim,
  lockJudgeRun,
  reserveJudgeDelivery,
} from '@/capabilities/practice/server/judge-operational';
import { projectJudgeRunNotification } from '@/capabilities/practice/server/judge-run-notification';
import {
  createJudgeRunStatusReader,
  readJudgeRunPermanent,
} from '@/capabilities/practice/server/judge-run-observation';
import { canonicalHash } from '@/core/migration/canonical';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import { evaluation, event, job_events, mastery_state, material_fsrs_state } from '@/db/schema';
import * as domain from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import * as notificationWriter from '@/server/events/writer';
import { resetDb, testDb } from '../helpers/db';
import { dispatchFrozenJudge, frozenJudge, judgeEvidence, resetJudgeControl } from './support';

beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb());
});
afterEach(() => vi.restoreAllMocks());
const enqueue = {
  checkRateLimit: () => 17,
  boss: {
    send: async (_name: string, _payload: unknown, options?: { id?: string }) =>
      options?.id ?? null,
  },
};
function scorer(callback?: (request: ModelExecutorRequest) => Promise<void>) {
  const execute = vi.fn(
    async (
      request: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      taskId: string,
    ): Promise<ModelUnitOutcomeT> => {
      await callback?.(request);
      return {
        kind: 'scored',
        points_awarded: request.unit.points,
        matched: {
          rule_id:
            request.unit.criterion.kind === 'rule_reference'
              ? request.unit.criterion.rule_id
              : undefined,
          option_ids: [],
        },
        feedback_md: '保留方程与量纲。',
        confidence: 0.96,
        evidence_citations: [{ slot_id: request.response_slots[0]?.slot_id, quote: '2v=30' }],
        run_refs: [taskId],
        cost_usd_micros: 120,
      };
    },
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
    (database, _signal, _admission, execution) =>
      createRecordedModelExecutor(
        database,
        execute,
        execution ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) } : {},
      ),
  );
  return execute;
}
it('saved first unit, second unknown, third unclaimed: no additional paid claim on native recovery', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue);
  const execute = scorer();
  execute.mockImplementationOnce(async (input, _signal, task) => ({
    kind: 'scored',
    points_awarded: input.unit.points,
    matched: { rule_id: 'equations', option_ids: [] },
    feedback_md: '方程正确',
    confidence: 0.98,
    evidence_citations: [{ slot_id: input.response_slots[0]?.slot_id, quote: 'v+c=18' }],
    run_refs: [task],
    cost_usd_micros: 80,
  }));
  execute.mockImplementationOnce(async () => {
    throw new Error('controlled response lost');
  });
  await runJudgeWorkflowDelivery(testDb(), f.input);
  const rows = await judgeEvidence(testDb(), f.runId);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(rows.filter((r) => r.action === 'experimental:assessment_model_claim')).toHaveLength(2);
  const saved = rows.filter((r) => r.action === 'experimental:assessment_model_result');
  expect(saved).toHaveLength(2);
  expect(saved.map((r) => r.payload.outcome)).toContainEqual(
    expect.objectContaining({ kind: 'scored', feedback_md: '方程正确' }),
  );
  expect(saved.every((r) => rows.some((c) => c.id === r.caused_by_event_id))).toBe(true);
  await runJudgeWorkflowDelivery(testDb(), f.input);
  expect(execute).toHaveBeenCalledTimes(2);
  const state = await readJudgeRunPermanent(testDb(), f.runId);
  expect(state.kind).toBe('resolved');
  if (state.kind === 'resolved') expect(state.result.status).toBe('review_required');
});
it('manual disposition during first inference retains late unit evidence and blocks seal, capture, activation and settlement', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue);
  const execute = scorer(async () => {
    await disposeJudgeRun(testDb(), f.runId, {
      reason: 'provider_unknown',
      actorRef: 'test:late-worker',
      evidenceRefs: [f.input.reservation_id],
      evidenceDigest: canonicalHash('manual-before-response'),
    });
  });
  await runJudgeWorkflowDelivery(testDb(), f.input);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await testDb().select().from(evaluation)).toHaveLength(0);
  expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
  expect(await testDb().select().from(mastery_state)).toHaveLength(0);
  expect(
    (await judgeEvidence(testDb(), f.runId)).filter(
      (r) => r.action === 'experimental:assessment_model_result',
    ),
  ).toHaveLength(1);
  await testDb().delete(job_events);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
});
it('result COMMIT with lost acknowledgment reads the exact saved outcome and does not repurchase', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue),
    execute = scorer(),
    write = domain.writeEvent;
  const database = testDb(),
    transaction = database.transaction.bind(database);
  let lost = false,
    ack = false;
  vi.spyOn(domain, 'writeEvent').mockImplementation(async (db, args) => {
    const result = await write(db, args);
    if (!lost && args.action === 'experimental:assessment_model_result') {
      lost = true;
      ack = true;
    }
    return result;
  });
  database.transaction = (body, config) =>
    transaction(body, config).then((result) => {
      if (ack) {
        ack = false;
        throw new Error('controlled result COMMIT acknowledgment lost');
      }
      return result;
    });
  try {
    await runJudgeWorkflowDelivery(database, f.input);
    expect(execute).toHaveBeenCalledTimes(3);
    expect((await readJudgeRunPermanent(database, f.runId)).kind).toBe('resolved');
    await runJudgeWorkflowDelivery(database, f.input);
    expect(execute).toHaveBeenCalledTimes(3);
  } finally {
    database.transaction = transaction;
  }
});
it('native completion beats engine errors and pruning, retaining original and effective candidate identities', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue),
    execute = scorer();
  await runJudgeWorkflowDelivery(testDb(), f.input);
  await testDb().delete(job_events);
  const observe = vi.fn(async () => ({
    kind: 'unavailable' as const,
    reason: 'backend_unavailable' as const,
  }));
  const status = await createJudgeRunStatusReader({ observe, observeUnmapped: observe })(
    testDb(),
    f.runId,
  );
  expect(status.kind).toBe('found');
  if (status.kind === 'found') {
    expect(status.value.status).toBe('done');
    expect(status.value.result?.assessment?.candidate_id).toBeTruthy();
  }
  expect(observe).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(3);
  expect(
    await disposeJudgeRun(testDb(), f.runId, {
      reason: 'explicit_disposal',
      actorRef: 'test:late-manual',
      evidenceRefs: [f.input.pending_id],
      evidenceDigest: canonicalHash('late'),
    }),
  ).toEqual({ kind: 'already_completed' });
  const before = await testDb().select().from(evaluation);
  await runJudgeWorkflowDelivery(testDb(), f.input);
  expect(await testDb().select().from(evaluation)).toEqual(before);
  expect(execute).toHaveBeenCalledTimes(3);
});

it('permanent manual before FAILED projection is repaired by the sole reconciler; delayed send cannot rewind it', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue, new Date(Date.now() - 20 * 60_000));
  await disposeJudgeRun(testDb(), f.runId, {
    reason: 'explicit_disposal',
    actorRef: 'test:projection-crash',
    evidenceRefs: [f.input.pending_id],
    evidenceDigest: canonicalHash('projection-crash'),
  });
  await testDb().delete(job_events);
  const send = vi.fn(enqueue.boss.send),
    gate = vi.fn(enqueue.checkRateLimit),
    observe = vi.fn();
  await reconcileStalledJudgeAttempts(testDb(), {
    deps: {
      ...enqueue,
      checkRateLimit: gate,
      observe,
      boss: { send, getJobById: async () => null },
    },
  });
  const repaired = await testDb().select().from(job_events);
  expect(repaired.map((m) => m.event_type)).toEqual(['judge_run.failed']);
  expect(send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  await projectJudgeRunNotification(testDb(), f.runId, {
    eventType: 'judge_run.requeued',
    payload: { delivery_id: 'causally-late-delivery', attempt: 2 },
  });
  const markers = await testDb().select().from(job_events);
  expect(markers.map((m) => m.event_type)).toEqual(['judge_run.failed']);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
  await testDb().delete(job_events);
  await reconcileStalledJudgeAttempts(testDb(), {
    tick: { backend: 'pg-boss', id: 'manual-pruned-new-tick' },
    deps: { checkRateLimit: gate, boss: { send, getJobById: async () => null }, observe },
  });
  expect((await testDb().select().from(job_events)).map((m) => m.event_type)).toEqual([
    'judge_run.failed',
  ]);
  expect(send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
});

it('worker manual disposition survives all three failed terminal writes; a new sole sweep repairs it without execution', async () => {
  const f = await dispatchFrozenJudge(testDb(), enqueue, new Date(Date.now() - 20 * 60_000));
  const execute = scorer(async () => {
    await disposeJudgeRun(testDb(), f.runId, {
      reason: 'provider_unknown',
      actorRef: 'test:terminal-window',
      evidenceRefs: [f.input.pending_id],
      evidenceDigest: canonicalHash('terminal-window'),
    });
  });
  const writer = notificationWriter.writeJobEvent;
  let failedWrites = 0;
  const failure = vi
    .spyOn(notificationWriter, 'writeJobEvent')
    .mockImplementation(async (tx, input) => {
      if (input.event_type === 'judge_run.failed') {
        failedWrites++;
        expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
        throw new Error('controlled terminal notification persistence failure');
      }
      return writer(tx, input);
    });
  await expect(runJudgeWorkflowDelivery(testDb(), f.input)).rejects.toThrow('controlled terminal');
  expect(failedWrites).toBe(3);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    (
      await testDb()
        .select()
        .from(job_events)
        .where(and(eq(job_events.business_table, 'judge_run'), eq(job_events.business_id, f.runId)))
    ).some((m) => m.event_type === 'judge_run.failed'),
  ).toBe(false);
  failure.mockRestore();
  const send = vi.fn(enqueue.boss.send),
    gate = vi.fn(enqueue.checkRateLimit);
  await reconcileStalledJudgeAttempts(testDb(), {
    deps: { checkRateLimit: gate, boss: { send, getJobById: async () => null } },
  });
  expect(
    (
      await testDb()
        .select()
        .from(job_events)
        .where(and(eq(job_events.business_table, 'judge_run'), eq(job_events.business_id, f.runId)))
    ).filter((m) => m.event_type === 'judge_run.failed'),
  ).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
});

it('a pre-boundary authorized and live final slot still completes after seven days with one original receipt', async () => {
  const submittedAt = new Date(Date.now() - 7 * 86400_000 - 60_000),
    admittedAt = new Date(submittedAt.getTime() + 7 * 86400_000 - 1),
    f = await dispatchFrozenJudge(testDb(), enqueue, submittedAt),
    execute = scorer();
  let input = f.input;
  for (const slot of [1, 2])
    await testDb().transaction(async (tx) => {
      await lockJudgeRun(tx, f.runId);
      const [pending] = await tx.select().from(event).where(eq(event.id, f.input.pending_id));
      const reservation = await reserveJudgeDelivery(
        tx,
        f.input.pending_id,
        JudgePendingAttemptPayload.parse(pending?.payload),
        f.input.ownership,
        slot,
        admittedAt,
      );
      const sendId = await authorizeJudgeSend(tx, reservation, admittedAt);
      await acceptJudgeDelivery(tx, reservation, sendId, 'enqueue_ack', admittedAt);
      input = judgeDeliveryInput(reservation);
    });
  const before = (await judgeEvidence(testDb(), f.runId)).filter((r) =>
    ['experimental:judge_delivery_reserved', 'experimental:judge_delivery_send'].includes(r.action),
  );
  const clock = vi.fn(() => new Date()),
    send = vi.fn(enqueue.boss.send),
    gate = vi.fn(enqueue.checkRateLimit);
  expect(
    await reconcileStalledJudgeAttempts(testDb(), {
      deps: {
        checkRateLimit: gate,
        authorizationClock: clock,
        boss: { send, getJobById: async () => null },
        observe: async (r) => ({
          kind: 'present',
          state: 'PENDING',
          input: judgeDeliveryInput(r),
          deliveryId: r.delivery_id,
        }),
      },
    }),
  ).toMatchObject({ reenqueued: 0, skippedLive: 1 });
  expect(clock).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
  await runJudgeWorkflowDelivery(testDb(), input);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(await testDb().select().from(event).where(eq(event.id, f.runId))).toHaveLength(1);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('resolved');
  expect(
    (await judgeEvidence(testDb(), f.runId)).filter((r) =>
      ['experimental:judge_delivery_reserved', 'experimental:judge_delivery_send'].includes(
        r.action,
      ),
    ),
  ).toEqual(before);
  expect(
    (await testDb().select().from(job_events)).filter((r) => r.event_type === 'judge_run.done'),
  ).toHaveLength(1);
});

it.each(['rate-limit', 'pending-abort'])(
  'admission failure %s leaves no executable pending and refunds only an acquired live token',
  async (failure) => {
    const f = await frozenJudge(testDb());
    const send = vi.fn(
        async (_queue: string, _data: unknown, options?: { id?: string }) => options?.id ?? null,
      ),
      refund = vi.fn();
    if (failure === 'pending-abort') {
      const write = domain.writeEvent;
      vi.spyOn(domain, 'writeEvent').mockImplementation(async (db, args) => {
        if (args.action === 'experimental:judge_pending_attempt')
          throw new Error('controlled pending transaction abort');
        return write(db, args);
      });
    }
    await expect(
      dispatchNativeAttempt(testDb(), f.id, f.request, f.options, {
        checkRateLimit: () => {
          if (failure === 'rate-limit')
            throw new ApiError('rate_limited', 'controlled admission', 429);
          return 29;
        },
        refundRateLimit: refund,
        boss: { send },
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledTimes(failure === 'pending-abort' ? 1 : 0);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(
          inArray(event.action, [
            'experimental:judge_pending_attempt',
            'experimental:judge_delivery_reserved',
            'experimental:assessment_model_claim',
          ]),
        ),
    ).toHaveLength(0);
  },
);
it('pending COMMIT acknowledgment loss preserves the same accepted original, token and reservation; the sweep resends only that fixed identity', async () => {
  const database = testDb(),
    f = await frozenJudge(database, new Date(Date.now() - 20 * 60_000)),
    transaction = database.transaction.bind(database),
    write = domain.writeEvent;
  let lost = false,
    ack = false;
  let committedRows: (typeof event.$inferSelect)[] | undefined;
  vi.spyOn(domain, 'writeEvent').mockImplementation(async (db, args) => {
    const row = await write(db, args);
    if (!lost && args.action === 'experimental:judge_pending_attempt') {
      lost = true;
      ack = true;
    }
    return row;
  });
  database.transaction = (body, config) =>
    transaction(body, config).then(async (result) => {
      if (ack) {
        ack = false;
        // The real transaction has committed. Preserve its exact rows before losing the ack.
        committedRows = await database.select().from(event).orderBy(event.id);
        throw new Error('controlled pending COMMIT acknowledgment lost');
      }
      return result;
    });
  const send = vi.fn(async (_name: string, _data: unknown, o?: { id?: string }) => o?.id ?? null),
    refund = vi.fn(),
    deps = {
      checkRateLimit: vi.fn(() => 31),
      refundRateLimit: refund,
      boss: { send, getJobById: async () => null },
    };
  let runId: string | null;
  try {
    runId = await dispatchNativeAttempt(database, f.id, f.request, f.options, deps);
  } finally {
    database.transaction = transaction;
  }
  if (!runId) throw new Error('Lost acknowledgment fixture was not accepted');
  expect(lost).toBe(true);
  expect(committedRows).toBeDefined();
  expect(deps.checkRateLimit).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
  expect(await database.select().from(event).orderBy(event.id)).toEqual(committedRows);
  const originals = await database
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:judge_pending_attempt'));
  expect(originals).toHaveLength(1);
  const original = JudgePendingAttemptPayload.parse(originals[0].payload);
  if (original.caller !== 'native_assessment') throw new Error('Expected native original');
  expect(original.run_id).toBe(runId);
  expect(runId).toBe(`judge_native_${original.submit.submission_id}`);
  expect(original.submit).toMatchObject({
    question_id: f.id,
    evaluation_group_id: f.request.evaluation_group_id,
    expected_head: { expected_effective_id: null, expected_generation: 0 },
    capture: f.options.capture,
    require_unassisted_model_evidence: false,
  });
  expect(
    await dispatchNativeAttempt(
      database,
      f.id,
      f.request,
      { ...f.options, enabled: false, capture: { latency_ms: 999, session_id: 'retry-session' } },
      deps,
    ),
  ).toBe(runId);
  for (const changedOptions of [
    { ...f.options, userRating: 'again' as const },
    { ...f.options, enabled: false, requireUnassistedModelEvidence: true },
  ]) {
    await expect(
      dispatchNativeAttempt(database, f.id, f.request, changedOptions, deps),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
  }
  expect(await database.select().from(event).orderBy(event.id)).toEqual(committedRows);
  expect(deps.checkRateLimit).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
  const before = await readJudgeRunPermanent(database, runId);
  if (before.kind !== 'pending' || !before.delivery) throw new Error('Missing retained slot');
  await reconcileStalledJudgeAttempts(database, {
    deps: { ...deps, observe: async (r) => ({ kind: 'absent', deliveryId: r.delivery_id }) },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[2]?.id).toBe(before.delivery.reservation.delivery_id);
  expect(refund).not.toHaveBeenCalled();
  expect(await database.select().from(event).where(eq(event.id, originals[0].id))).toEqual(
    originals,
  );
  expect(
    await database
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_model_claim')),
  ).toHaveLength(0);
  expect(await database.select().from(evaluation)).toHaveLength(0);
  expect(
    await database
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:judge_delivery_reserved'))),
  ).toHaveLength(1);
  const after = await readJudgeRunPermanent(database, runId);
  if (after.kind !== 'pending' || !after.delivery)
    throw new Error('Missing retained slot after sweep');
  expect(after.delivery.reservation).toEqual(before.delivery.reservation);
});
