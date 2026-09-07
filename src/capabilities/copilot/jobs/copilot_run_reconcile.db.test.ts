import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { JobWithMetadata, QueueStats } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCopilotReply } from '@/capabilities/copilot/server/conversation-writes';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import { countOutstandingDurableRuns } from '@/capabilities/copilot/server/durable-backlog';
import {
  type CopilotDurableAcceptance,
  reserveCopilotDurableAcceptance,
} from '@/capabilities/copilot/server/durable-dispatch';
import {
  recordNativeSubagentStarted,
  settleNativeSubagentRun,
} from '@/capabilities/copilot/server/subagent-mailbox';
import { copilot_continuation, event, job_events, subagent_run } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedLegacySubagentRun } from '../../../../tests/helpers/legacy-subagent';
import { DURABLE_OWNER_SETTLEMENT_BUDGET_MS } from './copilot_run';
import {
  type CopilotRunReconcileBoss,
  reconcileOutstandingCopilotRuns,
} from './copilot_run_reconcile';

const NOW = new Date('2026-08-01T15:00:00.000Z');
const richRequest =
  '核对近 45 天 48 条作答、6 个未教学探针与 3 份讲义，按定义域遗漏、退化分支和单位方向交叉聚证，再生成 9 道迁移题并校验唯一解。';

async function seedAcceptedRun(
  label: string,
  sessionId = `conversation_${label}`,
): Promise<CopilotDurableAcceptance> {
  const result = await reserveCopilotDurableAcceptance(testDb(), {
    sessionId,
    userMessage: `${richRequest} [${label}]`,
    inputHash: `sha256_${label}`,
    idempotencyKey: randomUUID(),
    queuedPayload: {
      session_id: sessionId,
      triggered_by: 'chat',
      pickup_deadline_ms: NOW.getTime() - 20_000,
      dispatch: {
        source: 'model_triage',
        reason_code: 'multi_artifact_work',
        task_run_id: `dispatch_${label}`,
      },
    },
  });
  return result.acceptance;
}

function fakeJob(id: string, state: JobWithMetadata['state']): JobWithMetadata {
  return { id, state } as JobWithMetadata;
}

function mappedBoss(
  states: Map<string, JobWithMetadata['state'] | 'missing' | 'unknown'>,
  activeCount: number,
): CopilotRunReconcileBoss {
  return {
    send: vi.fn(async () => null),
    getJobById: vi.fn(async (_queue, id) => {
      const state = states.get(id) ?? 'missing';
      if (state === 'unknown') throw new Error(`queue lookup unavailable for ${id}`);
      return state === 'missing' ? null : fakeJob(id, state);
    }),
    getQueueStats: vi.fn(async () => [
      {
        name: 'copilot_run',
        deferredCount: 0,
        queuedCount: states.size - activeCount,
        readyCount: states.size - activeCount,
        activeCount,
        failedCount: 0,
        totalCount: states.size,
        capturedOn: NOW,
      } satisfies QueueStats,
    ]),
  };
}

async function eventsFor(runId: string) {
  return testDb()
    .select()
    .from(job_events)
    .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)))
    .orderBy(asc(job_events.id));
}

describe('copilot_run_reconcile (YUK-596)', () => {
  beforeEach(async () => {
    await resetDb();
    // job_events is intentionally outside resetDb's domain-table whitelist.
    await testDb().delete(job_events);
    await testDb().delete(copilot_continuation);
    await testDb().delete(subagent_run);
  });
  afterEach(async () => {
    await testDb().delete(copilot_continuation);
    await testDb().delete(subagent_run);
    await testDb().delete(job_events);
  });

  it.each(['done', 'cancelled', 'marker'] as const)(
    'repairs native children after parent %s without replaying the model or touching a live sibling',
    async (terminalKind) => {
      const parent = await seedAcceptedRun(`native_orphan_${terminalKind}`);
      const live = await seedAcceptedRun(`native_live_${terminalKind}`, parent.sessionId);
      const native = await recordNativeSubagentStarted(testDb(), {
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        parentTaskRunId: `copilot_run_tool_${parent.runId}`,
        sdkTaskId: 'native_missing_terminal',
        objective: richRequest,
      });
      const liveNative = await recordNativeSubagentStarted(testDb(), {
        sessionId: live.sessionId,
        parentTurnEventId: live.runId,
        parentTaskRunId: `copilot_run_tool_${live.runId}`,
        sdkTaskId: 'native_still_running',
        objective: richRequest,
      });
      if (!native || !liveNative) throw new Error('native child fixtures were not admitted');
      const retry = await recordNativeSubagentStarted(testDb(), {
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        parentTaskRunId: `copilot_run_tool_${parent.runId}_retry_2`,
        sdkTaskId: 'native_retry_missing',
        objective: richRequest,
      });
      const completed = await recordNativeSubagentStarted(testDb(), {
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        parentTaskRunId: `copilot_run_tool_${parent.runId}`,
        sdkTaskId: 'native_already_completed',
        objective: richRequest,
      });
      if (!retry || !completed) throw new Error('additional native fixtures were not admitted');
      await settleNativeSubagentRun(testDb(), {
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        sdkTaskId: 'native_already_completed',
        outcome: {
          status: 'succeeded',
          result: '已逐条核对定义域、退化分支和单位方向，缺失材料仍标为未知。',
        },
      });
      const legacy = await seedLegacySubagentRun(testDb(), {
        status: 'running',
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        parentTaskRunId: `copilot_run_tool_${parent.runId}`,
        launchKey: 'legacy_claimed_research',
        objective: richRequest,
      });
      if (terminalKind === 'marker') {
        await writeCopilotReply(testDb(), {
          sessionId: parent.sessionId,
          userAskEventId: parent.runId,
          replyText: '已核对已有证据；尚不能确认缺失材料中的结论。',
          actorRef: 'agent:copilot',
          taskRunId: `copilot_run_tool_${parent.runId}`,
          outcome: 'success',
          now: NOW,
        });
      } else {
        await writeJobEvent(testDb(), {
          business_table: COPILOT_RUN_TABLE,
          business_id: parent.runId,
          event_type: terminalKind === 'done' ? COPILOT_RUN_EVENTS.DONE : COPILOT_RUN_EVENTS.FAILED,
          payload:
            terminalKind === 'cancelled'
              ? { reason: 'cancelled' }
              : { task_run_id: `copilot_run_tool_${parent.runId}` },
        });
      }
      const boss = mappedBoss(new Map([[live.bossJobId, 'active']]), 1);
      await reconcileOutstandingCopilotRuns(testDb(), { now: NOW, boss });
      const [closed] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, native.id));
      expect(closed?.status).toBe(terminalKind === 'cancelled' ? 'cancelled' : 'lost');
      expect(closed?.settled_event_id).toBeTruthy();
      const [unchanged] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, liveNative.id));
      expect(unchanged?.status).toBe('running');
      expect(unchanged?.settled_event_id).toBeNull();
      const [repairedRetry] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, retry.id));
      expect(repairedRetry?.status).toBe(closed?.status);
      const [completedRow] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, completed.id));
      expect(completedRow?.status).toBe('succeeded');
      const [legacyRow] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, legacy.record.id));
      expect(legacyRow?.status).toBe('running');
      expect(legacyRow?.claim_token).toBeTruthy();
      expect(
        await recordNativeSubagentStarted(testDb(), {
          sessionId: parent.sessionId,
          parentTurnEventId: parent.runId,
          parentTaskRunId: `copilot_run_tool_${parent.runId}`,
          sdkTaskId: 'late_new_native',
          objective: richRequest,
        }),
      ).toBeNull();
      await settleNativeSubagentRun(testDb(), {
        sessionId: parent.sessionId,
        parentTurnEventId: parent.runId,
        sdkTaskId: 'native_missing_terminal',
        outcome: { status: 'succeeded', result: '迟到消息不能重写父终态收口。' },
      });
      await reconcileOutstandingCopilotRuns(testDb(), { now: NOW, boss });
      expect(
        await testDb().select().from(subagent_run).where(eq(subagent_run.id, native.id)),
      ).toEqual([closed]);
      expect(await testDb().select().from(copilot_continuation)).toEqual([]);
      expect(
        await testDb()
          .select()
          .from(event)
          .where(
            and(
              eq(event.session_id, parent.sessionId),
              eq(event.action, 'experimental:subagent_run_settled'),
            ),
          ),
      ).toHaveLength(3);
      expect(boss.send).not.toHaveBeenCalled();
    },
  );

  it('converges a realistic mixed backlog without model/tool re-execution', async () => {
    const terminal = await seedAcceptedRun('already_done_48_answers');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: terminal.runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: 'tr_already_done' },
    });

    const retrying = await seedAcceptedRun('retry_after_31_answers');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: retrying.runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'error',
        error: 'provider reset after validating 31 of 48 answers and four of six probes',
      },
    });

    const legacyRetryDead = await seedAcceptedRun('legacy_paid_retry_frame_now_missing');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: legacyRetryDead.runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'error',
        error: 'legacy handler lost the provider connection after paid model/tool execution',
      },
    });
    await testDb()
      .update(job_events)
      .set({
        occurred_at: new Date(NOW.getTime() - DURABLE_OWNER_SETTLEMENT_BUDGET_MS - 60_000),
      })
      .where(
        and(
          eq(job_events.business_id, legacyRetryDead.runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.FAILED),
        ),
      );

    const waiting = await seedAcceptedRun('waiting_behind_active_transfer_audit');

    const repairable = await seedAcceptedRun('success_marker_projection_gap');
    await writeCopilotReply(testDb(), {
      sessionId: repairable.sessionId,
      userAskEventId: repairable.runId,
      replyText: '已完成 48 条作答聚证与 9 道迁移题的交叉校验。',
      actorRef: 'agent:copilot',
      taskRunId: 'tr_repairable_success',
      outcome: 'success',
      durableFinishReason: 'end_turn',
      now: new Date(NOW.getTime() - 60_000),
    });

    const preExecutionDead = await seedAcceptedRun('malformed_delivery_before_execution');

    const staleFence = await seedAcceptedRun('lost_paid_outcome_after_six_probes');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: staleFence.runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });
    await testDb()
      .update(job_events)
      .set({
        occurred_at: new Date(NOW.getTime() - DURABLE_OWNER_SETTLEMENT_BUDGET_MS - 60_000),
      })
      .where(
        and(
          eq(job_events.business_id, staleFence.runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.EXECUTION_STARTED),
        ),
      );

    const freshFence = await seedAcceptedRun('fresh_execution_owner_settling');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: freshFence.runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });
    await testDb()
      .update(job_events)
      .set({ occurred_at: new Date(NOW.getTime() - 60_000) })
      .where(
        and(
          eq(job_events.business_id, freshFence.runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.EXECUTION_STARTED),
        ),
      );

    const unknown = await seedAcceptedRun('queue_observation_unknown');
    const states = new Map<string, JobWithMetadata['state'] | 'missing' | 'unknown'>([
      [retrying.bossJobId, 'retry'],
      [legacyRetryDead.bossJobId, 'failed'],
      [waiting.bossJobId, 'created'],
      [repairable.bossJobId, 'completed'],
      [preExecutionDead.bossJobId, 'failed'],
      [staleFence.bossJobId, 'missing'],
      [freshFence.bossJobId, 'failed'],
      [unknown.bossJobId, 'unknown'],
    ]);
    const boss = mappedBoss(states, 1);

    const report = await reconcileOutstandingCopilotRuns(testDb(), { now: NOW, boss });

    expect(report).toEqual({
      scanned: 8,
      observations: {
        settled: 0,
        projection_repaired: 1,
        queued: 0,
        waiting_on_active_run: 1,
        pickup_unavailable: 0,
        retrying: 1,
        running: 0,
        execution_settling: 1,
        pre_execution_lost: 1,
        ambiguous_execution: 2,
        unknown: 1,
      },
      failed: 0,
    });

    expect((await eventsFor(repairable.runId)).at(-1)).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: 'tr_repairable_success' },
    });
    expect((await eventsFor(preExecutionDead.runId)).at(-1)).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'pre_execution_lost',
        checkpoint_event_id: preExecutionDead.runId,
      },
    });
    expect((await eventsFor(staleFence.runId)).at(-1)).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'ambiguous_execution' },
    });
    expect((await eventsFor(staleFence.runId)).at(-1)?.payload).not.toHaveProperty(
      'checkpoint_event_id',
    );
    expect((await eventsFor(legacyRetryDead.runId)).at(-1)).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'ambiguous_execution' },
    });
    expect((await eventsFor(legacyRetryDead.runId)).at(-1)?.payload).not.toHaveProperty(
      'checkpoint_event_id',
    );
    expect((await eventsFor(unknown.runId)).some((row) => row.event_type.endsWith('.failed'))).toBe(
      false,
    );
    expect(await countOutstandingDurableRuns(testDb())).toBe(4);

    const terminalReplies = await testDb()
      .select({ causedBy: event.caused_by_event_id, payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:copilot_reply'));
    expect(terminalReplies.filter((row) => row.causedBy === preExecutionDead.runId)).toHaveLength(
      1,
    );
    expect(terminalReplies.filter((row) => row.causedBy === staleFence.runId)).toHaveLength(1);
    expect(terminalReplies.filter((row) => row.causedBy === legacyRetryDead.runId)).toHaveLength(1);

    // A second sweep is idempotent: repaired/settled runs are filtered before
    // LIMIT and no second domain reply or terminal frame is appended.
    const second = await reconcileOutstandingCopilotRuns(testDb(), { now: NOW, boss });
    expect(second.scanned).toBe(4);
    const repliesAfterSecond = await testDb()
      .select({ causedBy: event.caused_by_event_id })
      .from(event)
      .where(eq(event.action, 'experimental:copilot_reply'));
    expect(
      repliesAfterSecond.filter((row) => row.causedBy === preExecutionDead.runId),
    ).toHaveLength(1);
    expect(repliesAfterSecond.filter((row) => row.causedBy === staleFence.runId)).toHaveLength(1);
    expect(repliesAfterSecond.filter((row) => row.causedBy === legacyRetryDead.runId)).toHaveLength(
      1,
    );
  });

  it('filters a terminal prefix before LIMIT so a later dead delivery is not starved', async () => {
    for (let index = 0; index < 6; index++) {
      const done = await seedAcceptedRun(`retained_terminal_prefix_${index}`);
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: done.runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'exhausted', error: `settled prefix ${index}` },
      });
    }
    const stranded = await seedAcceptedRun('later_pre_execution_gap');
    const boss = mappedBoss(new Map([[stranded.bossJobId, 'missing']]), 0);

    const report = await reconcileOutstandingCopilotRuns(testDb(), { now: NOW, boss, limit: 1 });
    expect(report).toMatchObject({ scanned: 1, observations: { pre_execution_lost: 1 } });
    expect(
      (await eventsFor(stranded.runId)).find((row) => row.event_type === COPILOT_RUN_EVENTS.FAILED)
        ?.payload,
    ).toMatchObject({
      reason: 'pre_execution_lost',
    });
  });
});
