import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copilot_continuation, event, job_events, subagent_run } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedLegacySubagentRun } from '../../../../tests/helpers/legacy-subagent';
import { writeCopilotReply } from './conversation-writes';
import { createCopilotExecutionOwner } from './copilot-execution';
import { createCopilotRunCancellationControl } from './copilot-run-cancellation';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import * as mailbox from './subagent-mailbox';
import type { CopilotTaskLifecycleMessage } from './subagents';

// These operational tables are intentionally outside resetDb's domain list.
async function clearMailboxFixtures() {
  await testDb().delete(copilot_continuation);
  await testDb().delete(subagent_run);
  await testDb().delete(job_events);
}
beforeEach(clearMailboxFixtures);
afterEach(clearMailboxFixtures);

async function seedParent(input: { id: string; sessionId: string; action?: string }) {
  await writeEvent(testDb(), {
    id: input.id,
    session_id: input.sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: input.action ?? 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: input.id,
    outcome: null,
    payload: { user_message: 'Compare two long derivations and verify every causal claim.' },
  });
}

describe('Copilot subagent mailbox', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each(['start', 'terminal'] as const)(
    'fences concurrent native %s behind the parent outcome commit',
    async (delivery) => {
      const sessionId = `native_fenced_${delivery}`;
      const parentTurnEventId = `ask_fenced_${delivery}`;
      const parentTaskRunId = `root_fenced_${delivery}`;
      await seedParent({ id: parentTurnEventId, sessionId });
      const started = await mailbox.recordNativeSubagentStarted(testDb(), {
        sessionId,
        parentTurnEventId,
        parentTaskRunId,
        sdkTaskId: 'native_original',
        objective: '交叉核对三份材料的来源、反例和未覆盖边界，逐项保留不确定性。',
      });
      if (!started) throw new Error('native fixture was not admitted');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const parentCommit = testDb().transaction(async (tx) => {
        await acquireCopilotExecutionSettlementLock(tx, parentTurnEventId);
        await writeCopilotReply(tx, {
          sessionId,
          userAskEventId: parentTurnEventId,
          taskRunId: parentTaskRunId,
          actorRef: 'agent:copilot',
          replyText: '已停止这次运行。',
          outcome: 'failure',
          durableFailure: { reason: 'cancelled', error: 'owner requested Stop' },
          now: new Date(),
        });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const late =
        delivery === 'start'
          ? mailbox.recordNativeSubagentStarted(testDb(), {
              sessionId,
              parentTurnEventId,
              parentTaskRunId,
              sdkTaskId: 'native_late_new',
              objective: '迟到的创建不应在已提交父终态后继续写入。',
            })
          : mailbox.settleNativeSubagentRun(testDb(), {
              sessionId,
              parentTurnEventId,
              sdkTaskId: 'native_original',
              outcome: { status: 'succeeded', result: '迟到的成功消息不能覆盖已取消的父回合。' },
            });
      try {
        await vi.waitFor(
          async () => {
            const waiters = await testDb().execute(sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory' AND state = 'active'`);
            expect(waiters.length).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 10 },
        );
      } finally {
        release.resolve();
        await parentCommit;
        await Promise.allSettled([late]);
      }
      const lateResult = await late;
      if (delivery === 'start') expect(lateResult).toBeNull();
      else expect(lateResult?.status).toBe('cancelled');
      await mailbox.reconcileNativeSubagentsForParent(testDb(), sessionId, parentTurnEventId);
      const rows = await testDb().select().from(subagent_run);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('cancelled');
      expect(await testDb().select().from(copilot_continuation)).toEqual([]);
      expect(
        await testDb()
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:subagent_run_settled')),
      ).toHaveLength(1);
    },
  );

  it.each(['failed', 'cancelled', 'completed'] as const)(
    'settles a missing native terminal when its parent %s, without reopening on late SDK events',
    async (parentOutcome) => {
      const sessionId = `session_missing_native_${parentOutcome}`;
      const sourceEventId = `ask_missing_native_${parentOutcome}`;
      const taskRunId = `root_missing_native_${parentOutcome}`;
      await seedParent({ id: sourceEventId, sessionId });
      let cancellationRequested = false;
      const cancellation = createCopilotRunCancellationControl({
        db: testDb(),
        runId: sourceEventId,
        readCancelRequestFn: async () => cancellationRequested,
      });
      let lateTaskEvent:
        | ((message: CopilotTaskLifecycleMessage) => void | Promise<void>)
        | undefined;
      const started: CopilotTaskLifecycleMessage = {
        type: 'system',
        subtype: 'task_started',
        session_id: sessionId,
        uuid: '00000000-0000-4000-8000-000000000978',
        task_id: 'native_missing_terminal',
        subagent_type: 'copilot-researcher',
        description: '核对三份长材料的相互矛盾、缺失证据和适用边界。',
      };
      const execute = createCopilotExecutionOwner({
        buildMcpServerFn: () => ({ type: 'sdk', name: 'loom' }) as never,
        buildTavilyMcpServerFn: () => null,
        resolveCopilotSkillsFn: async () => undefined,
        streamTaskCollectingFn: async (_kind, _input, ctx) => {
          if (!ctx.onTaskEvent) throw new Error('native lifecycle not mounted');
          await ctx.sdkSession?.onSessionId?.('sdk_missing_native_terminal');
          lateTaskEvent = ctx.onTaskEvent;
          await ctx.onTaskEvent(started);
          if (parentOutcome === 'cancelled') {
            cancellationRequested = true;
            await cancellation.probe();
          }
          if (parentOutcome !== 'completed') throw new Error('synthetic parent stream exit');
          return {
            task_run_id: taskRunId,
            text: '本轮核对已结束。',
            terminalText: '本轮核对已结束。',
            partial: false,
          };
        },
      });
      const result = execute(
        testDb(),
        {
          sessionId,
          sourceEventId,
          taskRunId,
          input: {
            surface: 'copilot',
            triggered_by: 'chat',
            user_message: '核对三份材料的矛盾与证据边界。',
            proposal_feedback: [],
            conversation_history: [],
            validator_context_history: [],
            correction_contract: {
              available_prior_turn_ids: [],
              prior_turn_summaries: {},
              required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
            },
          },
        },
        { cancellation, deadlineAt: Date.now() + 60_000, subagentsEnabled: true },
      );
      if (parentOutcome === 'completed') expect((await result).sdkSessionId).toBeUndefined();
      else await expect(result).rejects.toThrow('synthetic parent stream exit');
      const provisional = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.session_id, sessionId));
      expect(provisional[0]?.status).toBe('running');
      expect(provisional[0]?.settled_event_id).toBeNull();
      await writeCopilotReply(testDb(), {
        sessionId,
        userAskEventId: sourceEventId,
        taskRunId,
        actorRef: 'agent:copilot',
        replyText: '本轮核对已结束。',
        outcome: parentOutcome === 'completed' ? 'success' : 'failure',
        ...(parentOutcome === 'completed'
          ? {}
          : {
              durableFailure: {
                reason:
                  parentOutcome === 'cancelled' ? ('cancelled' as const) : ('exhausted' as const),
                error: 'synthetic parent stream exit',
              },
            }),
        now: new Date(),
      });
      await mailbox.reconcileNativeSubagentsForParent(testDb(), sessionId, sourceEventId);
      const rows = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.session_id, sessionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe(parentOutcome === 'cancelled' ? 'cancelled' : 'lost');
      expect(rows[0]?.settled_event_id).toBeTruthy();
      await lateTaskEvent?.({
        type: 'system',
        subtype: 'task_notification',
        session_id: sessionId,
        uuid: '00000000-0000-4000-8000-000000000979',
        task_id: started.task_id,
        status: 'completed',
        output_file: '/private/synthetic-child.txt',
        summary: 'Late result cannot change committed status.',
      });
      await lateTaskEvent?.({ ...started, task_id: 'late_new_native_task' });
      expect(
        await testDb().select().from(subagent_run).where(eq(subagent_run.session_id, sessionId)),
      ).toEqual(rows);
      expect(await testDb().select().from(copilot_continuation)).toEqual([]);
      expect(
        await testDb()
          .select()
          .from(event)
          .where(
            and(
              eq(event.session_id, sessionId),
              eq(event.action, 'experimental:subagent_run_settled'),
            ),
          ),
      ).toHaveLength(1);
      cancellation.dispose();
    },
  );

  it('settles a hidden native terminal independently of public activity delivery', async () => {
    const sessionId = 'session_hidden_native';
    const sourceEventId = 'ask_hidden_native';
    await seedParent({ id: sourceEventId, sessionId });
    const observe = vi.fn(() => {
      throw new Error('disconnected activity consumer');
    });
    const execute = createCopilotExecutionOwner({
      buildMcpServerFn: () => ({ type: 'sdk', name: 'loom' }) as never,
      buildTavilyMcpServerFn: () => null,
      resolveCopilotSkillsFn: async () => undefined,
      streamTaskCollectingFn: async (_kind, _input, ctx) => {
        if (!ctx.onTaskEvent) throw new Error('native lifecycle not mounted');
        await ctx.onTaskEvent({
          type: 'system',
          subtype: 'task_started',
          session_id: sessionId,
          uuid: '00000000-0000-4000-8000-000000000031',
          task_id: 'native_hidden_31',
          subagent_type: 'copilot-researcher',
          description: '核对三份长材料的矛盾、缺失证据和适用边界。',
        });
        await ctx.onTaskEvent({
          type: 'system',
          subtype: 'task_notification',
          session_id: sessionId,
          uuid: '00000000-0000-4000-8000-000000000032',
          task_id: 'native_hidden_31',
          status: 'completed',
          skip_transcript: true,
          output_file: '/private/synthetic-child.txt',
          summary: 'Hidden child result must settle without becoming public activity.',
        });
        return {
          task_run_id: 'root_hidden_native',
          text: '已完成核对。',
          terminalText: '已完成核对。',
          partial: false,
        };
      },
    });
    await execute(
      testDb(),
      {
        sessionId,
        sourceEventId,
        taskRunId: 'root_hidden_native',
        input: {
          surface: 'copilot',
          triggered_by: 'chat',
          user_message: '核对三份材料的矛盾与证据边界。',
          proposal_feedback: [],
          conversation_history: [],
          validator_context_history: [],
          correction_contract: {
            available_prior_turn_ids: [],
            prior_turn_summaries: {},
            required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
          },
        },
      },
      {
        cancellation: createCopilotRunCancellationControl({ db: testDb(), runId: sourceEventId }),
        deadlineAt: Date.now() + 60_000,
        subagentsEnabled: true,
        observe,
      },
    );
    const rows = await testDb().select().from(subagent_run);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      parent_task_run_id: 'root_hidden_native',
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(copilot_continuation)).toEqual([]);
  });

  it('cancels only the exact root owner and its numbered retry task runs', async () => {
    await seedParent({ id: 'ask_parent_cancel', sessionId: 'session_parent_cancel' });
    const parentTaskRunId = 'copilot_run_tool_parent_cancel';
    const direct = await seedLegacySubagentRun(testDb(), {
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId,
      launchKey: 'direct-owner',
      objective: 'Cancel this queued direct child through its root owner.',
    });
    const retry = await seedLegacySubagentRun(testDb(), {
      status: 'running',
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId: `${parentTaskRunId}_retry_2`,
      launchKey: 'retry-owner',
      objective: 'Cancel this running retry child through its root owner.',
    });
    const foreign = await seedLegacySubagentRun(testDb(), {
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId: `${parentTaskRunId}_retry_2_unrelated`,
      launchKey: 'foreign-prefix',
      objective: 'This prefix collision must remain owned by a different task run.',
    });

    const cancelled = await mailbox.cancelSubagentsForParent(
      testDb(),
      'session_parent_cancel',
      parentTaskRunId,
      'system',
    );

    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: direct.record.id, status: 'cancelled' }),
        expect.objectContaining({
          id: retry.record.id,
          status: 'running',
          cancelRequestedBy: 'system',
        }),
      ]),
    );
    await expect(mailbox.getSubagentRun(testDb(), foreign.record.id)).resolves.toMatchObject({
      status: 'queued',
    });
  });
});

describe('Copilot native Task subagent projection (ADR-0056)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('records native Task lifecycle without minting copilot_continuation', async () => {
    await seedParent({ id: 'ask_native_task', sessionId: 'session_native_task' });
    const parentTaskRunId = 'root_task_native_task';
    const started = await mailbox.recordNativeSubagentStarted(testDb(), {
      sessionId: 'session_native_task',
      parentTurnEventId: 'ask_native_task',
      parentTaskRunId,
      sdkTaskId: 'sdk-task-native-01',
      objective: 'Cross-check three monotonicity mistakes against the knowledge graph.',
    });
    expect(started?.status).toBe('running');

    const settled = await mailbox.settleNativeSubagentRun(testDb(), {
      sessionId: 'session_native_task',
      parentTurnEventId: 'ask_native_task',
      sdkTaskId: 'sdk-task-native-01',
      outcome: {
        status: 'succeeded',
        result: 'The learner confuses stationary points with extrema.',
      },
    });
    expect(settled?.status).toBe('succeeded');

    const continuations = await testDb()
      .select()
      .from(copilot_continuation)
      .where(eq(copilot_continuation.session_id, 'session_native_task'));
    expect(continuations).toHaveLength(0);
    const resultEvents = await testDb()
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:subagent_run_settled'),
          eq(event.session_id, 'session_native_task'),
        ),
      );
    expect(resultEvents).toHaveLength(1);
  });

  it('settles native runs scoped by parent turn even when sdk task_id repeats', async () => {
    const sessionId = 'session_native_task_reuse';
    const sdkTaskId = 'sdk-task-reused-across-turns';
    await seedParent({ id: 'ask_native_turn_1', sessionId });
    await seedParent({ id: 'ask_native_turn_2', sessionId });

    const turn1Started = await mailbox.recordNativeSubagentStarted(testDb(), {
      sessionId,
      parentTurnEventId: 'ask_native_turn_1',
      parentTaskRunId: 'root_task_native_turn_1',
      sdkTaskId,
      objective: 'Turn one objective for the reused sdk task id.',
    });
    const turn1Settled = await mailbox.settleNativeSubagentRun(testDb(), {
      sessionId,
      parentTurnEventId: 'ask_native_turn_1',
      sdkTaskId,
      outcome: { status: 'succeeded', result: 'Turn one native result.' },
    });
    expect(turn1Settled?.id).toBe(turn1Started?.id);
    expect(turn1Settled?.result).toBe('Turn one native result.');

    const turn2Started = await mailbox.recordNativeSubagentStarted(testDb(), {
      sessionId,
      parentTurnEventId: 'ask_native_turn_2',
      parentTaskRunId: 'root_task_native_turn_2',
      sdkTaskId,
      objective: 'Turn two objective for the reused sdk task id.',
    });
    expect(turn2Started?.id).not.toBe(turn1Started?.id);

    const turn2Settled = await mailbox.settleNativeSubagentRun(testDb(), {
      sessionId,
      parentTurnEventId: 'ask_native_turn_2',
      sdkTaskId,
      outcome: { status: 'succeeded', result: 'Turn two native result.' },
    });
    expect(turn2Settled?.id).toBe(turn2Started?.id);
    expect(turn2Settled?.result).toBe('Turn two native result.');

    const rows = await testDb()
      .select()
      .from(subagent_run)
      .where(eq(subagent_run.session_id, sessionId));
    expect(rows).toHaveLength(2);
    const turn1Row = rows.find((row) => row.parent_turn_event_id === 'ask_native_turn_1');
    const turn2Row = rows.find((row) => row.parent_turn_event_id === 'ask_native_turn_2');
    expect(turn1Row?.status).toBe('succeeded');
    expect(turn1Row?.result_md).toBe('Turn one native result.');
    expect(turn2Row?.status).toBe('succeeded');
    expect(turn2Row?.result_md).toBe('Turn two native result.');

    const settledEvents = await testDb()
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:subagent_run_settled'), eq(event.session_id, sessionId)),
      );
    expect(settledEvents).toHaveLength(2);

    const continuations = await testDb()
      .select()
      .from(copilot_continuation)
      .where(eq(copilot_continuation.session_id, sessionId));
    expect(continuations).toHaveLength(0);
  });
});
