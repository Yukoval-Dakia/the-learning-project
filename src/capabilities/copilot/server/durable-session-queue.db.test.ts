import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copilotCapability } from '@/capabilities/copilot/manifest';
import { job_events } from '@/db/schema';
import * as agentRunner from '@/server/ai/runner';
import { _resetBossForTests, fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { registerCapabilityJobs } from '@/server/boss/register-capability-jobs';
import { writeJobEvent } from '@/server/events/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import * as runtimeEnv from '@/server/runtime-env';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as sendMessage } from '../api/chat';
import { CopilotDurableRunResponseSchema, CopilotTurnsResponseSchema } from '../api/contracts';
import { GET as readConversation } from '../api/turns';
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

describe('durable Copilot session FIFO — real pg-boss contract', () => {
  it('returns frozen policy through real 202, pending snapshot, same-key retry and changed-policy conflict', async () => {
    vi.spyOn(runtimeEnv, 'shouldEnqueueBackgroundJobs').mockReturnValue(true);
    const key = randomUUID();
    const body = {
      user_message: '假设椭圆参数退化，先核对边界与反例；本条只作临时讨论。',
      triggered_by: 'chat',
      derivation_policy: 'answer_only',
    };
    const request = (value: unknown) =>
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(value),
      });
    const first = await sendMessage(request(body), {});
    expect(first.status).toBe(202);
    const accepted = CopilotDurableRunResponseSchema.parse(await first.json());
    expect(accepted.derivation_policy).toBe('answer_only');
    const snapshot = CopilotTurnsResponseSchema.parse(
      await (
        await readConversation(
          new Request(`http://test/api/copilot/turns?session_id=${accepted.session_id}`),
        )
      ).json(),
    );
    expect(snapshot.turns[0]?.derivation_policy).toBe('answer_only');
    expect(snapshot.active_runs[0]?.derivation_policy).toBe('answer_only');
    const retry = await sendMessage(request(body), {});
    expect(retry.status).toBe(202);
    expect(CopilotDurableRunResponseSchema.parse(await retry.json())).toEqual(accepted);
    const changed = await sendMessage(request({ ...body, derivation_policy: 'allow' }), {});
    expect(changed.status).toBe(409);
    expect(
      await boss.findJobs('copilot_run', { data: { session_id: accepted.session_id } }),
    ).toHaveLength(1);
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
