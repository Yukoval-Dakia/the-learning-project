import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { event, job_events } from '@/db/schema';
import { writeJobEvent } from '@/kernel/job-events';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { findOrCreateCopilotConversation } from '../server/conversation-lifecycle';
import { writeCopilotReply } from '../server/conversation-writes';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { acceptedCopilotDerivationPolicy } from '../server/derivation-policy';
import {
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from '../server/durable-dispatch';
import { recordRetryToolEffect } from '../server/run-retry';
import { getCopilotTurnsBeforeAnchor, getRecentCopilotTurns } from '../server/turns';
import { POST } from './retry-run';

let boss: PgBoss;
beforeAll(async () => {
  _resetBossForTests();
  boss = await getStartedBoss();
  if (!(await boss.getQueue('copilot_run'))) await boss.createQueue('copilot_run');
});
beforeEach(async () => {
  await resetDb();
  await testDb().delete(job_events);
  await boss.deleteAllJobs('copilot_run');
});
afterAll(async () => {
  await boss.stop();
  _resetBossForTests();
});

// @invariant concurrency: one failed turn can acquire only one replacement execution, and a turn that started a write cannot acquire any.
// @fails-if concurrent retries duplicate paid work or user messages, bypass a write fence, or expose the replaced failure in subsequent model history.
it('admits one replacement under concurrent retries and refuses a write-fenced failure', async () => {
  const { sessionId } = await findOrCreateCopilotConversation(testDb(), { now: new Date() });
  const jobData = { user_message: '请解释一次函数的斜率。', triggered_by: 'chat' as const };
  const accepted = await reserveCopilotDurableAcceptance(
    testDb(),
    {
      sessionId,
      userMessage: jobData.user_message,
      inputHash: hashCopilotDurableInput(jobData),
      idempotencyKey: randomUUID(),
      queuedPayload: { session_id: sessionId },
      jobData,
    },
    { boss, transactionDb: fromPgBossDrizzleTx },
  );
  const runId = accepted.acceptance.runId;
  const prose = {
    version: 1 as const,
    text: '连接断了一下，这次没答完。',
    status: 'failed' as const,
    last_event_id: 0,
    failure: { kind: 'connection' as const },
  };
  await writeCopilotReply(testDb(), {
    sessionId,
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
  const failedTurns = await getRecentCopilotTurns(testDb(), { sessionId });
  expect(failedTurns.find((turn) => turn.run_id === runId)?.retryable).toBe(true);
  const request = (id: string, key: string) =>
    POST(
      new Request(`http://local/api/copilot/runs/${id}/retry`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      }),
      { id },
    );
  const responses = await Promise.all([request(runId, 'click-a'), request(runId, 'click-b')]);
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
});
