import { describe, expect, it } from 'vitest';

import { createDefaultRegistry, getDefaultRegistry } from '@/core/capability/judges';
import { CapabilityRegistry } from '@/core/capability/registry';
import { fsrsSchedulerCapability } from './fsrs';

describe('CapabilityRegistry scheduler half (T-QP)', () => {
  it('registers / resolves / lists schedulers', () => {
    const registry = new CapabilityRegistry();
    expect(registry.hasScheduler('fsrs')).toBe(false);
    registry.registerScheduler(fsrsSchedulerCapability);
    expect(registry.hasScheduler('fsrs')).toBe(true);
    expect(registry.resolveScheduler('fsrs')).toBe(fsrsSchedulerCapability);
    expect(registry.listSchedulers().map((m) => m.id)).toEqual(['fsrs']);
  });

  it('rejects a duplicate scheduler id', () => {
    const registry = new CapabilityRegistry();
    registry.registerScheduler(fsrsSchedulerCapability);
    expect(() => registry.registerScheduler(fsrsSchedulerCapability)).toThrow(/already registered/);
  });

  it('does not conflate judges and schedulers', () => {
    const registry = new CapabilityRegistry();
    registry.registerScheduler(fsrsSchedulerCapability);
    expect(registry.hasJudge('fsrs')).toBe(false);
    expect(registry.resolveJudge('fsrs')).toBeUndefined();
  });

  it('the default registry has the fsrs scheduler', () => {
    const registry = createDefaultRegistry();
    expect(registry.hasScheduler('fsrs')).toBe(true);
    expect(getDefaultRegistry().hasScheduler('fsrs')).toBe(true);
  });
});
