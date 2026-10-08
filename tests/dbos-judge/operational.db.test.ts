import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcileStalledJudgeAttempts } from '@/capabilities/practice/jobs/judge_pending_reconcile';
import { runJudgeWorkflowDelivery } from '@/capabilities/practice/jobs/judge_run';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import {
  disposeJudgeRun,
  fenceJudgeUnitClaim,
} from '@/capabilities/practice/server/judge-operational';
import { projectJudgeRunNotification } from '@/capabilities/practice/server/judge-run-notification';
import {
  createJudgeRunStatusReader,
  readJudgeRunPermanent,
} from '@/capabilities/practice/server/judge-run-observation';
import { canonicalHash } from '@/core/migration/canonical';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { evaluation, event, job_events, mastery_state, material_fsrs_state } from '@/db/schema';
import * as domain from '@/kernel/events';
import { ApiError } from '@/kernel/http';
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
  await reconcileStalledJudgeAttempts(testDb(), {
    deps: {
      ...enqueue,
      boss: { ...enqueue.boss, getJobById: async () => null },
    },
  });
  await projectJudgeRunNotification(testDb(), f.runId, {
    eventType: 'judge_run.requeued',
    payload: { delivery_id: 'causally-late-delivery', attempt: 2 },
  });
  const markers = await testDb().select().from(job_events);
  expect(markers.map((m) => m.event_type)).toEqual(['judge_run.failed']);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
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
  vi.spyOn(domain, 'writeEvent').mockImplementation(async (db, args) => {
    const row = await write(db, args);
    if (!lost && args.action === 'experimental:judge_pending_attempt') {
      lost = true;
      ack = true;
    }
    return row;
  });
  database.transaction = (body, config) =>
    transaction(body, config).then((result) => {
      if (ack) {
        ack = false;
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
  expect(send).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
  const before = await readJudgeRunPermanent(database, runId);
  if (before.kind !== 'pending' || !before.delivery) throw new Error('Missing retained slot');
  await reconcileStalledJudgeAttempts(database, {
    deps: { ...deps, observe: async (r) => ({ kind: 'absent', deliveryId: r.delivery_id }) },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[2]?.id).toBe(before.delivery.reservation.delivery_id);
  expect(
    await database
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:judge_delivery_reserved'))),
  ).toHaveLength(1);
});
