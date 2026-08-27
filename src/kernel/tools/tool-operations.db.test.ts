import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, tool_operation } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createToolOperations } from './tool-operations';

describe('ToolOperations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('starts with a handle, polls with timeoutMs=0, and settles a realistic result', async () => {
    let resolveExecution!: (value: {
      result: Record<string, unknown>;
      terminalToolCallLogId: string;
    }) => void;
    const execution = new Promise<{
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
      async () => {
        throw new Error('upstream returned 503 after retries');
      },
    );

    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'execution_failed', message: 'upstream returned 503 after retries' },
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
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              observedAbort = true;
              reject(signal.reason);
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
    const oldOperations = createToolOperations(testDb(), { processId: 'api_boot_uncertain_old' });
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

    const newOperations = createToolOperations(testDb(), { processId: 'api_boot_uncertain_new' });
    await expect(newOperations.recoverLost()).resolves.toEqual([
      expect.objectContaining({
        id: handle.id,
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);
  });

  it('marks previous-process reads lost with no risk and writes lost with possible risk', async () => {
    const oldOperations = createToolOperations(testDb(), { processId: 'api_boot_old' });
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

    const currentOperations = createToolOperations(testDb(), { processId: 'api_boot_new' });
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
