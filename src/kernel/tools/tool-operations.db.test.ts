import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, tool_operation } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createToolOperations } from './tool-operations';

async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${constraintName} to reject the write`);
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe(constraintName);
  }
}

describe('ToolOperations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('starts with a handle, polls with timeoutMs=0, and settles a realistic result', async () => {
    let resolveExecution!: (value: {
      status: 'succeeded';
      result: Record<string, unknown>;
      terminalToolCallLogId: string;
    }) => void;
    const execution = new Promise<{
      status: 'succeeded';
      result: Record<string, unknown>;
      terminalToolCallLogId: string;
    }>((resolve) => {
      resolveExecution = resolve;
    });
    const operations = createToolOperations(testDb(), { processId: 'api_boot_current' });

    const handle = await operations.start(
      {
        id: 'toolop_search_notes',
        sessionId: 'session_copilot_1',
        taskRunId: 'task_run_1',
        toolName: 'search_notes',
        effect: 'read',
        input: {
          query: 'Compare the derivation of the quadratic formula with completing the square',
          filters: { subjects: ['math'], includeArchived: false },
        },
      },
      async () => execution,
    );

    await expect(handle.wait({ timeoutMs: 0 })).resolves.toMatchObject({ status: 'running' });
    await expect(handle.wait({ timeoutMs: 0 })).resolves.toMatchObject({ status: 'running' });
    resolveExecution({
      status: 'succeeded',
      result: {
        matches: [
          { note_id: 'note_long_1', score: 0.93, excerpt: 'Completing the square transforms...' },
        ],
        truncated: false,
      },
      terminalToolCallLogId: 'tool_log_search_notes_1',
    });
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'succeeded',
      result: { matches: [{ note_id: 'note_long_1' }], truncated: false },
      terminalToolCallLogId: 'tool_log_search_notes_1',
    });

    const events = await testDb()
      .select({ action: event.action, subjectId: event.subject_id })
      .from(event)
      .where(eq(event.subject_id, handle.id));
    expect(events).toEqual([
      { action: 'tool_operation_yielded', subjectId: handle.id },
      { action: 'tool_operation_settled', subjectId: handle.id },
    ]);
  });

  it('bounds a positive wait without changing the running operation', async () => {
    const operations = createToolOperations(testDb(), {
      processId: 'api_boot_wait',
      pollIntervalMs: 5,
    });
    const handle = await operations.start(
      {
        id: 'toolop_still_running',
        toolName: 'remote_read',
        effect: 'read',
        input: { query: 'slow but safe request' },
      },
      async () => new Promise<never>(() => undefined),
    );

    await expect(handle.wait({ timeoutMs: 20 })).resolves.toMatchObject({ status: 'running' });
  });

  it('settles executor errors as failed without inventing side-effect certainty', async () => {
    const operations = createToolOperations(testDb(), { processId: 'api_boot_failure' });
    const handle = await operations.start(
      {
        id: 'toolop_failed_read',
        toolName: 'remote_read',
        effect: 'read',
        input: { query: 'request rejected by upstream' },
      },
      async () => ({
        status: 'failed',
        error: { code: 'upstream_rejected', message: 'upstream returned 503 after retries' },
      }),
    );

    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'upstream_rejected', message: 'upstream returned 503 after retries' },
      sideEffectRisk: null,
    });
  });

  it.each(['model', 'system', 'user'] as const)(
    'allows %s cancellation and aborts the local execution',
    async (cancelledBy) => {
      const operations = createToolOperations(testDb(), { processId: `api_boot_${cancelledBy}` });
      let observedAbort = false;
      const handle = await operations.start(
        {
          id: `toolop_cancel_${cancelledBy}`,
          toolName: 'long_local_read',
          effect: 'read',
          input: { nested: { pages: [1, 2, 3], mode: 'full' } },
        },
        async ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              observedAbort = true;
              resolve({
                status: 'cancelled' as const,
                error: { code: 'cooperative_abort', message: 'Local executor confirmed stop' },
              });
            });
          }),
      );

      await expect(handle.cancel({ requestedBy: cancelledBy })).resolves.toMatchObject({
        status: 'running',
        cancelledBy: null,
      });
      expect(observedAbort).toBe(true);
      await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
        status: 'cancelled',
        cancelledBy,
      });
      await expect(handle.cancel({ requestedBy: cancelledBy })).rejects.toThrow(
        'cannot transition from cancelled to cancelled',
      );
    },
  );

  it('keeps unconfirmed cancellation running until boot recovery marks side-effect risk', async () => {
    let clock = new Date('2026-08-27T12:00:00Z');
    const oldOperations = createToolOperations(testDb(), {
      processId: 'api_boot_uncertain_old',
      now: () => clock,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    const handle = await oldOperations.start(
      {
        id: 'toolop_uncertain_write',
        toolName: 'remote_write_without_cancel_ack',
        effect: 'write',
        input: {
          proposal: { title: 'Potentially committed remotely', body: 'No acknowledgement' },
        },
      },
      async () => new Promise<never>(() => undefined),
    );

    await expect(handle.cancel({ requestedBy: 'model' })).resolves.toMatchObject({
      status: 'running',
    });
    await expect(handle.wait({ timeoutMs: 0 })).resolves.toMatchObject({ status: 'running' });

    clock = new Date(clock.getTime() + 1_001);
    const newOperations = createToolOperations(testDb(), {
      processId: 'api_boot_uncertain_new',
      now: () => clock,
    });
    await expect(newOperations.recoverLost()).resolves.toEqual([
      expect.objectContaining({
        id: handle.id,
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);
  });

  it('treats a generic abort rejection from a dispatched write as lost, not cancelled', async () => {
    const operations = createToolOperations(testDb(), { processId: 'api_boot_ambiguous_abort' });
    const handle = await operations.start(
      {
        id: 'toolop_ambiguous_abort',
        toolName: 'remote_write',
        effect: 'write',
        input: { mutation: { title: 'May already be committed' } },
      },
      async ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    await handle.cancel({ requestedBy: 'user' });
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'lost',
      sideEffectRisk: 'possible',
      error: { code: 'execution_ambiguous' },
    });
  });

  it('accepts an explicit uncertain remote outcome without inferring from an exception', async () => {
    const operations = createToolOperations(testDb(), { processId: 'api_boot_explicit_ambiguity' });
    const handle = await operations.start(
      {
        id: 'toolop_explicit_ambiguity',
        toolName: 'remote_propose',
        effect: 'propose',
        input: { proposal: { title: 'Remote acknowledgement was lost' } },
      },
      async () => ({
        status: 'lost',
        error: {
          code: 'remote_acknowledgement_missing',
          message: 'Transport closed after dispatch and before acknowledgement',
        },
      }),
    );

    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'lost',
      sideEffectRisk: 'possible',
      error: { code: 'remote_acknowledgement_missing' },
    });
  });

  it.each([
    ['read', 'failed', null],
    ['write', 'lost', 'possible'],
  ] as const)('enforces a %s hard deadline as %s', async (effect, state, risk) => {
    const operations = createToolOperations(testDb(), {
      processId: `api_boot_deadline_${effect}`,
    });
    const handle = await operations.start(
      {
        id: `toolop_deadline_${effect}`,
        toolName: `slow_${effect}`,
        effect,
        input: { payload: { long: 'work that ignores abort until its transport returns' } },
        hardDeadlineAt: new Date(Date.now() + 30),
      },
      async () => new Promise<never>(() => undefined),
    );
    const waitStartedAt = Date.now();
    await expect(handle.wait({ timeoutMs: 500 })).resolves.toMatchObject({
      status: state,
      sideEffectRisk: risk,
      error: { code: 'hard_deadline_exceeded' },
    });
    expect(Date.now() - waitStartedAt).toBeLessThan(300);
  });

  it('clears a hard-deadline timer after confirmed settlement', async () => {
    const operations = createToolOperations(testDb(), {
      processId: 'api_boot_deadline_cleanup',
    });
    const handle = await operations.start(
      {
        id: 'toolop_deadline_cleanup',
        toolName: 'fast_read',
        effect: 'read',
        input: { query: 'finishes before cap' },
        hardDeadlineAt: new Date(Date.now() + 50),
      },
      async () => ({ status: 'succeeded', result: { answer: 'confirmed' } }),
    );
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({ status: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(handle.wait({ timeoutMs: 0 })).resolves.toMatchObject({ status: 'succeeded' });
    const settledEvents = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.subject_id, handle.id), eq(event.action, 'tool_operation_settled')));
    expect(settledEvents).toHaveLength(1);
  });

  it('does not recover a live owner and eventually recovers an expired lease', async () => {
    let clock = new Date('2026-08-27T12:00:00Z');
    const oldOperations = createToolOperations(testDb(), {
      processId: 'api_boot_live_owner',
      now: () => clock,
      leaseDurationMs: 30_000,
    });
    await oldOperations.start(
      {
        id: 'toolop_leased_write',
        toolName: 'remote_write',
        effect: 'write',
        input: { mutation: { title: 'Held by a live process lease' } },
      },
      async () => new Promise<never>(() => undefined),
    );

    const recoveringProcess = createToolOperations(testDb(), {
      processId: 'api_boot_recovering',
      now: () => clock,
    });
    await expect(recoveringProcess.recoverLost()).resolves.toEqual([]);
    clock = new Date(clock.getTime() + 30_001);
    await expect(recoveringProcess.recoverLost()).resolves.toEqual([
      expect.objectContaining({
        id: 'toolop_leased_write',
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);
  });

  it('renews a live owner lease while a concurrent recovery process observes it', async () => {
    let finish!: (outcome: { status: 'succeeded'; result: { acknowledgement: string } }) => void;
    const execution = new Promise<{
      status: 'succeeded';
      result: { acknowledgement: string };
    }>((resolve) => {
      finish = resolve;
    });
    const owner = createToolOperations(testDb(), {
      processId: 'api_boot_heartbeating',
      leaseDurationMs: 200,
      heartbeatIntervalMs: 20,
    });
    const handle = await owner.start(
      {
        id: 'toolop_heartbeating',
        toolName: 'remote_read',
        effect: 'read',
        input: { query: 'remain live across recovery sweep' },
      },
      async () => execution,
    );
    const initial = await owner.get(handle.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const renewed = await owner.get(handle.id);
    expect(renewed.ownerHeartbeatAt.getTime()).toBeGreaterThan(initial.ownerHeartbeatAt.getTime());

    const recovering = createToolOperations(testDb(), { processId: 'api_boot_observer' });
    await expect(recovering.recoverLost()).resolves.toEqual([]);
    finish({ status: 'succeeded', result: { acknowledgement: 'confirmed' } });
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('rejects oversized input before persistence and oversized result without truncation', async () => {
    const operations = createToolOperations(testDb(), { processId: 'api_boot_bounds' });
    await expect(
      operations.start(
        {
          id: 'toolop_oversized_input',
          toolName: 'bounded_tool',
          effect: 'read',
          input: { body: 'x'.repeat(70_000) },
        },
        async () => ({ status: 'succeeded', result: { ok: true } }),
      ),
    ).rejects.toThrow('input exceeds');

    const handle = await operations.start(
      {
        id: 'toolop_oversized_result',
        toolName: 'bounded_tool',
        effect: 'read',
        input: { query: 'bounded' },
      },
      async () => ({ status: 'succeeded', result: { body: 'x'.repeat(70_000) } }),
    );
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'failed',
      result: null,
      error: { code: 'result_too_large' },
    });
  });

  it('enforces the persisted JSON and error-summary bounds at the table boundary', async () => {
    const now = new Date();
    await expectConstraintViolation(
      testDb()
        .insert(tool_operation)
        .values({
          id: 'toolop_direct_oversized',
          tool_name: 'direct_writer',
          effect: 'read',
          status: 'running',
          process_id: 'api_boot_direct',
          input_json: { body: 'x'.repeat(140_000) },
          started_at: now,
          owner_heartbeat_at: now,
          lease_expires_at: new Date(now.getTime() + 30_000),
          updated_at: now,
        }),
      'tool_operation_json_bounds_ck',
    );
    await expectConstraintViolation(
      testDb()
        .insert(tool_operation)
        .values({
          id: 'toolop_direct_error_oversized',
          tool_name: 'direct_writer',
          effect: 'read',
          status: 'failed',
          process_id: 'api_boot_direct',
          input_json: {},
          error_json: { code: 'direct_failure', message: 'x'.repeat(4_001) },
          started_at: now,
          owner_heartbeat_at: now,
          lease_expires_at: new Date(now.getTime() + 30_000),
          settled_at: now,
          updated_at: now,
        }),
      'tool_operation_error_bounds_ck',
    );
  });

  it('marks previous-process reads lost with no risk and writes lost with possible risk', async () => {
    let clock = new Date('2026-08-27T12:00:00Z');
    const oldOperations = createToolOperations(testDb(), {
      processId: 'api_boot_old',
      now: () => clock,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    await oldOperations.start(
      { id: 'toolop_lost_read', toolName: 'remote_lookup', effect: 'read', input: { q: 'x' } },
      async () => new Promise<never>(() => undefined),
    );
    await oldOperations.start(
      {
        id: 'toolop_lost_write',
        toolName: 'remote_propose',
        effect: 'propose',
        input: { title: 'A durable proposal whose remote acknowledgement never returned' },
      },
      async () => new Promise<never>(() => undefined),
    );

    clock = new Date(clock.getTime() + 1_001);
    const currentOperations = createToolOperations(testDb(), {
      processId: 'api_boot_new',
      now: () => clock,
    });
    const recovered = await currentOperations.recoverLost();
    expect(recovered).toEqual([
      expect.objectContaining({ id: 'toolop_lost_read', status: 'lost', sideEffectRisk: 'none' }),
      expect.objectContaining({
        id: 'toolop_lost_write',
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);

    const rows = await testDb()
      .select({ id: tool_operation.id, status: tool_operation.status })
      .from(tool_operation);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'toolop_lost_read', status: 'lost' },
        { id: 'toolop_lost_write', status: 'lost' },
      ]),
    );
  });
});
