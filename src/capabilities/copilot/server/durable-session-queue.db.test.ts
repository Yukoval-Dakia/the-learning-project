import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCancelCopilotRunHandler } from '@/capabilities/copilot/api/cancel-run';
import { POST as sendMessage } from '@/capabilities/copilot/api/chat';
import {
  CopilotDurableRunResponseSchema,
  CopilotTurnsResponseSchema,
} from '@/capabilities/copilot/api/contracts';
import { GET as readConversation } from '@/capabilities/copilot/api/turns';
import { isDurablePickupStalled } from '@/capabilities/copilot/durable-pickup';
import {
  buildCopilotRunHandler,
  writeSuccessfulTerminalProjection,
} from '@/capabilities/copilot/jobs/copilot_run';
import { reconcileOutstandingCopilotRuns } from '@/capabilities/copilot/jobs/copilot_run_reconcile';
import { copilotCapability } from '@/capabilities/copilot/manifest';
import { event, job_events } from '@/db/schema';
import * as agentRunner from '@/server/ai/runner';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { registerCapabilityJobs } from '@/server/boss/register-capability-jobs';
import { writeJobEvent } from '@/server/events/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import * as runtimeEnv from '@/server/runtime-env';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotReply } from './chat';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  type CopilotAcceptedJobData,
  type CopilotDurableAcceptance,
  type CopilotRunJobData,
  dispatchSessionHead,
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from './durable-dispatch';
import { getCopilotTurnsBeforeAnchor } from './turns';

const SESSION_ID = 'conversation_fifo_cross_subject_transfer';
const FIXED_NOW_MS = Date.parse('2026-09-06T13:30:00.000Z');

function richJobData(label: string): CopilotAcceptedJobData {
  return {
    user_message: `第 ${label} 轮：读取近 45 天 48 条含参函数、电磁感应与化学计量作答，交叉核对定义域、方向和单位，再生成 9 道迁移题。`,
    triggered_by: 'chip',
    chip_kind: `continue_${label}`,
    ambient: {
      route: `/subjects/physics/review?turn=${label}`,
      focused_entity: { kind: 'knowledge', id: `kc_transfer_${label}` },
    },
    correction_target_turn_id: `copilot_reply_prior_${label}`,
    skill_context: {
      skill: 'quiz',
      ref: { kind: 'knowledge', id: `kc_transfer_${label}` },
    },
  };
}

async function accept(
  boss: PgBoss,
  label: string,
  sessionId = SESSION_ID,
  assertActive?: () => void,
): Promise<CopilotDurableAcceptance> {
  const jobData = richJobData(label);
  const result = await reserveCopilotDurableAcceptance(
    testDb(),
    {
      sessionId,
      userMessage: jobData.user_message,
      inputHash: hashCopilotDurableInput(jobData),
      idempotencyKey: randomUUID(),
      queuedPayload: {
        session_id: sessionId,
        triggered_by: jobData.triggered_by,
        dispatch: { source: 'unified_conversation' },
      },
      jobData,
      ...(assertActive ? { assertActive } : {}),
    },
    { boss, transactionDb: fromPgBossDrizzleTx, nowMs: () => FIXED_NOW_MS },
  );
  return result.acceptance;
}

async function runEvents(runId: string) {
  return testDb()
    .select({ event_type: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)))
    .orderBy(asc(job_events.id));
}

async function settleWithoutWorker(boss: PgBoss, acceptance: CopilotDurableAcceptance) {
  await boss.cancel('copilot_run', acceptance.bossJobId);
  await writeJobEvent(testDb(), {
    business_table: COPILOT_RUN_TABLE,
    business_id: acceptance.runId,
    event_type: COPILOT_RUN_EVENTS.DONE,
    payload: { checkpoint_event_id: acceptance.runId, task_run_id: `task_${acceptance.runId}` },
  });
}

function cancelRequest(runId: string): Request {
  return new Request(`http://test/api/copilot/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

describe('durable Copilot session FIFO — real pg-boss contract', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    _resetBossForTests();
    boss = await getStartedBoss();
    if (!(await boss.getQueue('copilot_run'))) {
      await boss.createQueue('copilot_run');
    }
  });

  beforeEach(async () => {
    await resetDb();
    await testDb().delete(job_events);
    await boss.deleteAllJobs('copilot_run');
    __resetRateLimitForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await boss.deleteAllJobs('copilot_run').catch(() => undefined);
    await boss.stop({ graceful: false, timeout: 1_000 });
    _resetBossForTests();
  });

  it('recovers an accepted disconnected request, accepts follow-ups, and resumes the next turn through real route owners', async () => {
    // Only enable test queue admission; conversation, transactions, queue,
    // history and cancellation all use production owners with real Postgres.
    vi.spyOn(runtimeEnv, 'shouldEnqueueBackgroundJobs').mockReturnValue(true);
    const key = randomUUID();
    const controller = new AbortController();
    const firstInput = {
      user_message:
        '请核对近 48 次含参函数作答中的定义域与退化条件，保留尚未验证的分支，不要把推测标成已掌握。',
      triggered_by: 'chat',
      ambient_context: {
        route: '/today',
        focused_entity: { kind: 'knowledge', id: 'kc_parameter_boundary' },
      },
    };
    const request = (input: unknown, requestKey: string, signal?: AbortSignal) =>
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey },
        body: JSON.stringify(input),
        signal,
      });
    const initial = await sendMessage(request(firstInput, key, controller.signal), {});
    expect(initial.status).toBe(202);
    // Lose the response body after server acceptance; reconnect has no local handle.
    controller.abort();
    const snapshotResponse = await readConversation(new Request('http://test/api/copilot/turns'));
    const snapshot = CopilotTurnsResponseSchema.parse(await snapshotResponse.json());
    expect(snapshot.active_runs).toHaveLength(1);
    const replayResponse = await sendMessage(request(firstInput, key), {});
    expect(replayResponse.status).toBe(202);
    const first = CopilotDurableRunResponseSchema.parse(await replayResponse.json());
    expect(first.run_id).toBe(snapshot.active_runs[0]?.run_id);
    expect(first.session_id).toBe(snapshot.session_id);
    const secondResponse = await sendMessage(
      request(
        {
          ...firstInput,
          session_id: first.session_id,
          user_message: '先不要生成题目，只解释第二个退化分支。',
          skill_context: {
            skill: 'teaching',
            ref: { kind: 'learning_item', id: 'li_parameter_review' },
          },
        },
        randomUUID(),
      ),
      {},
    );
    const thirdResponse = await sendMessage(
      request(
        {
          ...firstInput,
          session_id: first.session_id,
          user_message: '继续核对刚才尚未验证的分支，保留不确定结论。',
          triggered_by: 'chip',
          chip_kind: 'continue_review',
        },
        randomUUID(),
      ),
      {},
    );
    expect([secondResponse.status, thirdResponse.status]).toEqual([202, 202]);
    const second = CopilotDurableRunResponseSchema.parse(await secondResponse.json());
    const third = CopilotDurableRunResponseSchema.parse(await thirdResponse.json());
    expect(
      await boss.findJobs('copilot_run', { data: { session_id: first.session_id } }),
    ).toHaveLength(1);
    const current = CopilotTurnsResponseSchema.parse(
      await (
        await readConversation(
          new Request(`http://test/api/copilot/turns?session_id=${first.session_id}`),
        )
      ).json(),
    );
    expect(current.active_runs.map((run) => run.run_id)).toEqual([
      first.run_id,
      second.run_id,
      third.run_id,
    ]);
    expect(JSON.stringify(current)).not.toContain('job_data');

    // Stop only the waiting teaching turn, leaving the current turn running.
    const stop = buildCancelCopilotRunHandler({
      wakeSession: (sessionId) =>
        dispatchSessionHead(testDb(), sessionId, { boss, transactionDb: fromPgBossDrizzleTx }),
    });
    expect((await stop(cancelRequest(second.run_id), { id: second.run_id })).status).toBe(200);
    expect(
      await boss.findJobs('copilot_run', { data: { session_id: first.session_id } }),
    ).toHaveLength(1);
    const reply = '已核对定义域；第二个退化分支证据不足，仍未确认掌握。';
    await writeCopilotReply(testDb(), {
      sessionId: first.session_id,
      userAskEventId: first.run_id,
      replyText: reply,
      actorRef: 'agent:copilot',
      taskRunId: 'task_route_recovered',
      now: new Date(),
      outcome: 'success',
    });
    await writeSuccessfulTerminalProjection(
      testDb(),
      {
        runId: first.run_id,
        replyMd: reply,
        taskRunId: 'task_route_recovered',
        finishReason: 'stop',
      },
      await runEvents(first.run_id),
    );
    const [physicalFirst] = await boss.findJobs<CopilotRunJobData>('copilot_run', {
      data: { run_id: first.run_id },
    });
    if (!physicalFirst) throw new Error('missing accepted head');
    await buildCopilotRunHandler(testDb(), {
      wakeSession: (sessionId) =>
        dispatchSessionHead(testDb(), sessionId, { boss, transactionDb: fromPgBossDrizzleTx }),
    })([physicalFirst]);
    const [physicalThird] = await boss.findJobs<CopilotRunJobData>('copilot_run', {
      data: { run_id: third.run_id },
    });
    expect(physicalThird?.data).toMatchObject({
      triggered_by: 'chip',
      chip_kind: 'continue_review',
      session_id: first.session_id,
      ambient: firstInput.ambient_context,
    });
    const history = await getCopilotTurnsBeforeAnchor(testDb(), {
      sessionId: first.session_id,
      anchorEventId: third.run_id,
    });
    expect(history.some((turn) => turn.role === 'ai' && turn.text === reply)).toBe(true);
    const restored = CopilotTurnsResponseSchema.parse(
      await (await readConversation(new Request('http://test/api/copilot/turns'))).json(),
    );
    expect(restored.active_runs.map((run) => run.run_id)).toEqual([third.run_id]);
    expect(restored.turns.filter((turn) => turn.event_id === first.run_id)).toHaveLength(1);
  });

  it('accepts three turns but dispatches only the head, then advances with the complete job body', async () => {
    const first = await accept(boss, 'one');
    const second = await accept(boss, 'two');
    const third = await accept(boss, 'three');

    expect(await boss.getJobById('copilot_run', first.bossJobId)).toMatchObject({
      id: first.bossJobId,
      state: 'created',
    });
    expect(await boss.getJobById('copilot_run', second.bossJobId)).toBeNull();
    expect(await boss.getJobById('copilot_run', third.bossJobId)).toBeNull();
    expect((await runEvents(first.runId)).map((row) => row.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.DISPATCHED,
    ]);
    expect((await runEvents(second.runId)).map((row) => row.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
    ]);

    await settleWithoutWorker(boss, first);
    await expect(
      dispatchSessionHead(testDb(), SESSION_ID, { boss, transactionDb: fromPgBossDrizzleTx }),
    ).resolves.toBe(second.runId);

    const physicalSecond = await boss.getJobById('copilot_run', second.bossJobId);
    expect(physicalSecond?.data).toEqual({
      ...richJobData('two'),
      run_id: second.runId,
      session_id: SESSION_ID,
    } satisfies CopilotRunJobData);
    expect(await boss.getJobById('copilot_run', third.bossJobId)).toBeNull();

    const roots = await testDb()
      .select({
        id: event.id,
        action: event.action,
        actor_kind: event.actor_kind,
        actor_ref: event.actor_ref,
        payload: event.payload,
      })
      .from(event)
      .where(eq(event.session_id, SESSION_ID))
      .orderBy(asc(event.dispatch_seq));
    expect(roots.map((row) => row.id)).toEqual([first.runId, second.runId, third.runId]);
    expect(roots[0]).toMatchObject({
      action: 'experimental:copilot_chip_trigger',
      actor_kind: 'system',
      actor_ref: 'ui:copilot_chip',
      payload: { chip_kind: 'continue_one' },
    });
  });

  it('automatically polls a terminal replay and its cancelled successor through the manifest without a model call', async () => {
    const model = vi.spyOn(agentRunner, 'runAgentTask').mockImplementation(async () => {
      throw new Error('No model execution is authorized in the automatic polling fixture');
    });
    const first = await accept(boss, 'worker-complete');
    const second = await accept(boss, 'worker-next');
    // The physical head is still created; only its product terminal was already
    // committed before a worker restart. Its redelivery must wake the successor.
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: first.runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: `task_${first.runId}` },
    });
    // A Stop arrived for the waiting successor. It still has no physical job;
    // automatic pickup must settle it without opening a paid execution.
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: second.runId,
      event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      payload: { reason: 'user_requested' },
    });
    const worker = copilotCapability.jobs?.handlers.find(
      (handler) => handler.name === 'copilot_run',
    );
    if (!worker?.load) throw new Error('missing manifest worker');
    try {
      // Scope only the target production declaration: no unrelated scheduled
      // capability jobs run in this isolated database. Registrar/options/load
      // and pg-boss's automatic work/complete loop are unchanged.
      await registerCapabilityJobs(boss, testDb(), [
        { ...copilotCapability, jobs: { handlers: [worker] } },
      ]);
      await expect
        .poll(
          async () => [
            (await boss.getJobById('copilot_run', first.bossJobId))?.state,
            (await boss.getJobById('copilot_run', second.bossJobId))?.state,
          ],
          { timeout: 12_000, interval: 100 },
        )
        .toEqual(['completed', 'completed']);
    } finally {
      await boss.offWork('copilot_run');
    }
    expect(model).not.toHaveBeenCalled();
    expect((await runEvents(second.runId)).at(-1)).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled' },
    });
    expect(
      (await runEvents(second.runId)).filter(
        (row) => row.event_type === COPILOT_RUN_EVENTS.DISPATCHED,
      ),
    ).toHaveLength(1);
  });

  it('never publishes a typed-ask revert checkpoint for a chip-triggered reply', async () => {
    const accepted = await accept(boss, 'chip-projection');
    await writeSuccessfulTerminalProjection(
      testDb(),
      {
        runId: accepted.runId,
        taskRunId: `task_${accepted.runId}`,
        replyMd: '已核对近两轮练习；定义域仍需结合退化条件检查，方向与单位分别保留证据。',
        finishReason: 'stop',
      },
      await runEvents(accepted.runId),
    );
    const terminal = (await runEvents(accepted.runId)).filter((row) =>
      [COPILOT_RUN_EVENTS.REPLY, COPILOT_RUN_EVENTS.DONE].some((type) => type === row.event_type),
    );
    expect(terminal).toHaveLength(2);
    for (const row of terminal) expect(row.payload).not.toHaveProperty('checkpoint_event_id');
  });

  it('lets concurrent head dispatch attempts commit exactly one physical job and marker', async () => {
    const first = await accept(boss, 'concurrent-head');
    const second = await accept(boss, 'concurrent-next');
    await settleWithoutWorker(boss, first);

    const winners = await Promise.all(
      Array.from({ length: 5 }, () =>
        dispatchSessionHead(testDb(), SESSION_ID, { boss, transactionDb: fromPgBossDrizzleTx }),
      ),
    );
    expect(winners.filter((runId) => runId === second.runId)).toHaveLength(1);
    expect(await boss.getJobById('copilot_run', second.bossJobId)).toMatchObject({
      id: second.bossJobId,
      state: 'created',
    });
    expect(
      (await runEvents(second.runId)).filter(
        (row) => row.event_type === COPILOT_RUN_EVENTS.DISPATCHED,
      ),
    ).toHaveLength(1);
  });

  it('rolls back the ask, durable events and pg-boss job when acceptance aborts after send', async () => {
    const sessionId = `conversation_atomic_rollback_${randomUUID()}`;
    let checks = 0;
    await expect(
      accept(boss, 'rollback', sessionId, () => {
        checks += 1;
        if (checks === 3) throw new Error('abort after transactional job insert');
      }),
    ).rejects.toThrow('abort after transactional job insert');

    const asks = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(eq(event.session_id, sessionId));
    const durableEvents = await testDb()
      .select({ id: job_events.id })
      .from(job_events)
      .where(sql`${job_events.payload}->>'session_id' = ${sessionId}`);
    const physicalJobs = await boss.findJobs<CopilotRunJobData>('copilot_run', {
      data: { session_id: sessionId },
    });
    expect(asks).toEqual([]);
    expect(durableEvents).toEqual([]);
    expect(physicalJobs).toEqual([]);
  });

  it('keeps waiting turns out of pickup-loss recovery and lets the reconciler advance the head', async () => {
    const first = await accept(boss, 'reconcile-first');
    const waiting = await accept(boss, 'reconcile-waiting');
    const afterCancelled = await accept(boss, 'after-cancelled');

    const waitingEvents = await runEvents(waiting.runId);
    expect(isDurablePickupStalled(waitingEvents, FIXED_NOW_MS + 60_000)).toBe(false);

    const initialReport = await reconcileOutstandingCopilotRuns(testDb(), {
      boss,
      now: new Date(FIXED_NOW_MS + 60_000),
    });
    expect(initialReport.observations.pre_execution_lost).toBe(0);
    expect(initialReport.observations.waiting_on_active_run).toBe(2);
    expect(await boss.getJobById('copilot_run', waiting.bossJobId)).toBeNull();

    // Simulate a terminal commit whose worker died before its best-effort wake.
    await settleWithoutWorker(boss, first);
    const recoveryReport = await reconcileOutstandingCopilotRuns(testDb(), {
      boss,
      now: new Date(FIXED_NOW_MS + 61_000),
    });
    expect(recoveryReport.observations.queued).toBe(1);
    expect(recoveryReport.observations.pre_execution_lost).toBe(0);
    expect(await boss.getJobById('copilot_run', waiting.bossJobId)).toMatchObject({
      id: waiting.bossJobId,
      state: 'created',
    });
    expect(await boss.getJobById('copilot_run', afterCancelled.bossJobId)).toBeNull();
  });

  it('cancels an accepted waiting head and immediately dispatches its successor', async () => {
    const first = await accept(boss, 'cancel-first');
    const waiting = await accept(boss, 'cancel-waiting');
    const afterCancelled = await accept(boss, 'cancel-successor');

    // Leave the second turn as QUEUED-only head, matching a worker crash before wake.
    await settleWithoutWorker(boss, first);
    const cancelRun = buildCancelCopilotRunHandler({
      wakeSession: (sessionId) =>
        dispatchSessionHead(testDb(), sessionId, { boss, transactionDb: fromPgBossDrizzleTx }),
    });
    const cancelResponse = await cancelRun(cancelRequest(waiting.runId), { id: waiting.runId });
    expect(await cancelResponse.json()).toMatchObject({
      ok: true,
      run_id: waiting.runId,
      status: 'cancelled',
    });
    expect((await runEvents(waiting.runId)).at(-1)?.payload).not.toHaveProperty(
      'checkpoint_event_id',
    );
    expect(await boss.getJobById('copilot_run', waiting.bossJobId)).toBeNull();
    expect(await boss.getJobById('copilot_run', afterCancelled.bossJobId)).toMatchObject({
      id: afterCancelled.bossJobId,
      state: 'created',
    });
  });
});
