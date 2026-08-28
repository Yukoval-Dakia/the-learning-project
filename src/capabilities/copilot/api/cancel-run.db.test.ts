import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type TerminalProjectionEvent,
  claimCopilotExecutionFence,
  markCopilotRunStarted,
} from '@/capabilities/copilot/jobs/copilot_run';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import { copilot_continuation, event, job_events, subagent_run, tool_operation } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeJobEvent } from '@/server/events/writer';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotUserAsk } from '../server/chat';
import {
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from '../server/durable-dispatch';
import * as mailbox from '../server/subagent-mailbox';
import { getCopilotTurnsBeforeAnchor } from '../server/turns';
import { POST } from './cancel-run';
import { CopilotCancelRunResponseSchema } from './contracts';

const complexRunInput = {
  user_message:
    '综合近 45 天 48 条含参函数、电磁感应与化学计量回答，读取 3 份原始讲义，交叉验证 6 个薄弱点探针，再生成并检验 9 个迁移变式；先归因、再提案，只有确认唯一解和量纲后才允许物化题目。',
  triggered_by: 'chat' as const,
  ambient_context: {
    route: '/subjects/cross-disciplinary/evidence-review?window=45d',
    focused_entity: { kind: 'knowledge', id: 'kc_parameter_transfer_conservation' },
  },
  evidence_shape: {
    answer_ids: Array.from({ length: 48 }, (_, index) => `answer_${index + 1}`),
    probe_ids: Array.from({ length: 6 }, (_, index) => `probe_${index + 1}`),
    source_document_ids: ['doc_function_domains', 'doc_faraday_units', 'doc_stoichiometry'],
    transfer_variant_ids: Array.from({ length: 9 }, (_, index) => `transfer_${index + 1}`),
  },
};

async function seedAcceptedRun() {
  const sessionId = `conversation_stop_${randomUUID()}`;
  const accepted = await reserveCopilotDurableAcceptance(testDb(), {
    sessionId,
    userMessage: complexRunInput.user_message,
    inputHash: hashCopilotDurableInput(complexRunInput),
    idempotencyKey: randomUUID(),
    queuedPayload: {
      session_id: sessionId,
      triggered_by: 'chat',
      pickup_deadline_ms: Date.now() + 15_000,
      evidence_shape: complexRunInput.evidence_shape,
    },
  });
  return { ...accepted.acceptance, sessionId };
}

function request(runId: string): Request {
  return new Request(`http://test/api/copilot/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

async function runEvents(runId: string): Promise<TerminalProjectionEvent[]> {
  return testDb()
    .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)))
    .orderBy(asc(job_events.id));
}

describe('POST /api/copilot/runs/:id/cancel', () => {
  beforeEach(async () => {
    await resetDb();
    // job_events is intentionally outside the generic domain-table reset list.
    await testDb().delete(job_events);
  });

  it('atomically cancels a rich accepted run before its paid execution fence', async () => {
    const accepted = await seedAcceptedRun();

    const response = await POST(request(accepted.runId), { id: accepted.runId });

    expect(response.status).toBe(200);
    expect(CopilotCancelRunResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      run_id: accepted.runId,
      status: 'cancelled',
    });
    const events = await runEvents(accepted.runId);
    expect(events.map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: 'cancelled',
      cancelled_before_start: true,
      checkpoint_event_id: accepted.runId,
    });
    const cancellationReplies = await testDb()
      .select({ outcome: event.outcome, payload: event.payload, taskRunId: event.task_run_id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:copilot_reply'),
          eq(event.caused_by_event_id, accepted.runId),
        ),
      );
    expect(cancellationReplies).toHaveLength(1);
    expect(cancellationReplies[0]).toMatchObject({
      outcome: 'failure',
      taskRunId: `copilot_run_cancelled_${accepted.runId}`,
      payload: {
        reply_md: '已停止这次运行。',
        durable_failure: {
          reason: 'cancelled',
          error: 'copilot run cancelled by user',
        },
      },
    });

    const nextRunId = await writeCopilotUserAsk(testDb(), {
      sessionId: accepted.sessionId,
      userMessage: '继续刚才的证据审查，但先总结上一轮状态。',
      now: new Date(Date.now() + 1_000),
    });
    await expect(
      getCopilotTurnsBeforeAnchor(testDb(), {
        sessionId: accepted.sessionId,
        anchorEventId: nextRunId,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ role: 'user', text: complexRunInput.user_message }),
      expect.objectContaining({ role: 'ai', text: '已停止这次运行。' }),
    ]);

    await expect(claimCopilotExecutionFence(testDb(), accepted.runId)).resolves.toMatchObject({
      outcome: 'terminal',
    });
    await expect(
      markCopilotRunStarted(testDb(), accepted.runId, {
        triggered_by: 'late-worker-pickup',
        evidence_rows: 48,
      }),
    ).resolves.toMatchObject({ outcome: 'terminal' });
    const eventsAfterLatePickup = await runEvents(accepted.runId);
    expect(eventsAfterLatePickup.some((e) => e.event_type === COPILOT_RUN_EVENTS.STARTED)).toBe(
      false,
    );
    expect(
      eventsAfterLatePickup.some((e) => e.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED),
    ).toBe(false);
  });

  it('writes one cooperative request after the fence and deduplicates concurrent Stop clicks', async () => {
    const accepted = await seedAcceptedRun();
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: accepted.runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => POST(request(accepted.runId), { id: accepted.runId })),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(bodies.filter((body) => body.status === 'cancel_requested')).toHaveLength(1);
    expect(bodies.filter((body) => body.status === 'already_requested')).toHaveLength(3);
    const events = await runEvents(accepted.runId);
    expect(
      events.filter((event) => event.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED),
    ).toHaveLength(1);
    expect(events.some((event) => event.event_type === COPILOT_RUN_EVENTS.FAILED)).toBe(false);
  });

  it('settles queued children and cooperatively cancels only this root retry lineage', async () => {
    const accepted = await seedAcceptedRun();
    const parentTaskRunId = `copilot_run_tool_${accepted.runId}`;
    const queued = await mailbox.launchSubagentRun(testDb(), {
      sessionId: accepted.sessionId,
      parentTurnEventId: accepted.runId,
      parentTaskRunId: `${parentTaskRunId}_retry_1`,
      launchKey: 'queued-user-stop',
      objective: 'This queued research must settle before the root cancellation returns.',
    });
    const running = await mailbox.launchSubagentRun(testDb(), {
      sessionId: accepted.sessionId,
      parentTurnEventId: accepted.runId,
      parentTaskRunId,
      launchKey: 'running-user-stop',
      objective: 'This provider-fenced research must drain cooperatively after user stop.',
    });
    const foreign = await mailbox.launchSubagentRun(testDb(), {
      sessionId: accepted.sessionId,
      parentTurnEventId: accepted.runId,
      parentTaskRunId: `${parentTaskRunId}_retry_1_unrelated`,
      launchKey: 'foreign-user-stop',
      objective: 'This near-prefix child belongs to a different root task and must not stop.',
    });
    await mailbox.claimSubagentRun(testDb(), running.record.id);

    const response = await POST(request(accepted.runId), { id: accepted.runId });

    expect(await response.json()).toMatchObject({ status: 'cancelled' });
    await expect(mailbox.getSubagentRun(testDb(), queued.record.id)).resolves.toMatchObject({
      status: 'cancelled',
      cancelRequestedBy: 'user',
    });
    await expect(mailbox.getSubagentRun(testDb(), running.record.id)).resolves.toMatchObject({
      status: 'running',
      cancelRequestedBy: 'user',
    });
    await expect(mailbox.getSubagentRun(testDb(), foreign.record.id)).resolves.toMatchObject({
      status: 'queued',
    });
    const continuations = await testDb()
      .select({ subagentRunId: copilot_continuation.subagent_run_id })
      .from(copilot_continuation)
      .where(eq(copilot_continuation.subagent_run_id, queued.record.id));
    expect(continuations).toHaveLength(1);
    const runningRows = await testDb()
      .select({ id: subagent_run.id, requestedBy: subagent_run.cancel_requested_by })
      .from(subagent_run)
      .where(eq(subagent_run.id, running.record.id));
    expect(runningRows).toEqual([{ id: running.record.id, requestedBy: 'user' }]);
  });

  it('treats retryable FAILED(reason=error) as active but a deliberate terminal as settled', async () => {
    const accepted = await seedAcceptedRun();
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: accepted.runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'error',
        error: 'provider reset after evaluating 48 answers and three source documents',
      },
    });
    const retryStop = await POST(request(accepted.runId), { id: accepted.runId });
    expect(await retryStop.json()).toMatchObject({ status: 'cancelled' });

    const settled = await POST(request(accepted.runId), { id: accepted.runId });
    expect(await settled.json()).toMatchObject({ status: 'already_settled' });
    expect(
      (await runEvents(accepted.runId)).filter(
        (item) => item.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      ),
    ).toHaveLength(1);
  });

  it('recognizes a committed outcome marker before its public terminal projection', async () => {
    const accepted = await seedAcceptedRun();
    await writeEvent(testDb(), {
      id: `copilot_reply_marker_${randomUUID()}`,
      session_id: accepted.sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: `reply_subject_${randomUUID()}`,
      outcome: 'success',
      payload: {
        reply_md: '已完成 48 条证据聚类、6 个探针与 9 个迁移变式校验。',
        task_run_id: 'task_cross_subject_outcome_marker',
      },
      caused_by_event_id: accepted.runId,
      task_run_id: 'task_cross_subject_outcome_marker',
    });

    const response = await POST(request(accepted.runId), { id: accepted.runId });
    expect(await response.json()).toMatchObject({ status: 'already_settled' });
    expect(
      (await runEvents(accepted.runId)).some(
        (item) => item.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      ),
    ).toBe(false);
  });

  it('requests cancellation for only this terminal run when its owned operation is still running', async () => {
    const accepted = await seedAcceptedRun();
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: accepted.runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: accepted.runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: `copilot_run_tool_${accepted.runId}` },
    });
    const now = new Date();
    const operationRows = [
      {
        id: 'toolop_terminal_parent_owner',
        session_id: accepted.sessionId,
        task_run_id: `copilot_run_tool_${accepted.runId}_retry_2`,
      },
      {
        id: 'toolop_terminal_parent_other_run',
        session_id: accepted.sessionId,
        task_run_id: `copilot_run_tool_${accepted.runId}_other`,
      },
      {
        id: 'toolop_terminal_parent_other_session',
        session_id: `${accepted.sessionId}_other`,
        task_run_id: `copilot_run_tool_${accepted.runId}`,
      },
    ].map((row) => ({
      ...row,
      tool_name: 'search_memory_facts',
      effect: 'read',
      status: 'running',
      process_id: 'cancel_endpoint_db_test',
      input_hash: 'a'.repeat(64),
      input_json: { args: { query: 'terminal parent cancellation' } },
      started_at: now,
      owner_heartbeat_at: now,
      lease_expires_at: new Date(now.getTime() + 60_000),
      updated_at: now,
    }));
    await testDb().insert(tool_operation).values(operationRows);

    const first = await POST(request(accepted.runId), { id: accepted.runId });
    expect(await first.json()).toMatchObject({ status: 'cancel_requested' });
    const second = await POST(request(accepted.runId), { id: accepted.runId });
    expect(await second.json()).toMatchObject({ status: 'already_requested' });
    expect(
      (await runEvents(accepted.runId)).filter(
        (item) => item.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      ),
    ).toHaveLength(1);
    const operations = await testDb()
      .select({ id: tool_operation.id, status: tool_operation.status })
      .from(tool_operation);
    expect(operations).toEqual(
      expect.arrayContaining(operationRows.map((row) => ({ id: row.id, status: 'running' }))),
    );
  });

  it('rejects unknown handles and QUEUED rows that do not bind to the canonical ask session', async () => {
    const missing = await POST(request('copilot_user_ask_missing'), {
      id: 'copilot_user_ask_missing',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });

    const accepted = await seedAcceptedRun();
    await testDb()
      .update(job_events)
      .set({
        payload: {
          session_id: 'conversation_tampered',
          input_hash: accepted.inputHash,
          boss_job_id: accepted.bossJobId,
        },
      })
      .where(
        and(
          eq(job_events.business_table, COPILOT_RUN_TABLE),
          eq(job_events.business_id, accepted.runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
        ),
      );
    const mismatched = await POST(request(accepted.runId), { id: accepted.runId });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toMatchObject({ error: 'not_found' });
    expect(
      (await runEvents(accepted.runId)).some(
        (item) => item.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      ),
    ).toBe(false);
  });

  it('returns validation_error for an empty path parameter without writing an orphan event', async () => {
    const response = await POST(request(''), { id: '' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation_error' });
    expect(await testDb().select({ id: event.id }).from(event)).toEqual([]);
    expect(await testDb().select({ id: job_events.id }).from(job_events)).toEqual([]);
  });
});
