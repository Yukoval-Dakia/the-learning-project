import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { installAgencyHostOperations } from '@/capabilities/agency/public';
import { installPracticeHost } from '@/capabilities/practice/public';
import { artifact, event, job_events } from '@/db/schema';
import * as runtimeEnv from '@/kernel/background-job-enqueue';
import { writeJobEvent } from '@/kernel/job-events';
import { __resetRateLimitForTests, checkRateLimit } from '@/kernel/request-rate-limit';
import { executeDomainToolCall } from '@/server/ai/tools/mcp-bridge';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getTool } from '@/server/ai/tools/registry';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runCopilotRun } from '../jobs/copilot_run';
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
import { writeFailedTerminalProjection } from '../server/copilot-run-settlement';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { acceptedCopilotDerivationPolicy } from '../server/derivation-policy';
import {
  hashCopilotDurableInput,
  parsePersistedJobData,
  reserveCopilotDurableAcceptance,
} from '../server/durable-dispatch';
import { durableCheckpointPayload } from '../server/materializing-tools';
import { recordRetryToolEffect } from '../server/run-retry';
import { getCopilotTurnsBeforeAnchor, getRecentCopilotTurns } from '../server/turns';
import { POST } from './retry-run';

let boss: PgBoss;
beforeAll(async () => {
  await installAgencyHostOperations();
  await installPracticeHost();
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

async function failedRun(sessionId?: string, userMessage = '请解释一次函数的斜率。') {
  const session =
    sessionId ?? (await findOrCreateCopilotConversation(testDb(), { now: new Date() })).sessionId;
  const jobData = { user_message: userMessage, triggered_by: 'chat' as const };
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

// @invariant security: retry quote authorization uses the original learner ask while every executed write and mirror belongs to the replacement run.
// @fails-if missing/foreign quotes write memory, valid original words are refused, a disallowed retry write executes, or write fences/mirrors move to the old ask.
it('authorizes original learner words on retry without moving execution evidence to the old ask', async () => {
  const learnerWords = '叫我小雨';
  const failed = await failedRun(undefined, `记住我的偏好：${learnerWords}。这周别排物理。`);
  const response = await request(failed.runId);
  expect(response.status).toBe(202);
  const { run_id: retryId } = await response.json();
  const [queued] = await testDb()
    .select()
    .from(job_events)
    .where(
      and(
        eq(job_events.business_id, retryId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
      ),
    );
  const data = parsePersistedJobData(queued.payload, retryId, failed.sessionId);
  if (!data) throw new Error('Accepted retry delivery missing');
  const results: Record<string, Awaited<ReturnType<typeof executeDomainToolCall>>> = {};
  await runCopilotRun({
    db: testDb(),
    data,
    copilotSubagentEnabled: false,
    executeCopilotTurnFn: createCopilotExecutionOwner({
      buildExaMcpServerFn: () => null,
      streamTaskCollectingFn: async (_kind, _input, context) => {
        const mount = context.piToolMounts?.find((entry) => entry.type === 'domain');
        if (mount?.type !== 'domain') throw new Error('Domain mount missing');
        const invoke = async (label: string, name: string, input: unknown) => {
          const tool = getTool(name);
          if (!tool) throw new Error(`Tool missing: ${name}`);
          results[label] = await executeDomainToolCall(tool, input, mount.options);
        };
        const patch = {
          key: 'communication',
          name: '沟通偏好',
          description: '',
          body: '叫我小雨',
          memory_kind: 'preference',
        };
        await invoke('missing', 'remember_learner', patch);
        await invoke('foreign', 'remember_learner', { ...patch, learner_words: '请叫我小红' });
        await invoke('remember', 'remember_learner', { ...patch, learner_words: learnerWords });
        await invoke('steering_foreign', 'record_steering', {
          op: 'create',
          learner_words: '改成每天练物理',
          instruction_md: '每天练物理',
        });
        await invoke('steering', 'record_steering', {
          op: 'create',
          learner_words: '这周别排物理',
          instruction_md: '这周别排物理',
        });
        await invoke('unavailable', 'write_note', {
          mode: 'create',
          title: '重发不应创建',
          markdown: '不能落库',
        });
        return {
          task_run_id: retryId,
          text: '',
          finishReason: 'error',
          partial: true,
          error: 'Offline provider connection failure',
          providerFailure: { category: 'connection' },
        };
      },
    }),
  });
  expect(results.missing.isError).toBe(true);
  expect(results.foreign.isError).toBe(true);
  expect(results.remember.isError).toBe(false);
  expect(results.steering_foreign.isError).toBe(true);
  expect(results.steering.isError).toBe(false);
  expect(results.unavailable.isError).toBe(true);
  expect(
    await testDb().select().from(artifact).where(eq(artifact.title, '重发不应创建')),
  ).toHaveLength(0);
  const changes = await testDb()
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:context_change'));
  expect(changes).toHaveLength(1);
  expect(JSON.stringify(changes[0].payload.after)).toContain(learnerWords);
  expect(changes[0].payload.evidence_ids).toContain(failed.runId);
  const mirrors = await testDb().select().from(event).where(eq(event.action, 'tool_use'));
  expect(mirrors.some((row) => row.payload.tool_name === 'remember_learner')).toBe(true);
  expect(mirrors.every((row) => row.caused_by_event_id === retryId)).toBe(true);
  const fences = await testDb()
    .select()
    .from(job_events)
    .where(eq(job_events.event_type, 'copilot_run.retry_write_started'));
  expect(fences.length).toBeGreaterThan(0);
  expect(fences.every((row) => row.business_id === retryId)).toBe(true);
  const refused = await request(retryId);
  expect(refused.status).toBe(409);
  expect((await refused.json()).details.reason).toBe('write_tool_started');
  console.log(
    'retry authorization readback',
    JSON.stringify({
      learner_message: failed.jobData.user_message,
      missing_quote: results.missing.isError,
      foreign_quote: results.foreign.isError,
      valid_quote: results.remember.isError,
      steering_valid_quote: results.steering.isError,
      memory: changes[0].payload.after,
      mirror_roots: [...new Set(mirrors.map((row) => row.caused_by_event_id))],
      failed_run: failed.runId,
      retry_run: retryId,
      write_fence_refusal: 'write_tool_started',
    }),
  );
});

// @invariant data: an eligibility SQL failure cannot erase the authoritative FAILED outcome or make the conversation unreadable.
// @fails-if a timed-out probe aborts FAILED publication, poisons its surrounding transaction, or breaks turns instead of degrading to retryable=false.
it('preserves failure settlement and snapshot when the eligibility SQL probe times out', async () => {
  const failed = await failedRun();
  await testDb()
    .delete(job_events)
    .where(
      and(
        eq(job_events.business_id, failed.runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.FAILED),
      ),
    );
  await testDb().transaction(async (blocker) => {
    await blocker.execute(sql`LOCK TABLE subagent_run IN ACCESS EXCLUSIVE MODE`);
    await testDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '100ms'`);
      await writeFailedTerminalProjection(
        tx,
        {
          runId: failed.runId,
          reason: 'exhausted',
          error: 'connection',
          publicProse: failed.prose,
          checkpointSafe: false,
        },
        [],
      );
      const [terminal] = await tx
        .select()
        .from(job_events)
        .where(
          and(
            eq(job_events.business_id, failed.runId),
            eq(job_events.event_type, COPILOT_RUN_EVENTS.FAILED),
          ),
        );
      expect(terminal.payload).toMatchObject({
        reason: 'exhausted',
        retryable: false,
        public_prose: failed.prose,
      });
      const snapshot = await getRecentCopilotTurns(tx, { sessionId: failed.sessionId });
      expect(snapshot.map((turn) => turn.role)).toEqual(['user', 'ai']);
      expect(snapshot.find((turn) => turn.run_id === failed.runId)?.retryable).toBe(false);
      await tx.execute(sql`SELECT 1`);
    });
  });
  expect(
    (await getRecentCopilotTurns(testDb(), { sessionId: failed.sessionId })).find(
      (turn) => turn.run_id === failed.runId,
    )?.retryable,
  ).toBe(true);
});
