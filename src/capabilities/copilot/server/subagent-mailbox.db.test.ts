import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs, copilot_continuation, event, subagent_run } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import * as mailbox from './subagent-mailbox';
import { getCopilotContinuationHistory } from './turns';

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
      sdkTaskId: 'sdk-task-native-01',
      outcome: {
        status: 'succeeded',
        result: 'The learner confuses stationary points with extrema.',
      },
    });
    expect(settled?.status).toBe('succeeded');

    const continuations = await testDb().select().from(copilot_continuation);
    expect(continuations).toHaveLength(0);
    const resultEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:subagent_run_settled'));
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
    const continuations = await testDb().select().from(copilot_continuation);
    expect(continuations).toHaveLength(1);
  });
});
