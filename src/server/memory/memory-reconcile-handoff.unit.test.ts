import { describe, expect, it } from 'vitest';
import {
  memoryReconcileHandoffMode,
  memoryReconcileJobId,
  modePersistsNewIntents,
  modeRunsRecovery,
} from './memory-reconcile-handoff';
import { normalizeReconcileInputs } from './memory-reconcile-handoff-store';

const memories = [
  { id: 'b', text: 'second', created_ms: 2, kind: 'event' },
  { id: 'a', text: 'first', created_ms: 1, kind: 'preference' },
];

describe('memory reconcile handoff', () => {
  it('implements the strict observe/write/recover/drain rollout matrix', () => {
    expect(memoryReconcileHandoffMode(undefined)).toBe('observe');
    expect(['observe', 'write', 'recover', 'drain'].map(memoryReconcileHandoffMode)).toEqual([
      'observe',
      'write',
      'recover',
      'drain',
    ]);
    expect(
      ['observe', 'write', 'recover', 'drain'].map((mode) =>
        modePersistsNewIntents(memoryReconcileHandoffMode(mode)),
      ),
    ).toEqual([false, true, true, false]);
    expect(
      ['observe', 'write', 'recover', 'drain'].map((mode) =>
        modeRunsRecovery(memoryReconcileHandoffMode(mode)),
      ),
    ).toEqual([false, false, true, true]);
    expect(() => memoryReconcileHandoffMode('enabled')).toThrow(
      /invalid MEMORY_RECONCILE_HANDOFF_MODE/,
    );
  });

  it('dedupes identical ids, rejects conflicting duplicates, and derives an order-independent job id', () => {
    expect(normalizeReconcileInputs([memories[0], memories[0]])).toEqual([memories[0]]);
    expect(() =>
      normalizeReconcileInputs([memories[0], { ...memories[0], text: 'conflict' }]),
    ).toThrow(/conflicting duplicate/);
    expect(memoryReconcileJobId('event-1', memories)).toBe(
      memoryReconcileJobId('event-1', [...memories].reverse()),
    );
  });
});
