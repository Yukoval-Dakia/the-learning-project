import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessment_submission, event, job_events } from '@/db/schema';
import * as runtimeEnv from '@/kernel/background-job-enqueue';
import { writeJobEvent } from '@/kernel/job-events';
import { __resetRateLimitForTests } from '@/kernel/request-rate-limit';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { nativeSoloHttpFixture } from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as sendMessage } from '../api/chat';
import { writeCopilotInputEvent } from './conversation-writes';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  type CopilotAcceptedJobData,
  type CopilotDurableAcceptance,
  dispatchSessionHead,
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from './durable-dispatch';

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
  policy?: 'allow' | 'answer_only',
): Promise<CopilotDurableAcceptance> {
  const jobData = { ...richJobData(label), ...(policy ? { derivation_policy: policy } : {}) };
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

describe('durable Copilot session FIFO — real pg-boss contract', () => {
  // @invariant security: restricted chat attachments cannot create formal submissions or assistance evidence
  // @fails-if answer-only intake writes an event, submission or queue job before rejecting
  it('rejects answer-only review attachments before formal submission or assistance capture while preserving allow intake', async () => {
    vi.spyOn(runtimeEnv, 'shouldEnqueueBackgroundJobs').mockReturnValue(true);
    const fixture = await nativeSoloHttpFixture(testDb());
    const reviewAnswer = {
      authorize_submission: true as const,
      question_id: fixture.id,
      assessment: fixture.assessment,
      reasoning_trace: '仅探索控制变量、证据不足和例外分支，不能推断独立掌握。'.repeat(30),
    };
    const beforeEvents = await testDb().select().from(event);
    const beforeSubmissions = await testDb().select().from(assessment_submission);
    const request = (policy: 'allow' | 'answer_only') =>
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({
          triggered_by: 'chat',
          user_message: '原件仅用于本次探索，不保存学习证据。',
          derivation_policy: policy,
          review_answer: reviewAnswer,
        }),
      });
    expect((await sendMessage(request('answer_only'), {})).status).toBe(400);
    await expect(
      writeCopilotInputEvent(testDb(), {
        sessionId: SESSION_ID,
        userMessage: '独立 writer 也不能绕过用途边界。',
        derivationPolicy: 'answer_only',
        reviewAnswer,
        now: new Date(),
      }),
    ).rejects.toThrow('answer_only');
    expect(await testDb().select().from(assessment_submission)).toEqual(beforeSubmissions);
    expect(await testDb().select().from(event)).toEqual(beforeEvents);
    expect(await testDb().select().from(job_events)).toEqual([]);
    expect(await boss.findJobs('copilot_run')).toEqual([]);
    expect((await sendMessage(request('allow'), {})).status).toBe(202);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(
      beforeSubmissions.length + 1,
    );
  });

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

  afterEach(async () => {
    vi.restoreAllMocks();
    await boss.deleteAllJobs('copilot_run');
    // resetDb resets domain tables, not the operational event ledger. Leaving
    // the last queued successor here contaminates later global backlog tests
    // when Vitest reuses this fork/database for another file.
    await testDb().delete(job_events);
  });

  afterAll(async () => {
    await boss.deleteAllJobs('copilot_run').catch(() => undefined);
    await boss.stop({ graceful: false, timeout: 1_000 });
    _resetBossForTests();
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
});
