import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ai_task_runs, copilot_continuation, event, job_events, subagent_run } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotReply } from './conversation-writes';
import { createCopilotExecutionOwner } from './copilot-execution';
import { createCopilotRunCancellationControl } from './copilot-run-cancellation';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import * as mailbox from './subagent-mailbox';
import type { CopilotTaskLifecycleMessage } from './subagents';
import { getCopilotContinuationHistory } from './turns';

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

  it('binds launch identity to session + ask/chip parent + canonical input', async () => {
    await seedParent({ id: 'ask_mailbox_identity', sessionId: 'session_mailbox_identity' });
    const input = {
      sessionId: 'session_mailbox_identity',
      parentTurnEventId: 'ask_mailbox_identity',
      parentTaskRunId: 'root_task_mailbox_identity',
      launchKey: 'compare-derivations-v1',
      objective:
        'Compare the completing-the-square and vertex-form derivations with exact anchors.',
    };
    const first = await mailbox.launchSubagentRun(testDb(), input);
    const replay = await mailbox.launchSubagentRun(testDb(), input);

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, record: { id: first.record.id } });
    await expect(
      mailbox.launchSubagentRun(testDb(), {
        ...input,
        objective: 'A different objective must not reuse the same launch key.',
      }),
    ).rejects.toThrow('different canonical input');
    await expect(
      mailbox.launchSubagentRun(testDb(), {
        ...input,
        sessionId: 'session_foreign',
      }),
    ).rejects.toThrow('parent turn not found');
  });

  it('settles one result event and one continuation despite duplicate completion', async () => {
    await seedParent({
      id: 'chip_mailbox_settle',
      sessionId: 'session_mailbox_settle',
      action: 'experimental:copilot_chip_trigger',
    });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_mailbox_settle',
      parentTurnEventId: 'chip_mailbox_settle',
      parentTaskRunId: 'root_task_mailbox_settle',
      launchKey: 'nested-evidence-v1',
      objective: 'Trace the nested evidence and report only verified conclusions.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected first claim');
    const first = await mailbox.settleSubagentRun(
      testDb(),
      launched.record.id,
      claimed.claimToken,
      { status: 'succeeded', result: 'The direct child chain supports the bounded claim.' },
    );
    const duplicate = await mailbox.settleSubagentRun(
      testDb(),
      launched.record.id,
      claimed.claimToken,
      { status: 'succeeded', result: 'This duplicate must not replace the first result.' },
    );

    expect(first.result).toBe('The direct child chain supports the bounded claim.');
    expect(duplicate.result).toBe(first.result);
    const resultEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:subagent_run_settled'));
    const continuations = await testDb().select().from(copilot_continuation);
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]?.caused_by_event_id).toBe(launched.record.startedEventId);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({
      subagent_run_id: launched.record.id,
      result_event_id: first.settledEventId,
      status: 'pending',
    });
  });

  it('exposes a serialized continuation claim seam before automatic continuation is wired', () => {
    expect(
      (mailbox as typeof mailbox & { claimCopilotContinuation?: unknown }).claimCopilotContinuation,
    ).toBeTypeOf('function');
  });

  it('cancels queued work directly and marks running work for cooperative drain', async () => {
    await seedParent({ id: 'ask_cancel_queued', sessionId: 'session_cancel' });
    const queued = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_cancel',
      parentTurnEventId: 'ask_cancel_queued',
      parentTaskRunId: 'root_cancel',
      launchKey: 'queued-cancel',
      objective: 'This objective should never reach a provider.',
    });
    await expect(
      mailbox.cancelSubagentRun(testDb(), queued.record.id, 'session_cancel', 'user'),
    ).resolves.toMatchObject({ status: 'cancelled', cancelRequestedBy: 'user' });

    await seedParent({ id: 'ask_cancel_running', sessionId: 'session_cancel' });
    const running = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_cancel',
      parentTurnEventId: 'ask_cancel_running',
      parentTaskRunId: 'root_cancel',
      launchKey: 'running-cancel',
      objective: 'This objective should receive a cooperative cancellation signal.',
    });
    await mailbox.claimSubagentRun(testDb(), running.record.id);
    await expect(
      mailbox.cancelSubagentRun(testDb(), running.record.id, 'session_cancel', 'system'),
    ).resolves.toMatchObject({ status: 'running', cancelRequestedBy: 'system' });
    const [row] = await testDb()
      .select()
      .from(subagent_run)
      .where(eq(subagent_run.id, running.record.id));
    expect(row?.cancel_requested_at).toBeInstanceOf(Date);
  });

  it('cancels only the exact root owner and its numbered retry task runs', async () => {
    await seedParent({ id: 'ask_parent_cancel', sessionId: 'session_parent_cancel' });
    const parentTaskRunId = 'copilot_run_tool_parent_cancel';
    const direct = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId,
      launchKey: 'direct-owner',
      objective: 'Cancel this queued direct child through its root owner.',
    });
    const retry = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId: `${parentTaskRunId}_retry_2`,
      launchKey: 'retry-owner',
      objective: 'Cancel this running retry child through its root owner.',
    });
    const foreign = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_parent_cancel',
      parentTurnEventId: 'ask_parent_cancel',
      parentTaskRunId: `${parentTaskRunId}_retry_2_unrelated`,
      launchKey: 'foreign-prefix',
      objective: 'This prefix collision must remain owned by a different task run.',
    });
    await mailbox.claimSubagentRun(testDb(), retry.record.id);

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

  it('never renews a lease beyond the hard deadline', async () => {
    await seedParent({ id: 'ask_hard_deadline', sessionId: 'session_hard_deadline' });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_hard_deadline',
      parentTurnEventId: 'ask_hard_deadline',
      parentTaskRunId: 'root_hard_deadline',
      launchKey: 'hard-deadline',
      objective: 'This provider-fenced child must stop at its hard deadline.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected running claim');
    await testDb()
      .update(subagent_run)
      .set({ hard_deadline_at: new Date(Date.now() - 1) })
      .where(eq(subagent_run.id, launched.record.id));

    await expect(
      mailbox.heartbeatSubagentRun(testDb(), launched.record.id, claimed.claimToken),
    ).resolves.toBe('deadline_reached');
    await expect(mailbox.getSubagentRun(testDb(), launched.record.id)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('waits for the parent reply and serializes continuation claims per session', async () => {
    await seedParent({ id: 'ask_continue_one', sessionId: 'session_continue' });
    await seedParent({ id: 'ask_continue_two', sessionId: 'session_continue' });
    const continuationIds: string[] = [];
    for (const [index, parentTurnEventId] of ['ask_continue_one', 'ask_continue_two'].entries()) {
      const launched = await mailbox.launchSubagentRun(testDb(), {
        sessionId: 'session_continue',
        parentTurnEventId,
        parentTaskRunId: `root_continue_${index}`,
        launchKey: `continue-${index}`,
        objective: `Inspect evidence branch ${index} with nested and ambiguous records.`,
      });
      const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
      if (!claimed || 'lost' in claimed) throw new Error('expected child claim');
      await mailbox.settleSubagentRun(testDb(), launched.record.id, claimed.claimToken, {
        status: 'succeeded',
        result: `Verified child result ${index}`,
      });
      continuationIds.push(`copilot_continuation_${launched.record.id}`);
    }

    await expect(
      mailbox.claimCopilotContinuation(testDb(), continuationIds[0] ?? ''),
    ).resolves.toEqual({ waiting: true });
    for (const parentTurnEventId of ['ask_continue_one', 'ask_continue_two']) {
      await writeEvent(testDb(), {
        id: `reply_${parentTurnEventId}`,
        session_id: 'session_continue',
        actor_kind: 'agent',
        actor_ref: 'agent:copilot',
        action: 'experimental:copilot_reply',
        subject_kind: 'query',
        subject_id: `reply_${parentTurnEventId}`,
        outcome: 'success',
        payload: { reply_md: `Foreground reply for ${parentTurnEventId}` },
        caused_by_event_id: parentTurnEventId,
      });
    }
    const first = await mailbox.claimCopilotContinuation(testDb(), continuationIds[0] ?? '');
    if (!first || 'waiting' in first || 'lost' in first) throw new Error('expected first claim');
    await expect(
      mailbox.claimCopilotContinuation(testDb(), continuationIds[0] ?? ''),
    ).resolves.toEqual({ waiting: true });
    await expect(
      mailbox.claimCopilotContinuation(testDb(), continuationIds[1] ?? ''),
    ).resolves.toEqual({ waiting: true });
    await mailbox.settleCopilotContinuation(testDb(), {
      continuationId: first.record.id,
      claimToken: first.claimToken,
      status: 'succeeded',
      replyEventId: 'continuation_reply_one',
    });
    const second = await mailbox.claimCopilotContinuation(testDb(), continuationIds[1] ?? '');
    expect(second && 'record' in second ? second.record.status : null).toBe('running');
  });

  it('continues after the authoritative parent task failure even when no reply exists', async () => {
    await seedParent({ id: 'ask_parent_failure', sessionId: 'session_parent_failure' });
    const parentTaskRunId = 'root_task_parent_failure';
    await testDb()
      .insert(ai_task_runs)
      .values({
        id: parentTaskRunId,
        task_kind: 'CopilotTask',
        provider: 'test',
        model: 'test-model',
        input_hash: 'parent-failure-input',
        status: 'failure',
        finish_reason: 'error',
        usage_json: { inputTokens: 0, outputTokens: 0 },
        error_message: 'Root provider failed before a reply was written.',
        started_at: new Date('2026-08-28T00:00:00.000Z'),
        finished_at: new Date('2026-08-28T00:00:01.000Z'),
      });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_parent_failure',
      parentTurnEventId: 'ask_parent_failure',
      parentTaskRunId,
      launchKey: 'continue-after-parent-failure',
      objective: 'Return the verified evidence despite the root provider failure.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected child claim');
    await mailbox.settleSubagentRun(testDb(), launched.record.id, claimed.claimToken, {
      status: 'succeeded',
      result: 'The researcher preserved the evidence needed for the continuation.',
    });

    const continuation = await mailbox.claimCopilotContinuation(
      testDb(),
      `copilot_continuation_${launched.record.id}`,
    );
    expect(continuation && 'record' in continuation ? continuation.record.status : null).toBe(
      'running',
    );
  });

  it('recovers queued work and turns only an expired provider-fenced child into lost', async () => {
    await seedParent({ id: 'ask_recovery', sessionId: 'session_recovery' });
    const queued = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_recovery',
      parentTurnEventId: 'ask_recovery',
      parentTaskRunId: 'root_recovery',
      launchKey: 'recovery-queued',
      objective: 'Recover this queued objective after a process restart.',
    });
    const running = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_recovery',
      parentTurnEventId: 'ask_recovery',
      parentTaskRunId: 'root_recovery',
      launchKey: 'recovery-running',
      objective: 'This provider-fenced objective must never be blindly retried.',
    });
    const claim = await mailbox.claimSubagentRun(testDb(), running.record.id);
    if (!claim || 'lost' in claim) throw new Error('expected running claim');
    await expect(mailbox.claimSubagentRun(testDb(), running.record.id)).resolves.toBeNull();
    await testDb()
      .update(subagent_run)
      .set({ lease_expires_at: new Date(Date.now() - 1_000) })
      .where(eq(subagent_run.id, running.record.id));

    const recovered = await mailbox.recoverSubagentMailbox(testDb());
    expect(recovered.queuedRunIds).toContain(queued.record.id);
    expect(recovered.lostRunIds).toEqual([running.record.id]);
    await expect(mailbox.getSubagentRun(testDb(), running.record.id)).resolves.toMatchObject({
      status: 'lost',
      error: { code: 'lease_expired_after_provider_fence' },
    });
    const continuations = await testDb()
      .select()
      .from(copilot_continuation)
      .where(eq(copilot_continuation.subagent_run_id, running.record.id));
    expect(continuations).toHaveLength(1);
  });

  it('lets a heartbeat renewal win when it lands after the recovery scan', async () => {
    await seedParent({ id: 'ask_recovery_race', sessionId: 'session_recovery_race' });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_recovery_race',
      parentTurnEventId: 'ask_recovery_race',
      parentTaskRunId: 'root_recovery_race',
      launchKey: 'recovery-heartbeat-race',
      objective: 'Renew the live lease after recovery has observed the old expiration.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected running claim');
    await testDb()
      .update(subagent_run)
      .set({ lease_expires_at: new Date(Date.now() - 1_000) })
      .where(eq(subagent_run.id, launched.record.id));

    const recovered = await mailbox.recoverSubagentMailbox(testDb(), {
      beforeRecoverExpiredRun: async (record) => {
        expect(record.id).toBe(launched.record.id);
        await expect(
          mailbox.heartbeatSubagentRun(testDb(), record.id, claimed.claimToken),
        ).resolves.toBe('renewed');
      },
    });

    expect(recovered.lostRunIds).toEqual([]);
    await expect(mailbox.getSubagentRun(testDb(), launched.record.id)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('anchors continuation history to its ask/chip parent and excludes later session turns', async () => {
    await seedParent({ id: 'ask_history_before', sessionId: 'session_history' });
    await writeEvent(testDb(), {
      id: 'reply_history_before',
      session_id: 'session_history',
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: 'reply_history_before',
      outcome: 'success',
      payload: { reply_md: 'Earlier root reply' },
      caused_by_event_id: 'ask_history_before',
    });
    await seedParent({
      id: 'chip_history_parent',
      sessionId: 'session_history',
      action: 'experimental:copilot_chip_trigger',
    });
    await writeEvent(testDb(), {
      id: 'reply_history_parent',
      session_id: 'session_history',
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: 'reply_history_parent',
      outcome: 'success',
      payload: { reply_md: 'Foreground parent reply' },
      caused_by_event_id: 'chip_history_parent',
    });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_history',
      parentTurnEventId: 'chip_history_parent',
      parentTaskRunId: 'root_history_parent',
      launchKey: 'history-anchor',
      objective: 'Return a bounded result for the chip-rooted continuation.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected history child claim');
    const settled = await mailbox.settleSubagentRun(
      testDb(),
      launched.record.id,
      claimed.claimToken,
      { status: 'succeeded', result: 'Bounded child result' },
    );
    await seedParent({ id: 'ask_history_later', sessionId: 'session_history' });
    await writeEvent(testDb(), {
      id: 'reply_history_later',
      session_id: 'session_history',
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: 'reply_history_later',
      outcome: 'success',
      payload: { reply_md: 'Later unrelated root reply' },
      caused_by_event_id: 'ask_history_later',
    });

    const history = await getCopilotContinuationHistory(testDb(), {
      sessionId: 'session_history',
      parentTurnEventId: 'chip_history_parent',
      resultEventId: settled.settledEventId ?? '',
      limit: 20,
    });
    expect(history.map((turn) => turn.event_id)).toEqual([
      'ask_history_before',
      'reply_history_before',
      'chip_history_parent',
      'reply_history_parent',
    ]);
    expect(history.map((turn) => turn.event_id)).not.toContain('ask_history_later');
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

  it('keeps worker mailbox settle minting continuation for durable launches', async () => {
    await seedParent({ id: 'ask_worker_mailbox', sessionId: 'session_worker_mailbox' });
    const launched = await mailbox.launchSubagentRun(testDb(), {
      sessionId: 'session_worker_mailbox',
      parentTurnEventId: 'ask_worker_mailbox',
      parentTaskRunId: 'root_worker_mailbox',
      launchKey: 'worker-mailbox-v1',
      objective: 'Worker-owned durable researcher objective.',
    });
    const claimed = await mailbox.claimSubagentRun(testDb(), launched.record.id);
    if (!claimed || 'lost' in claimed) throw new Error('expected worker claim');
    await mailbox.settleSubagentRun(testDb(), launched.record.id, claimed.claimToken, {
      status: 'succeeded',
      result: 'Worker path still mints one continuation.',
    });
    const continuations = await testDb()
      .select()
      .from(copilot_continuation)
      .where(eq(copilot_continuation.session_id, 'session_worker_mailbox'));
    expect(continuations).toHaveLength(1);
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
