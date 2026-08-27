import { describe, expect, it } from 'vitest';
import { KnownEvent } from '@/core/schema/event/known';
import { InvalidToolOperationTransitionError, transitionToolOperation } from './tool-operations';

describe('ToolOperations lifecycle contract', () => {
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
});
