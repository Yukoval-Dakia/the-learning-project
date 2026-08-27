import { describe, expect, it, vi } from 'vitest';
import { KnownEvent } from '@/core/schema/event/known';
import {
  InvalidToolOperationTransitionError,
  MAX_TOOL_OPERATION_ERROR_MESSAGE_CHARS,
  MAX_TOOL_OPERATION_JSON_BYTES,
  getToolOperationProcessId,
  recoverToolOperationsOnBoot,
  scheduleToolOperationHardDeadline,
  summarizeToolOperationError,
  toolOperationDeadlineSettlement,
  transitionToolOperation,
  validateToolOperationJson,
} from './tool-operations';

describe('ToolOperations lifecycle contract', () => {
  it('keeps one bounded process tag across module reloads', async () => {
    const first = getToolOperationProcessId();
    vi.resetModules();
    const reloaded = await import('./tool-operations');

    expect(reloaded.getToolOperationProcessId()).toBe(first);
    expect(first).toMatch(/^toolops_[0-9]+_[0-9a-f-]{36}$/);
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it('logs boot recovery failure honestly without failing startup', async () => {
    const failure = new Error('database unavailable during boot sweep');
    const db = { transaction: vi.fn(async () => Promise.reject(failure)) } as never;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(recoverToolOperationsOnBoot(db)).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[tool-operations] boot recovery failed (non-fatal)',
      failure,
    );
    errorSpy.mockRestore();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'lost'] as const)(
    'allows running -> %s exactly once',
    (terminalState) => {
      expect(transitionToolOperation('running', terminalState)).toBe(terminalState);
      expect(() => transitionToolOperation(terminalState, 'failed')).toThrow(
        InvalidToolOperationTransitionError,
      );
    },
  );

  it('rejects transitions back to running', () => {
    expect(() => transitionToolOperation('running', 'running')).toThrow(
      InvalidToolOperationTransitionError,
    );
  });

  it('accepts replayable yielded and settled KnownEvents', () => {
    expect(
      KnownEvent.safeParse({
        actor_kind: 'system',
        actor_ref: 'tool_operations',
        action: 'tool_operation_yielded',
        subject_kind: 'tool_operation',
        subject_id: 'toolop_long_read',
        outcome: null,
        payload: {
          tool_name: 'search_notes',
          effect: 'read',
          process_id: 'api_boot_42',
        },
      }).success,
    ).toBe(true);

    expect(
      KnownEvent.safeParse({
        actor_kind: 'system',
        actor_ref: 'tool_operations',
        action: 'tool_operation_settled',
        subject_kind: 'tool_operation',
        subject_id: 'toolop_long_read',
        outcome: 'failure',
        payload: {
          state: 'lost',
          side_effect_risk: 'none',
          error: { code: 'process_restarted', message: 'Owning process exited before settlement' },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects terminal events that hide uncertainty or contradict their outcome', () => {
    const invalidLost = {
      actor_kind: 'system',
      actor_ref: 'tool_operations',
      action: 'tool_operation_settled',
      subject_kind: 'tool_operation',
      subject_id: 'toolop_uncertain_write',
      outcome: 'success',
      payload: {
        state: 'lost',
        error: { code: 'process_restarted', message: 'No remote acknowledgement' },
      },
    };

    expect(KnownEvent.safeParse(invalidLost).success).toBe(false);
  });

  it.each([
    ['read', 'failed', null],
    ['propose', 'lost', 'possible'],
    ['write', 'lost', 'possible'],
  ] as const)(
    'maps a %s hard deadline to %s without overstating certainty',
    (effect, state, risk) => {
      expect(toolOperationDeadlineSettlement(effect)).toMatchObject({
        state,
        sideEffectRisk: risk,
        error: { code: 'hard_deadline_exceeded' },
      });
    },
  );

  it('rejects oversized semantic JSON instead of truncating it', () => {
    expect(() => validateToolOperationJson({ text: 'x'.repeat(512) }, 1024, 'input')).not.toThrow();
    expect(() =>
      validateToolOperationJson(
        { text: 'x'.repeat(MAX_TOOL_OPERATION_JSON_BYTES) },
        undefined,
        'input',
      ),
    ).toThrow('input exceeds');
  });

  it('bounds diagnostic error summaries with an explicit truncation marker', () => {
    const summarized = summarizeToolOperationError({
      code: 'REMOTE_TRANSPORT_AMBIGUITY'.repeat(20),
      message: '远程写入可能已提交。'.repeat(MAX_TOOL_OPERATION_ERROR_MESSAGE_CHARS),
    });
    expect(summarized.code.length).toBeLessThanOrEqual(100);
    expect(summarized.message.length).toBeLessThanOrEqual(MAX_TOOL_OPERATION_ERROR_MESSAGE_CHARS);
    expect(summarized.message.endsWith('…[truncated]')).toBe(true);
    expect(
      KnownEvent.safeParse({
        actor_kind: 'system',
        actor_ref: 'tool_operations',
        action: 'tool_operation_settled',
        subject_kind: 'tool_operation',
        subject_id: 'toolop_bounded_event',
        outcome: 'failure',
        payload: {
          state: 'failed',
          error: { code: 'too_long', message: 'x'.repeat(4_001) },
        },
      }).success,
    ).toBe(false);
  });

  it('fires and cancels hard-deadline timers without leaving timer handles', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-27T12:00:00Z') });
    try {
      const onExpire = vi.fn();
      scheduleToolOperationHardDeadline({
        effect: 'write',
        deadlineAt: new Date(Date.now() + 1_000),
        now: () => new Date(Date.now()),
        onExpire,
      });
      const cancelled = scheduleToolOperationHardDeadline({
        effect: 'read',
        deadlineAt: new Date(Date.now() + 2_000),
        now: () => new Date(Date.now()),
        onExpire,
      });
      expect(vi.getTimerCount()).toBe(2);
      cancelled.cancel();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onExpire).toHaveBeenCalledOnce();
      expect(onExpire).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'lost', sideEffectRisk: 'possible' }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
