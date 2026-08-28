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
