import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, job_events } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  copilotBossJobId,
  findCopilotDurableAcceptance,
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
} from './durable-dispatch';

const richTurn = {
  user_message:
    '读取近 45 天的 36 道含参函数与电磁感应错题，按定义域遗漏、退化分支、单位方向三类交叉聚证；生成 9 道迁移题，并逐题校验唯一解、量纲和极端参数。',
  triggered_by: 'chat' as const,
  ambient_context: {
    route: '/subjects/physics/mistakes?window=45d',
    focused_entity: { kind: 'knowledge', id: 'kc_faraday_parameter_transfer' },
  },
};

function queuedPayload(sessionId: string) {
  return {
    session_id: sessionId,
    triggered_by: 'chat',
    pickup_deadline_ms: Date.now() + 15_000,
    dispatch: {
      source: 'model_triage',
      reason_code: 'multi_artifact_work',
      task_run_id: 'copilot_dispatch_cross_subject_45d',
    },
  };
}

describe('durable Copilot dispatch acceptance', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('collapses concurrent same-key rich requests into one ask and one QUEUED handle', async () => {
    const idempotencyKey = randomUUID();
    const sessionId = 'conversation_cross_subject_transfer_audit';
    const inputHash = hashCopilotDurableInput(richTurn);
    const reserve = () =>
      reserveCopilotDurableAcceptance(testDb(), {
        sessionId,
        userMessage: richTurn.user_message,
        inputHash,
        idempotencyKey,
        queuedPayload: queuedPayload(sessionId),
      });

    const results = await Promise.all([reserve(), reserve(), reserve(), reserve()]);
    const runIds = new Set(results.map((result) => result.acceptance.runId));
    expect(runIds.size).toBe(1);
    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'reused')).toHaveLength(3);

    const runId = results[0]?.acceptance.runId as string;
    const asks = await testDb()
      .select({ id: event.id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.id, runId),
          eq(event.action, 'experimental:copilot_user_ask'),
          eq(event.session_id, sessionId),
        ),
      );
    expect(asks).toHaveLength(1);
    expect(asks[0]?.payload).toMatchObject({ user_message: richTurn.user_message });

    const queued = await testDb()
      .select({ payload: job_events.payload })
      .from(job_events)
      .where(
        and(
          eq(job_events.business_table, COPILOT_RUN_TABLE),
          eq(job_events.business_id, runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({
      session_id: sessionId,
      input_hash: inputHash,
      idempotency_key: idempotencyKey,
      boss_job_id: copilotBossJobId(runId),
      dispatch: {
        source: 'model_triage',
        reason_code: 'multi_artifact_work',
      },
    });
    await expect(findCopilotDurableAcceptance(testDb(), idempotencyKey)).resolves.toEqual(
      results[0]?.acceptance,
    );
  });
});
