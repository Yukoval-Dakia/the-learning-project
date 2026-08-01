import { createHash, randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, job_events } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  copilotBossJobId,
  copilotRunIdForIdempotencyKey,
  findCopilotDurableAcceptance,
  hasTerminalCopilotRun,
  hashCopilotDurableInput,
  reconcileCopilotDurableAcceptance,
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

  it('hashes nested input with locale-independent code-unit key ordering', () => {
    const input = {
      apple: 'lowercase',
      Apple: 'uppercase',
      _meta: { zeta: 3, Alpha: 1, alpha: 2 },
    };
    const canonical =
      '{"Apple":"uppercase","_meta":{"Alpha":1,"alpha":2,"zeta":3},"apple":"lowercase"}';
    const expected = createHash('sha256').update(canonical).digest('hex');

    expect(hashCopilotDurableInput(input)).toBe(expected);
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

  it('returns conflict when the same key changes a nested execution input', async () => {
    const idempotencyKey = randomUUID();
    const sessionId = 'conversation_idempotency_conflict';
    const firstHash = hashCopilotDurableInput(richTurn);
    const first = await reserveCopilotDurableAcceptance(testDb(), {
      sessionId,
      userMessage: richTurn.user_message,
      inputHash: firstHash,
      idempotencyKey,
      queuedPayload: queuedPayload(sessionId),
    });
    const changedHash = hashCopilotDurableInput({
      ...richTurn,
      ambient_context: {
        ...richTurn.ambient_context,
        focused_entity: { kind: 'knowledge', id: 'kc_lenz_direction_counterexample' },
      },
    });

    const conflict = await reserveCopilotDurableAcceptance(testDb(), {
      sessionId,
      userMessage: richTurn.user_message,
      inputHash: changedHash,
      idempotencyKey,
      queuedPayload: queuedPayload(sessionId),
    });

    expect(conflict).toEqual({ outcome: 'conflict', acceptance: first.acceptance });
    const queuedCount = await testDb().execute(sql`
      SELECT count(*)::int AS count
      FROM job_events
      WHERE business_table = ${COPILOT_RUN_TABLE}
        AND business_id = ${first.acceptance.runId}
        AND event_type = ${COPILOT_RUN_EVENTS.QUEUED}
    `);
    expect(Number(queuedCount[0]?.count ?? 0)).toBe(1);
  });

  it('rolls back both ask and QUEUED when abort is observed before acceptance returns', async () => {
    const sessionId = 'conversation_abort_atomic_acceptance';
    let guardCalls = 0;
    await expect(
      reserveCopilotDurableAcceptance(testDb(), {
        sessionId,
        userMessage: richTurn.user_message,
        inputHash: hashCopilotDurableInput(richTurn),
        queuedPayload: queuedPayload(sessionId),
        assertActive: () => {
          guardCalls++;
          if (guardCalls === 3) throw new Error('request aborted before acceptance');
        },
      }),
    ).rejects.toThrow('request aborted before acceptance');

    const asks = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        and(eq(event.action, 'experimental:copilot_user_ask'), eq(event.session_id, sessionId)),
      );
    const queued = await testDb()
      .select({ id: job_events.id })
      .from(job_events)
      .where(sql`${job_events.payload}->>'session_id' = ${sessionId}`);
    expect(asks).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('waits behind an in-flight reserve lock before reconciling a lost COMMIT acknowledgement', async () => {
    const idempotencyKey = randomUUID();
    const runId = copilotRunIdForIdempotencyKey(idempotencyKey);
    const sessionId = 'conversation_acceptance_commit_ack_unknown';
    const inputHash = hashCopilotDurableInput(richTurn);
    const bossJobId = copilotBossJobId(runId);
    let releaseCommit!: () => void;
    let markQueuedWritten!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const queuedWritten = new Promise<void>((resolve) => {
      markQueuedWritten = resolve;
    });

    const lateCommit = testDb().transaction(async (tx) => {
      // Mirrors reserveCopilotDurableAcceptance's lock and a transaction whose
      // server-side COMMIT result is still unknown to its caller.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot-chat:${idempotencyKey}`}, 0))`,
      );
      await writeJobEvent(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.QUEUED,
        payload: {
          ...queuedPayload(sessionId),
          input_hash: inputHash,
          idempotency_key: idempotencyKey,
          boss_job_id: bossJobId,
        },
      });
      markQueuedWritten();
      await commitGate;
    });
    await queuedWritten;

    let reconciliationSettled = false;
    const reconciliation = reconcileCopilotDurableAcceptance(testDb(), idempotencyKey).finally(
      () => {
        reconciliationSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconciliationSettled).toBe(false);

    releaseCommit();
    await lateCommit;
    await expect(reconciliation).resolves.toEqual({
      runId,
      sessionId,
      inputHash,
      bossJobId,
    });
  });

  it('keeps a retained retryable provider failure dispatchable until a deliberate terminal arrives', async () => {
    const runId = 'copilot_user_ask_retry_48_items_6_probes';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {
        session_id: 'conversation_retry_48_items_6_probes',
        pickup_deadline_ms: Date.now() + 15_000,
        dispatch: {
          source: 'model_triage',
          reason_code: 'multi_artifact_work',
          task_run_id: 'copilot_dispatch_retry_48_items_6_probes',
        },
      },
    });
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'error',
        error: 'transient provider gateway reset after validating 31 of 48 items',
      },
    });

    await expect(hasTerminalCopilotRun(testDb(), runId)).resolves.toBe(false);

    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'exhausted',
        error: 'validator retry budget exhausted on the sixth unlearned probe',
        checkpoint_event_id: runId,
      },
    });

    await expect(hasTerminalCopilotRun(testDb(), runId)).resolves.toBe(true);
  });

  it('fails closed on a malformed/future FAILED reason instead of buying another paid run', async () => {
    const runId = 'copilot_user_ask_future_failure_contract';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'future_manual_settlement', operator_ticket: 'YUK-future' },
    });

    await expect(hasTerminalCopilotRun(testDb(), runId)).resolves.toBe(true);
  });
});
