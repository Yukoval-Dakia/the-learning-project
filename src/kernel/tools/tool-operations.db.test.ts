import { beforeEach, describe, expect, it } from 'vitest';
import { tool_operation } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createToolOperations, recoverToolOperationsOnBoot } from './tool-operations';

describe('ToolOperations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('links one terminal tool-call log only after durable settlement', async () => {
    let resolveExecution!: (value: {
      status: 'succeeded';
      result: Record<string, unknown>;
    }) => void;
    const execution = new Promise<{
      status: 'succeeded';
      result: Record<string, unknown>;
    }>((resolve) => {
      resolveExecution = resolve;
    });
    const operations = createToolOperations(testDb(), { processId: 'api_boot_terminal_link' });
    const handle = await operations.start(
      {
        id: 'toolop_terminal_link',
        sessionId: 'session_terminal_link',
        taskRunId: 'task_terminal_link',
        toolName: 'remote_lookup',
        effect: 'read',
        input: { query: 'nested lookup', filters: { includeArchived: false } },
      },
      async () => execution,
    );

    await expect(
      operations.linkTerminalToolCallLog(handle.id, 'tool_log_before_settlement'),
    ).rejects.toThrow('has not settled');
    resolveExecution({ status: 'succeeded', result: { records: [{ id: 'record_1' }] } });
    await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
      status: 'succeeded',
      terminalToolCallLogId: null,
    });
    await expect(
      operations.linkTerminalToolCallLog(handle.id, 'tool_log_after_settlement'),
    ).resolves.toMatchObject({
      status: 'succeeded',
      terminalToolCallLogId: 'tool_log_after_settlement',
    });
    await expect(
      operations.linkTerminalToolCallLog(handle.id, 'tool_log_conflict'),
    ).rejects.toThrow('already links another terminal tool call log');
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
      await expect(handle.wait({ timeoutMs: 5_000 })).resolves.toMatchObject({
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

  it.each([
    ['read', 'failed', null],
    ['write', 'lost', 'possible'],
  ] as const)(
    'recovers a %s deadline after restart before its still-live lease expires',
    async (effect, status, risk) => {
      let clock = new Date('2026-08-27T12:00:00Z');
      const owner = createToolOperations(testDb(), {
        processId: `api_boot_deadline_restart_${effect}`,
        now: () => clock,
      });
      await owner.start(
        {
          id: `toolop_deadline_restart_${effect}`,
          toolName: `remote_${effect}`,
          effect,
          input: { request: { dispatched: true } },
          hardDeadlineAt: new Date(clock.getTime() + 1_000),
        },
        async () => new Promise<never>(() => undefined),
      );

      clock = new Date(clock.getTime() + 1_001);
      const recovering = createToolOperations(testDb(), {
        processId: 'api_boot_after_restart',
        now: () => clock,
      });
      await expect(recovering.recoverLost()).resolves.toEqual([
        expect.objectContaining({
          id: `toolop_deadline_restart_${effect}`,
          status,
          sideEffectRisk: risk,
          error: expect.objectContaining({ code: 'hard_deadline_exceeded' }),
        }),
      ]);
    },
  );

  it('keeps owner-lease semantics when the lease expired before the hard deadline', async () => {
    let clock = new Date('2026-08-27T12:00:00Z');
    const owner = createToolOperations(testDb(), {
      processId: 'api_boot_lease_first',
      now: () => clock,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    await owner.start(
      {
        id: 'toolop_lease_before_deadline',
        toolName: 'remote_write',
        effect: 'write',
        input: { request: { dispatched: true } },
        hardDeadlineAt: new Date(clock.getTime() + 2_000),
      },
      async () => new Promise<never>(() => undefined),
    );

    clock = new Date(clock.getTime() + 2_001);
    const recovering = createToolOperations(testDb(), {
      processId: 'api_boot_after_lease',
      now: () => clock,
    });
    await expect(recovering.recoverLost()).resolves.toEqual([
      expect.objectContaining({
        id: 'toolop_lease_before_deadline',
        status: 'lost',
        sideEffectRisk: 'possible',
        error: expect.objectContaining({ code: 'owner_lease_expired' }),
      }),
    ]);
  });

  it.each([
    ['read', 'failed', null],
    ['write', 'lost', 'possible'],
  ] as const)(
    'coerces a late successful %s executor outcome to its persisted deadline terminal',
    async (effect, status, risk) => {
      let clock = new Date('2026-08-27T12:00:00Z');
      let finish!: (outcome: { status: 'succeeded'; result: { late: boolean } }) => void;
      const execution = new Promise<{ status: 'succeeded'; result: { late: boolean } }>(
        (resolve) => {
          finish = resolve;
        },
      );
      const operations = createToolOperations(testDb(), {
        processId: `api_boot_late_success_${effect}`,
        now: () => clock,
      });
      const handle = await operations.start(
        {
          id: `toolop_late_success_${effect}`,
          toolName: `remote_${effect}`,
          effect,
          input: { request: { dispatched: true } },
          hardDeadlineAt: new Date(clock.getTime() + 10_000),
        },
        async () => execution,
      );

      clock = new Date(clock.getTime() + 10_000);
      finish({ status: 'succeeded', result: { late: true } });
      await expect(handle.wait({ timeoutMs: 250 })).resolves.toMatchObject({
        status,
        result: null,
        sideEffectRisk: risk,
        error: expect.objectContaining({ code: 'hard_deadline_exceeded' }),
      });
    },
  );

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

  it('recovers expired operations through the real boot sweep seam', async () => {
    const oldOperations = createToolOperations(testDb(), {
      processId: 'api_boot_before_restart',
      now: () => new Date('2020-01-01T00:00:00Z'),
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    await oldOperations.start(
      {
        id: 'toolop_boot_sweep_expired',
        toolName: 'remote_write',
        effect: 'write',
        input: { mutation: { title: 'may have reached the remote system' } },
      },
      async () => new Promise<never>(() => undefined),
    );

    await expect(recoverToolOperationsOnBoot(testDb())).resolves.toEqual([
      expect.objectContaining({
        id: 'toolop_boot_sweep_expired',
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);
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
