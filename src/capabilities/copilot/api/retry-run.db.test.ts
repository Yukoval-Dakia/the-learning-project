import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { artifact, event, job_events } from '@/db/schema';
import * as runtimeEnv from '@/kernel/background-job-enqueue';
import { writeJobEvent } from '@/kernel/job-events';
import { __resetRateLimitForTests, checkRateLimit } from '@/kernel/request-rate-limit';
import { executeDomainToolCall } from '@/server/ai/tools/mcp-bridge';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getTool } from '@/server/ai/tools/registry';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { revertCopilotCheckpoint } from '../server/checkpoint-revert-operation';
import {
  abandonConversation,
  createCopilotConversation,
  endConversation,
  findOrCreateCopilotConversation,
} from '../server/conversation-lifecycle';
import { writeCopilotReply } from '../server/conversation-writes';
import { createCopilotExecutionOwner } from '../server/copilot-execution';
import { createCopilotRunCancellationControl } from '../server/copilot-run-cancellation';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { acceptedCopilotDerivationPolicy } from '../server/derivation-policy';
import {
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from '../server/durable-dispatch';
import { durableCheckpointPayload } from '../server/materializing-tools';
import { recordRetryToolEffect } from '../server/run-retry';
import { getCopilotTurnsBeforeAnchor, getRecentCopilotTurns } from '../server/turns';
import { POST } from './retry-run';

let boss: PgBoss;
beforeAll(async () => {
  await registerCapabilityTools(capabilities);
  _resetBossForTests();
  boss = await getStartedBoss();
  if (!(await boss.getQueue('copilot_run'))) await boss.createQueue('copilot_run');
});
beforeEach(async () => {
  vi.spyOn(runtimeEnv, 'shouldEnqueueBackgroundJobs').mockReturnValue(true);
  __resetRateLimitForTests();
  await resetDb();
  await testDb().delete(job_events);
  await boss.deleteAllJobs('copilot_run');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await testDb().execute(sql`DROP TRIGGER IF EXISTS copilot_insert_gate ON event`);
  await testDb().execute(sql`DROP TRIGGER IF EXISTS copilot_insert_gate ON job_events`);
  await testDb().execute(sql`DROP FUNCTION IF EXISTS copilot_insert_gate()`);
});
afterAll(async () => {
  await boss.stop();
  _resetBossForTests();
});

async function request(id: string, key: string = randomUUID()) {
  return POST(
    new Request(`http://local/api/copilot/runs/${id}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
    }),
    { id },
  );
}

async function installInsertGate(
  table: 'event' | 'job_events',
  column: 'action' | 'event_type',
  value: string,
) {
  await testDb().execute(
    sql.raw(`CREATE FUNCTION copilot_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.${column} = '${value}' THEN PERFORM pg_advisory_xact_lock(98571, 1); END IF; RETURN NEW; END $$`),
  );
  await testDb().execute(
    sql.raw(
      `CREATE TRIGGER copilot_insert_gate BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION copilot_insert_gate()`,
    ),
  );
}

async function waitForBlocked(count: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [row] = await testDb().execute<{
      count: number;
    }>(sql`SELECT count(*)::int AS count FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted`);
    if (Number(row?.count) >= count) return;
    if (Date.now() >= deadline)
      throw new Error('Expected contenders did not reach the real PG gate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function failedRun(sessionId?: string) {
  const session =
    sessionId ?? (await findOrCreateCopilotConversation(testDb(), { now: new Date() })).sessionId;
  const jobData = { user_message: '请解释一次函数的斜率。', triggered_by: 'chat' as const };
  const result = await reserveCopilotDurableAcceptance(
    testDb(),
    {
      sessionId: session,
      userMessage: jobData.user_message,
      inputHash: hashCopilotDurableInput(jobData),
      idempotencyKey: randomUUID(),
      queuedPayload: { session_id: session },
      jobData,
    },
    { boss, transactionDb: fromPgBossDrizzleTx },
  );
  const runId = result.acceptance.runId;
  const prose = {
    version: 1 as const,
    text: '连接断了一下，这次没答完。',
    status: 'failed' as const,
    last_event_id: 0,
    failure: { kind: 'connection' as const },
  };
  await writeCopilotReply(testDb(), {
    sessionId: session,
    userAskEventId: runId,
    actorRef: 'agent:copilot',
    replyText: prose.text,
    taskRunId: `failed_${runId}`,
    durableFailure: { reason: 'exhausted', error: 'connection' },
    publicProseFailure: prose.failure,
    outcome: 'failure',
    now: new Date(),
  });
  await writeJobEvent(testDb(), {
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: COPILOT_RUN_EVENTS.FAILED,
    payload: { reason: 'exhausted', public_prose: prose },
  });
  return { sessionId: session, runId, jobData, prose };
}

// @invariant concurrency: one failed turn can acquire only one replacement execution, and a turn that started a write cannot acquire any.
// @fails-if concurrent retries duplicate paid work or user messages, bypass a write fence, or expose the replaced failure in subsequent model history.
it('admits one replacement under concurrent retries and refuses a write-fenced failure', async () => {
  const { sessionId, runId, jobData, prose } = await failedRun();
  const failedTurns = await getRecentCopilotTurns(testDb(), { sessionId });
  expect(failedTurns.find((turn) => turn.run_id === runId)?.retryable).toBe(true);
  await installInsertGate('event', 'action', 'experimental:copilot_run_retry');
  let concurrent!: Promise<Response[]>;
  await testDb().transaction(async (gate) => {
    await gate.execute(sql`SELECT pg_advisory_xact_lock(98571, 1)`);
    concurrent = Promise.all([request(runId, 'click-a'), request(runId, 'click-b')]);
    // The second request must wait at the shared admission lock, before any
    // per-run row lock, so chat and retraction use the same serialization point.
    await waitForBlocked(2);
  });
  const responses = await concurrent;
  expect(responses.map((r) => r.status)).toEqual([202, 202]);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(bodies[0].run_id).toBe(bodies[1].run_id);
  const replay = await request(runId, 'click-a');
  expect((await replay.json()).run_id).toBe(bodies[0].run_id);
  expect(
    await testDb()
      .select()
      .from(event)
      .where(
        and(eq(event.session_id, sessionId), eq(event.action, 'experimental:copilot_user_ask')),
      ),
  ).toHaveLength(1);
  expect(
    await testDb().select().from(event).where(eq(event.caused_by_event_id, runId)),
  ).toHaveLength(2);
  const retryId = bodies[0].run_id;
  expect(
    await acceptedCopilotDerivationPolicy(testDb(), {
      ...jobData,
      run_id: retryId,
      session_id: sessionId,
      derivation_policy: 'allow',
    }),
  ).toBe('allow');
  expect(
    (await getRecentCopilotTurns(testDb(), { sessionId })).find((t) => t.role === 'user')
      ?.checkpoint_event_id,
  ).toBeUndefined();
  expect(await durableCheckpointPayload(testDb(), runId)).toEqual({});
  vi.mocked(runtimeEnv.shouldEnqueueBackgroundJobs).mockReturnValue(false);
  expect((await request(runId, 'replay-during-shutdown')).status).toBe(202);
  vi.mocked(runtimeEnv.shouldEnqueueBackgroundJobs).mockReturnValue(true);
  await recordRetryToolEffect(testDb(), retryId, 'write');
  await writeJobEvent(testDb(), {
    business_table: COPILOT_RUN_TABLE,
    business_id: retryId,
    event_type: COPILOT_RUN_EVENTS.FAILED,
    payload: { reason: 'exhausted', public_prose: prose },
  });
  const denied = await request(retryId, 'after-write');
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ details: { reason: 'write_tool_started' } });
  const next = await reserveCopilotDurableAcceptance(testDb(), {
    sessionId,
    userMessage: '下一问',
    inputHash: 'next',
    queuedPayload: { session_id: sessionId },
  });
  const history = await getCopilotTurnsBeforeAnchor(testDb(), {
    sessionId,
    anchorEventId: next.acceptance.runId,
    forModel: true,
  });
  expect(history.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([
    jobData.user_message,
  ]);
  expect(history.some((t) => t.text.includes(prose.text))).toBe(false);
  await endConversation(testDb(), sessionId);
  vi.mocked(runtimeEnv.shouldEnqueueBackgroundJobs).mockReturnValue(false);
  expect((await request(runId, 'replay-after-end')).status).toBe(202);
});

// @invariant concurrency: only a live, unretracted latest failure in an idle session may create new queued work, and the shared admission gates remain effective.
// @fails-if a stale/closed/retracted run creates a successor, an outstanding run is ignored, or shutdown/backlog/rate gates are bypassed.
it.each([
  'ended',
  'abandoned',
  'retracted',
  'not_latest',
  'session_busy',
  'queue_disabled',
  'backlog',
  'rate_limit',
] as const)('refuses new retry when %s', async (condition) => {
  const { sessionId } = await findOrCreateCopilotConversation(testDb(), { now: new Date() });
  if (condition === 'session_busy')
    await reserveCopilotDurableAcceptance(testDb(), {
      sessionId,
      userMessage: '前一问仍在队列',
      inputHash: 'older',
      queuedPayload: { session_id: sessionId },
    });
  const failed = await failedRun(sessionId);
  if (condition === 'ended') await endConversation(testDb(), sessionId);
  if (condition === 'abandoned') await abandonConversation(testDb(), sessionId);
  if (condition === 'retracted')
    expect((await revertCopilotCheckpoint(testDb(), failed.runId)).status).toBe(200);
  if (condition === 'not_latest')
    await reserveCopilotDurableAcceptance(testDb(), {
      sessionId,
      userMessage: '后续问句',
      inputHash: 'later',
      queuedPayload: { session_id: sessionId },
    });
  if (condition === 'queue_disabled')
    vi.mocked(runtimeEnv.shouldEnqueueBackgroundJobs).mockReturnValue(false);
  if (condition === 'backlog')
    for (let index = 0; index < 5; index++) {
      const conversation = await createCopilotConversation(testDb());
      await reserveCopilotDurableAcceptance(testDb(), {
        sessionId: conversation.sessionId,
        userMessage: '其他对话排队',
        inputHash: 'queued',
        queuedPayload: { session_id: conversation.sessionId },
      });
    }
  if (condition === 'rate_limit') for (let index = 0; index < 30; index++) checkRateLimit();
  const response = await request(failed.runId);
  const body = await response.json();
  if (condition === 'queue_disabled') {
    expect(response.status).toBe(503);
    expect(body.error).toBe('copilot_queue_disabled');
  } else if (condition === 'backlog' || condition === 'rate_limit') {
    expect(response.status).toBe(429);
    expect(body.error).toBe(condition === 'backlog' ? 'copilot_backlog_full' : 'rate_limited');
  } else {
    expect(response.status).toBe(409);
    expect(body.details.reason).toBe(
      condition === 'ended' || condition === 'abandoned'
        ? 'conversation_inactive'
        : condition === 'retracted'
          ? 'question_retracted'
          : condition,
    );
  }
  expect(
    await testDb()
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:copilot_run_retry'),
          eq(event.caused_by_event_id, failed.runId),
        ),
      ),
  ).toHaveLength(0);
});

// @invariant concurrency: Stop drains a tool that is persisting its write fence, and that tool cannot execute after cancellation is confirmed.
// @fails-if in-flight registration follows the database write, denial leaves the drain counter occupied, or a cancelled write creates a note.
it('holds the Stop barrier while the write fence is blocked and denies the tool after release', async () => {
  const { sessionId, runId } = await failedRun();
  const cancellation = createCopilotRunCancellationControl({ db: testDb(), runId });
  await installInsertGate('job_events', 'event_type', 'copilot_run.retry_write_started');
  let toolResult: Awaited<ReturnType<typeof executeDomainToolCall>> | undefined;
  const execute = createCopilotExecutionOwner({
    buildExaMcpServerFn: () => null,
    streamTaskCollectingFn: async (_kind, _input, context) => {
      const mount = context.piToolMounts?.find((entry) => entry.type === 'domain');
      const tool = getTool('write_note');
      if (mount?.type !== 'domain' || !tool) throw new Error('Domain tool mount missing');
      toolResult = await executeDomainToolCall(
        tool,
        { mode: 'create', title: '停止后不能写入', markdown: '不能落库' },
        mount.options,
      );
      throw new Error('Offline provider finished');
    },
  });
  let running!: Promise<unknown>;
  try {
    await testDb().transaction(async (gate) => {
      await gate.execute(sql`SELECT pg_advisory_xact_lock(98571, 1)`);
      running = execute(
        testDb(),
        {
          sessionId,
          taskRunId: `stopped_${runId}`,
          sourceEventId: runId,
          input: {
            surface: 'copilot',
            triggered_by: 'chat',
            user_message: '保存一条便笺',
            today: '2026-11-08',
            proposal_feedback: [],
            conversation_history: [],
            correction_contract: {
              prior_turn_order: [],
              restricted_prior_turn_ids: [],
              available_prior_turn_ids: [],
              prior_turn_summaries: {},
              required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
            },
          },
        },
        { cancellation, deadlineAt: Date.now() + 60000, subagentsEnabled: false },
      ).catch((error) => error);
      await waitForBlocked(1);
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: {},
      });
      expect(await cancellation.probe()).toBe('cancel_requested');
      expect(await cancellation.waitForInFlight(0)).toBe(false);
    });
    await running;
    expect(toolResult?.isError).toBe(true);
    expect(JSON.stringify(toolResult)).toContain('cancel requested');
    expect(await cancellation.waitForInFlight(0)).toBe(true);
    expect(
      await testDb().select().from(artifact).where(eq(artifact.title, '停止后不能写入')),
    ).toHaveLength(0);
  } finally {
    cancellation.dispose();
  }
});
