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
import { event, job_events } from '@/db/schema';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotInputEvent } from '../server/conversation-writes';
import {
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from '../server/durable-dispatch';
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

  // @invariant concurrency: a Stop accepted before the paid execution fence settles the run as cancelled with one terminal reply and no started execution.
  // @fails-if the cancel path starts a paid run, writes more than one terminal reply, or drops the accepted run's checkpoint identity.
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
        reply_md: '这次已按你的意思停下。',
        durable_failure: {
          reason: 'cancelled',
          error: 'copilot run cancelled by user',
        },
      },
    });

    const nextRunId = await writeCopilotInputEvent(testDb(), {
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
      expect.objectContaining({ role: 'ai', text: '这次已按你的意思停下。' }),
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
});
